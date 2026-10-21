// Turns a spoken work order into a staff ticket, as a short conversation.
//
//   "work order"                        -> "Who's it for, and what are we doing?"
//   "Doug Smith"                        -> "What are we doing for Doug Smith?"
//   "plug his 14 pound ball"            -> "Work order added for Doug Smith: Plug 14 lb ball."
//
// or all at once: "for Doug Smith to plug his 14 pound ball". The customer's
// phone number is looked up in the customer list (directory, orders,
// appointments) so nobody has to say it.
//
// Callers (alexa/skill.js, the Siri Shortcut in alexa/README.md) post
// { text, state?, location? } with a shared password in the x-alexa-secret
// header, speak back `say`, and if `done` is false listen again and post the
// answer with the `state` they were given. This function is the only thing
// that holds a database key; it reads customer names and phones, and adds
// "new" tickets. It never updates or deletes anything.
//
// With ANTHROPIC_API_KEY set, Claude reads each answer (who, what, and a tidy
// title, category, priority, due date). Without it, or if Claude is slow or
// fails, simple rules take over: "for NAME to WORK", or the answer to the
// question just asked -- a work order is never lost to the AI step.
//
// Deploy with "Enforce JWT verification" OFF: Alexa has no Supabase login,
// the password is the check. Secrets: ALEXA_SHARED_SECRET (set by hand),
// ANTHROPIC_API_KEY (optional, set by hand); SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. After changing a
// secret, deploy again so the running function picks it up.
//
// Plain JavaScript on purpose, so it pastes into the dashboard editor as-is
// and the tests can load it under Node.

const MAX_TITLE = 200;
const MAX_TURNS = 5;

const CATEGORIES = ["Equipment", "Building", "Supplies", "Customer", "Computer", "Other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const PLACES = ["Valley", "South Side", "Both"];

const squash = (v) => String(v || "").replace(/\s+/g, " ").trim();
const capital = (v) => v.charAt(0).toUpperCase() + v.slice(1);
const titleCase = (v) => v.replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

// "valley" / "south side" anywhere in the words sets the location;
// otherwise the caller's default (the building the device sits in) is used.
function pickLocation(text, fallback) {
  const t = text.toLowerCase();
  const valley = /\bvalley\b/.test(t);
  const south = /\bsouth\s*side\b/.test(t);
  if (valley && south) return "Both";
  if (valley) return "Valley";
  if (south) return "South Side";
  return PLACES.includes(fallback) ? fallback : null;
}

// ---------------------------------------------------------------------------
// Conversation state: what we know so far, round-tripped through the caller
// ---------------------------------------------------------------------------

function blankState() {
  return { name: "", spokenName: "", phone: "", lookedUp: false, shop: false, work: "", heard: [], asked: "", turns: 0, ai: null };
}

function readState(raw) {
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === "object") return { ...blankState(), ...s };
  } catch { /* first turn, or junk -- start over */ }
  return blankState();
}

