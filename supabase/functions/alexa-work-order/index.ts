// Turns one spoken sentence from the shop Alexa into a staff ticket.
//
// The Alexa skill (alexa/skill.js) posts here with a shared password in the
// x-alexa-secret header. This function is the only thing that holds a
// database key, and all it can do is add a "new" ticket -- so a leaked
// password lets someone add tickets, which the public anon key already
// allows. It never reads, updates or deletes anything.
//
// With ANTHROPIC_API_KEY set, Claude turns the sentence into a proper ticket
// (short title, details, category, priority, location, due date, customer).
// Without it, or if Claude is slow or fails, the sentence becomes the title
// as before -- a work order is never lost to the AI step.
//
// Deploy with "Enforce JWT verification" OFF: Alexa has no Supabase login,
// the password is the check. Secrets: ALEXA_SHARED_SECRET (set by hand),
// ANTHROPIC_API_KEY (optional, set by hand); SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Plain JavaScript on purpose, so it pastes into the dashboard editor as-is
// and the tests can load it under Node.

const MAX_TITLE = 200;

// "valley" / "south side" anywhere in the sentence sets the location;
// otherwise the skill's default (the building the Echo sits in) is used.
function pickLocation(text, fallback) {
  const t = text.toLowerCase();
  const valley = /\bvalley\b/.test(t);
  const south = /\bsouth\s*side\b/.test(t);
  if (valley && south) return "Both";
  if (valley) return "Valley";
  if (south) return "South Side";
  return ["Valley", "South Side", "Both"].includes(fallback) ? fallback : null;
}

function ticketFromSpeech(body, now) {
  let text = String((body && body.text) || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Nothing was said.");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const title = text.length > MAX_TITLE ? text.slice(0, MAX_TITLE - 1) + "…" : text;

  return {
    submitted_by: "Alexa",
    submitted_at: now.toISOString(),
    location: pickLocation(text, body.location),
    title,
    details: text.length > MAX_TITLE ? text : null,
    priority: "normal",
    status: "new",
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const CATEGORIES = ["Equipment", "Building", "Supplies", "Customer", "Computer", "Other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const LOCATIONS = ["Valley", "South Side", "Both", "Not said"];

// Strict schema: every field always present, "" when the speaker didn't say.
const TICKET_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "One-line summary, at most 80 characters, sentence case." },
    details: { type: "string", description: "Anything useful beyond the title, or empty." },
    category: { type: "string", enum: CATEGORIES },
    priority: { type: "string", enum: PRIORITIES },
    location: { type: "string", enum: LOCATIONS },
    due_date: { type: "string", description: "YYYY-MM-DD if a date or deadline was said, else empty." },
    customer_name: { type: "string", description: "Customer's name if one was said, else empty." },
    customer_phone: { type: "string", description: "Customer's phone if one was said, else empty." },
  },
  required: ["title", "details", "category", "priority", "location", "due_date", "customer_name", "customer_phone"],
  additionalProperties: false,
};

function ticketPrompt(now) {
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  return `You turn a work order spoken to the shop's voice assistant into a staff ticket for a bowling pro shop with two locations, Valley and South Side. Keith reviews new tickets and hands them out, so make it easy to act on at a glance.

The text is a speech transcript: fix obvious mishearings (bowling terms like grips, inserts, plugs, drill, resurfacing, ball return, lanes, pinsetter) but never invent facts. Keep the speaker's meaning.

- title: what needs doing, short, no filler like "work order for".
- details: extra specifics the title leaves out (which lane, what's wrong, who asked). Empty if none.
- category: Equipment (machines, lanes, drill, pinsetters), Building, Supplies (running low, reorder), Customer (a customer's ball, order or request), Computer, or Other.
- priority: urgent only for safety or something stopping business now; high if it should be done today; low if it can wait; otherwise normal.
- location: only if the speaker named one.
- due_date: today is ${weekday} ${today}; resolve "tomorrow", "Friday", "by the weekend" to a date.
- customer_name / customer_phone: only if said.`;
}

async function aiTicket(text, now, claude) {
  const response = await claude.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: TICKET_SCHEMA } },
    // On a safety decline, rerun on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: ticketPrompt(now),
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined");
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("Claude returned no ticket");
  return JSON.parse(block.text);
}

// Lay Claude's fields over the plain ticket, keeping the plain value wherever
// Claude's is missing or not one the tickets table accepts.
function mergeAi(row, ai, spoken) {
  const pick = (v, ok) => (typeof v === "string" && ok(v.trim()) ? v.trim() : null);
  const title = pick(ai.title, (v) => v.length > 0);
  const contact = [pick(ai.customer_name, Boolean) && `Customer: ${ai.customer_name.trim()}`,
                   pick(ai.customer_phone, Boolean) && `Phone: ${ai.customer_phone.trim()}`].filter(Boolean).join("\n");
  const details = [contact, pick(ai.details, Boolean), `Said: "${spoken}"`].filter(Boolean).join("\n\n");
  return {
    ...row,
    title: title ? title.slice(0, MAX_TITLE) : row.title,
    details,
    category: pick(ai.category, (v) => CATEGORIES.includes(v)) || row.category || null,
    priority: pick(ai.priority, (v) => PRIORITIES.includes(v)) || row.priority,
    location: pick(ai.location, (v) => ["Valley", "South Side", "Both"].includes(v)) || row.location,
    due_date: pick(ai.due_date, (v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) || null,
  };
}

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

  let row, spoken;
  const now = new Date();
  try {
    const body = await req.json();
    row = ticketFromSpeech(body, now);
    spoken = String(body.text).replace(/\s+/g, " ").trim();
  } catch (err) {
    return reply(400, { error: err.message });
  }

  let ai = false;
  if (claude) {
    try {
      row = mergeAi(row, await aiTicket(spoken, now, claude), spoken);
      ai = true;
    } catch (err) {
      console.log("AI step skipped:", err && err.message);
    }
  }

  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/tickets`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) return reply(502, { error: `Database said ${res.status}: ${await res.text()}` });

  const [created] = await res.json();
  return reply(200, { id: created && created.id, title: row.title, location: row.location, ai });
}

if (typeof Deno !== "undefined") {
  let claude;
  const getClaude = async (env) => {
    if (claude === undefined) {
      claude = null;
      if (env.ANTHROPIC_API_KEY) {
        const { default: Anthropic } = await import("npm:@anthropic-ai/sdk");
        // Alexa gives a skill about 8 seconds in total; past 5 the plain ticket wins.
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