// Without Claude: "for Doug Smith to plug his ball", "for Doug Smith", or a
// plain answer to whatever was just asked.
function ruleParse(text, asked) {
  const t = text.replace(/^(please\s+)?(create|make|start|add|open)?\s*(a\s+)?(new\s+)?(work\s*order|ticket)\s*/i, "");
  const m = /^for\s+(.+?)(?:\s+(?:to|that|who|because)\s+(.+))?$/i.exec(t);
  if (m) return { name: m[1], work: m[2] || "" };
  if (asked === "name") return { name: t, work: "" };
  // "Doug Smith, plug his ball" -- only when the speaker paused for a comma.
  const pair = /^([^,]+),\s*(.+)$/.exec(t);
  if (asked === "both" && pair) return { name: pair[1], work: pair[2] };
  return { name: "", work: t };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

// Strict schema: every field always present, "" when not (yet) said.
const TURN_SCHEMA = {
  type: "object",
  properties: {
    customer_name: { type: "string", description: "Customer's full name as said, title case, or empty." },
    customer_phone: { type: "string", description: "Phone number if one was said, digits only, or empty." },
    for_shop: { type: "boolean", description: "True if the job is for the shop itself, not a customer." },
    work: { type: "string", description: "What needs doing, in the speaker's words, or empty if not said yet." },
    title: { type: "string", description: "One-line ticket title, at most 80 characters, sentence case, or empty." },
    details: { type: "string", description: "Specifics the title leaves out, or empty." },
    category: { type: "string", enum: CATEGORIES },
    priority: { type: "string", enum: PRIORITIES },
    due_date: { type: "string", description: "YYYY-MM-DD if a date or deadline was said, else empty." },
  },
  required: ["customer_name", "customer_phone", "for_shop", "work", "title", "details", "category", "priority", "due_date"],
  additionalProperties: false,
};

function turnPrompt(now) {
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  return `You read a work order being spoken to a bowling pro shop's voice assistant and fill in a staff ticket. A work order has three parts: who it's for (a customer's name), an optional phone number, and what we're doing. The words may arrive in pieces across a short conversation; you get everything said so far and what was asked last, and you return the whole ticket as it now stands.

The text is a speech transcript: fix obvious mishearings (bowling terms like plug, redrill, grips, inserts, thumb slug, resurface, oil, pound ball) but never invent facts.

- customer_name: the person the work is for. "for Doug Smith to plug his ball" -> "Doug Smith". An answer to "Who's it for?" is the name. Empty if not said.
- for_shop: true only if the job is for the shop itself (machines, lanes, building, supplies) or the speaker says it's for no one / the shop.
- work: what we're doing, empty if not said yet. An answer to "What are we doing?" is the work.
- title: short and specific once the work is known, e.g. "Plug and redrill 14 lb ball". No customer name, no filler.
- category: Customer for a customer's job; otherwise Equipment, Building, Supplies, Computer, or Other.
- priority: urgent only for safety or something stopping business now; high if needed today or for tonight's league; low if it can wait; otherwise normal.
- due_date: today is ${weekday} ${today}; resolve "tomorrow", "Friday", "by the weekend" to a date.`;
}

async function aiTurn(state, text, now, claude) {
  const said = [...state.heard, text].map((t, i) => `${i + 1}. ${t}`).join("\n");
  const asked = state.asked === "name" ? "Who's it for?" : state.asked === "work" ? "What are we doing?" : "(nothing yet)";
  const response = await claude.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: TURN_SCHEMA } },
    // On a safety decline, rerun on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: turnPrompt(now),
    messages: [{ role: "user", content: `Last question asked: ${asked}\n\nSaid so far:\n${said}` }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined");
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("Claude returned no ticket");
  return JSON.parse(block.text);
}

// ---------------------------------------------------------------------------
// Customer lookup
// ---------------------------------------------------------------------------

const nameKey = (v) => squash(v).toLowerCase().replace(/[^a-z' -]/g, "");
const digits = (v) => String(v || "").replace(/\D/g, "");

function formatPhone(v) {
  const d = digits(v).replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : squash(v);
}

// Best match for a spoken name among { customer_name, phone } rows: the exact
// name first, else same last name with a first name that starts the same way
// ("Doug" / "Douglas"). One phone among the best -> use it; several -> say so.
function matchCustomer(spoken, rows) {
  const want = nameKey(spoken).split(" ").filter(Boolean);
  if (want.length === 0) return { found: 0 };
  const score = (name) => {
    const have = nameKey(name).split(" ").filter(Boolean);
    if (have.join(" ") === want.join(" ")) return 2;
    if (want.length > 1 && have.length > 1 && have[have.length - 1] === want[want.length - 1]) {
      const a = have[0], b = want[0];
      if (a.startsWith(b) || b.startsWith(a)) return 1;
    }
    return 0;
  };
  let best = 0;
  const byPhone = new Map();
  for (const row of rows) {
    const s = score(row.customer_name);
    const phone = digits(row.phone);
    if (!s || phone.length < 7) continue;
    if (s > best) { best = s; byPhone.clear(); }
    if (s === best && !byPhone.has(phone)) byPhone.set(phone, row);
  }
  if (byPhone.size === 1) {
    const [row] = byPhone.values();
    return { found: 1, name: squash(row.customer_name), phone: formatPhone(row.phone) };
  }
  return { found: byPhone.size };
}

async function lookupCustomer(name, env, fetchFn) {
  const words = nameKey(name).split(" ").filter((w) => w.length > 1);
  if (words.length === 0) return { found: 0 };
  const last = encodeURIComponent(`*${words[words.length - 1]}*`);
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const tables = ["customer_directory", "orders", "appointments"];
  const lists = await Promise.all(tables.map(async (table) => {
    try {
      const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/${table}?select=customer_name,phone` +
        `&customer_name=ilike.${last}&phone=not.is.null&deleted_at=is.null&limit=200`, { headers });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  }));
  return matchCustomer(name, lists.flat());
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

function ticketRow(state, location, now) {
  const ai = state.ai || {};
  const ok = (v, test) => (typeof v === "string" && test(v.trim()) ? v.trim() : null);
  let title = ok(ai.title, Boolean) || capital(state.work);
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE - 1) + "…";
  const contact = state.name ? `Customer: ${state.name}\nPhone: ${state.phone}` : "";
  const said = `Said: "${state.heard.join(" / ")}"`;
  return {
    submitted_by: "Alexa",
    submitted_at: now.toISOString(),
    location,
    title,
    details: [contact, ok(ai.details, Boolean), said].filter(Boolean).join("\n\n"),
    category: ok(ai.category, (v) => CATEGORIES.includes(v)) || (state.name ? "Customer" : null),
    priority: ok(ai.priority, (v) => PRIORITIES.includes(v)) || "normal",
    due_date: ok(ai.due_date, (v) => /^\d{4}-\d{2}-\d{2}$/.test(v)),
    status: "new",
  };
}

async function converse(body, env, fetchFn, claude, now) {
  const text = squash(body.text);
  const state = readState(body.state);
  state.turns += 1;
  if (text) state.heard.push(text);

  if (text) {
    let parsed = null;
    if (claude) {
      try {
        const ai = await aiTurn({ ...state, heard: state.heard.slice(0, -1) }, text, now, claude);
        parsed = { name: squash(ai.customer_name), phone: digits(ai.customer_phone), work: squash(ai.work), shop: ai.for_shop === true };
        state.ai = ai;
      } catch (err) {
        console.log("AI step skipped:", err && err.message);
      }
    }
    if (!parsed) parsed = { ...ruleParse(text, state.asked), phone: "", shop: false };
    // Compared with what was said before, not the customer list's spelling.
    if (parsed.name && parsed.name.toLowerCase() !== state.spokenName.toLowerCase()) {
      state.name = state.spokenName = titleCase(parsed.name);
      state.phone = "";
      state.lookedUp = false;
    }
    if (parsed.phone.length >= 7) { state.phone = formatPhone(parsed.phone); state.lookedUp = true; }
    if (parsed.work) state.work = parsed.work;
    if (parsed.shop) state.shop = true;
  }

  let note = "";
  if (state.name && !state.lookedUp) {
    const match = await lookupCustomer(state.name, env, fetchFn);
    state.lookedUp = true;
    if (match.found === 1) { state.name = match.name; state.phone = match.phone; }
    else if (match.found > 1) note = ` I found more than one ${state.name}, so add the phone number in the app.`;
  }

  const giveUp = state.turns >= MAX_TURNS;
  const needName = !state.name && !state.shop;
  if (!state.work || (needName && !giveUp)) {
    if (giveUp) return { done: true, say: "Sorry, I didn't get what the work order is for. Please add it in the app." };
    state.asked = !state.work && needName ? "both" : needName ? "name" : "work";
    const say = state.asked === "both" ? "Who's it for, and what are we doing?"
      : state.asked === "name" ? "Who's it for?"
      : state.name ? `What are we doing for ${state.name}?` : "What are we doing?";
    return { done: false, say: say + note, state: JSON.stringify(state) };
  }

  const location = pickLocation(state.heard.join(" "), body.location);
  return { done: true, row: ticketRow(state, location, now), note };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handle(req, env, fetchFn, claude) {
  const reply = (status, obj) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  if (req.method !== "POST") return reply(405, { error: "POST only" });
  // Trimmed, and stray quotes dropped: both get pasted by hand into web forms.
  const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
  const expected = clean(env.ALEXA_SHARED_SECRET);
  const given = clean(req.headers.get("x-alexa-secret"));
  if (!expected) return reply(500, { error: "ALEXA_SHARED_SECRET is not set" });
  if (!sameSecret(given, expected)) {
    // Lengths only, never the values: enough to spot a paste slip.
    return reply(401, { error: `Wrong password (got ${given.length} characters, expected ${expected.length})` });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Send JSON: { text, state?, location? }" });
  }

  const turn = await converse(body || {}, env, fetchFn, claude, new Date());
  if (!turn.row) return reply(200, turn);

  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/tickets`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(turn.row),
  });
  if (!res.ok) return reply(502, { error: `Database said ${res.status}: ${await res.text()}` });

  const [created] = await res.json();
  const who = turn.row.details.startsWith("Customer: ") ? ` for ${turn.row.details.slice(10).split("\n")[0]}` : "";
  return reply(200, {
    done: true,
    say: `Work order added${who}: ${turn.row.title}.${turn.note}`,
    id: created && created.id,
    title: turn.row.title,
    location: turn.row.location,
  });
}

if (typeof Deno !== "undefined") {
  let claude;
  const getClaude = async (env) => {
    if (claude === undefined) {
      claude = null;
      if (env.ANTHROPIC_API_KEY) {
        const { default: Anthropic } = await import("npm:@anthropic-ai/sdk");
        // Alexa gives a skill about 8 seconds a turn; past 5 the rules take over.
        claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 5000, maxRetries: 0 });
      }
    }
    return claude;
  };
  Deno.serve(async (req) => {
    const env = Deno.env.toObject();
    return handle(req, env, fetch, await getClaude(env));
  });
}
