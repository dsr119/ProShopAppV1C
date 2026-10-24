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
// It also makes draft invoices in Square (needs SQUARE_ACCESS_TOKEN):
//
//   "create an invoice for Doug Smith for a 14 pound Motiv Tag, a standard
//    drill and a slug combo"  -> "Draft invoice in Square for Doug Smith: ..."
//   "create Bill Jones as a new customer and an invoice for a Motiv Tag"
//      -> Bill is looked up in the Speccy spec sheets, added to Square, invoiced.
//
// Spoken item names are matched to the closest item in the Square library
// (Claude picks among the items Square's search finds for each word), after
// the voice_aliases table (migration/add_voice_aliases.sql) turns shop words
// like "standard drill" into the item's real name. Several customers by the
// same name are told apart by the last four digits of their phone. Anything
// not understood or guessed is noted in voice_review
// (migration/add_voice_review.sql) for review. Invoices are only ever drafts:
// staff check and send them from Square, so a mishearing never reaches a
// customer.
//
// The caller (voice/shop_voice.py on the shop laptop) posts
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
// Deploy with "Enforce JWT verification" OFF: the laptop has no Supabase
// login, the password is the check. Secrets: ALEXA_SHARED_SECRET (set by hand),
// ANTHROPIC_API_KEY (optional, set by hand), SQUARE_ACCESS_TOKEN (for
// invoices), SPECCY_URL / SPECCY_KEY (optional overrides); SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. After changing a
// secret, deploy again so the running function picks it up.
//
// Plain JavaScript on purpose, so it pastes into the dashboard editor as-is
// and the tests can load it under Node.

const MAX_TITLE = 200;
const SQUARE_URL = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2026-09-16";
// Speccy (the spec sheet app) is a separate Supabase project. Its URL and
// publishable key are public (they ship in its web page); SPECCY_URL and
// SPECCY_KEY override them.
const SPECCY_URL = "https://bkvijjqhyiyfkuavmerh.supabase.co";
const SPECCY_KEY = "sb_publishable_Vba54XSri6vewRcBO8qDXQ_uinwbMOy";
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
  return { intent: "work_order", name: "", spokenName: "", phone: "", lookedUp: false, shop: false, work: "",
    items: [], heard: [], asked: "", turns: 0, ai: null, options: [], review: [] };
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
  if (/\binvoice\b/i.test(text)) return { intent: /\bnew customer\b/i.test(text) ? "new_customer" : "invoice", name: "", work: "" };
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
    intent: { type: "string", enum: ["work_order", "invoice", "new_customer"],
      description: "work_order unless an invoice was asked for; new_customer if the customer is to be added as new (with an invoice)." },
    items: {
      type: "array",
      description: "Invoice only: each thing to bill, as said (with weight), e.g. '14 lb Motiv Tag', 'standard drill'. Empty for work orders.",
      items: {
        type: "object",
        properties: { spoken: { type: "string" }, quantity: { type: "integer" } },
        required: ["spoken", "quantity"],
        additionalProperties: false,
      },
    },
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
  required: ["intent", "items", "customer_name", "customer_phone", "for_shop", "work", "title", "details", "category", "priority", "due_date"],
  additionalProperties: false,
};

function turnPrompt(now) {
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  return `You read what is spoken to a bowling pro shop's voice assistant. It is either a work order (a staff ticket) or an invoice (a bill in Square, possibly for a new customer).

Invoices: intent "invoice" (or "new_customer" when they say to create or add the person as a new customer). customer_name is who it's for; items lists each thing to bill as said, keeping the weight with a ball ("14 lb Motiv Tag"), quantity 1 unless a number is said. Ball names are brands and models (Storm, Motiv, Roto Grip, Hammer, Brunswick, DV8, Radical, Track, Ebonite, Columbia 300, 900 Global): fix mishearings of those. Leave the work-order fields empty for an invoice. An answer to "What's on the invoice?" is items; to "Who's the invoice for?" is the name.

Work orders: you fill in a staff ticket. A work order has three parts: who it's for (a customer's name), an optional phone number, and what we're doing. The words may arrive in pieces across a short conversation; you get everything said so far and what was asked last, and you return the whole ticket as it now stands.

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
  const asked = { name: "Who's it for?", work: "What are we doing?", both: "Who's it for, and what are we doing?",
    invoice_name: "Who's the invoice for?", items: "What's on the invoice?" }[state.asked] || "(nothing yet)";
  // Haiku: fast and cheap, and picking a name and a job out of a sentence is
  // well within it. A decline (Haiku has no server-side fallback) throws, and
  // the simple rules make the ticket instead.
  const response = await claude.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: TURN_SCHEMA } },
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
  const options = [...byPhone.values()].map((row) => ({ name: squash(row.customer_name), phone: formatPhone(row.phone) }));
  if (options.length === 1) return { found: 1, ...options[0] };
  return { found: options.length, options: options.slice(0, 10) };
}

// Spoken digits: "4521", "45-21", or the odd spelled-out "four five two one"
// (Whisper usually writes numbers as digits).
const DIGIT_WORDS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
function spokenDigits(text) {
  const d = digits(text);
  if (d) return d;
  const ws = String(text || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const nums = ws.map((w) => DIGIT_WORDS[w]).filter((n) => n !== undefined);
  return nums.length >= 4 ? nums.join("") : "";
}

const DONT_KNOW = /\b(don'?t know|do not know|no idea|not sure|skip( it)?|none|no phone)\b/i;

async function lookupCustomer(name, env, fetchFn) {
  const words = nameKey(name).split(" ").filter((w) => w.length > 1);
  if (words.length === 0) return { found: 0 };
  const last = encodeURIComponent(`*${words[words.length - 1]}*`);
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const tables = ["customer_directory", "orders", "appointments"];
  const fromSpeccy = speccyCustomers(words[words.length - 1], env, fetchFn);
  const lists = await Promise.all(tables.map(async (table) => {
    try {
      const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/${table}?select=customer_name,phone` +
        `&customer_name=ilike.${last}&phone=not.is.null&deleted_at=is.null&limit=200`, { headers });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  }));
  return matchCustomer(name, [...lists.flat(), ...await fromSpeccy]);
}

// Customers from Speccy's spec sheets, most recently measured first.
async function speccyCustomers(lastName, env, fetchFn) {
  const key = env.SPECCY_KEY || SPECCY_KEY;
  try {
    const res = await fetchFn(`${env.SPECCY_URL || SPECCY_URL}/rest/v1/customers?select=name,phone` +
      `&name=ilike.${encodeURIComponent(`*${lastName}*`)}&removed_at=is.null&order=last_spec_at.desc.nullslast&limit=50`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = res.ok ? await res.json() : [];
    return rows.map((r) => ({ customer_name: r.name, phone: r.phone }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Square: customers, the item library, draft invoices
// ---------------------------------------------------------------------------

async function square(env, fetchFn, method, path, body) {
  const res = await fetchFn(`${SQUARE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.errors && data.errors[0];
    throw new Error(`Square said ${res.status}${e ? `: ${e.detail || e.code}` : ""}`);
  }
  return data;
}

const idem = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const e164 = (phone) => { const d = digits(phone).replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `+1${d}` : ""; };
const money = (m) => (m && typeof m.amount === "number" ? `$${(m.amount / 100).toFixed(2)}` : "");

// The Square location for the shop the laptop sits in (by name), else the first active one.
function pickSquareLocation(locations, place) {
  const active = (locations || []).filter((l) => l.status !== "INACTIVE");
  const want = (place || "").toLowerCase();
  return (want && active.find((l) => (l.name || "").toLowerCase().includes(want))) || active[0] || null;
}

async function findSquareCustomer(env, fetchFn, name, phone) {
  const d = digits(phone).replace(/^1(?=\d{10}$)/, "");
  if (d.length < 10) return null;
  const data = await square(env, fetchFn, "POST", "/customers/search",
    { query: { filter: { phone_number: { fuzzy: d } } }, limit: 10 });
  const list = data.customers || [];
  const last = nameKey(name).split(" ").pop();
  return list.find((c) => nameKey(c.family_name || "") === last) || list[0] || null;
}

async function createSquareCustomer(env, fetchFn, name, phone) {
  const parts = squash(name).split(" ");
  const data = await square(env, fetchFn, "POST", "/customers", {
    idempotency_key: idem(),
    given_name: parts[0],
    family_name: parts.slice(1).join(" ") || undefined,
    phone_number: e164(phone) || undefined,
    note: "Added by the shop voice assistant",
  });
  return data.customer;
}

// Shop words -> Square item names, from the voice_aliases table. The longest
// alias found in what was said wins ("standard drill" over "drill").
async function loadAliases(env, fetchFn) {
  try {
    const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/voice_aliases?select=spoken,square_item`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

const words = (v) => nameKey(v).replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean);

// What to search Square for: the alias's item name, or the spoken words
// without the weight and filler. Returns { query, weight }.
function itemQuery(spoken, aliases) {
  const said = ` ${words(spoken).join(" ")} `;
  const alias = (aliases || [])
    .filter((a) => a.spoken && said.includes(` ${words(a.spoken).join(" ")} `))
    .sort((a, b) => b.spoken.length - a.spoken.length)[0];
  const w = /\b(\d{1,2})\s*(?:lb|lbs|pound|pounds|pounder)\b/i.exec(spoken);
  const query = alias ? squash(alias.square_item) : squash(spoken
    .replace(/\b\d{1,2}\s*(?:lb|lbs|pound|pounds|pounder)\b/gi, " ")
    .replace(/^\s*(?:an?|the|one|two|three)\s+/i, " "));
  return { query, weight: w ? w[1] : "" };
}

// How alike two words are, 0 to 1 (edit distance), so "tagg" ~ "tag".
function wordLike(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// How well an item name fits what was said, 0 to 2: the share of spoken words
// found (closely) in the name, plus 1 for the exact name. Run-together words
// count too: "iamx pearl" fits "I Am X Pearl".
function itemScore(query, name) {
  const want = words(query), have = words(name);
  if (!want.length || !have.length) return 0;
  const glued = have.join("");
  let total = 0;
  for (const w of want) {
    const best = Math.max(...have.map((h) => wordLike(w, h)));
    total += best >= 0.75 ? best : w.length >= 3 && glued.includes(w) ? 0.9 : 0;
  }
  return total / want.length + (have.join(" ") === want.join(" ") ? 1 : 0);
}

// The variation for a said weight ("14"), else the first. guessed: there was
// a choice and the weight didn't settle it.
function pickVariation(item, weight) {
  const variations = item.item_data.variations || [];
  const byWeight = weight && variations.find((v) => new RegExp(`(^|\\D)${weight}(\\D|$)`).test((v.item_variation_data || {}).name || ""));
  const variation = byWeight || variations[0];
  if (!variation) return null;
  const vName = (variation.item_variation_data || {}).name || "";
  const label = vName && vName.toLowerCase() !== "regular" ? `${item.item_data.name} ${vName}` : item.item_data.name;
  return { id: variation.id, label, item: item.item_data.name, variation: vName, guessed: !byWeight && variations.length > 1 };
}

// Closest item by name; null when nothing is close enough.
function pickItem(items, query, weight) {
  let best = null, bestScore = 0.5;
  for (const item of items || []) {
    const score = itemScore(query, item.item_data && item.item_data.name);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best && pickVariation(best, weight);
}

const FILLER = new Set(["and", "with", "the", "for", "a", "an", "of", "one", "lb", "lbs", "pound", "pounds", "ball", "new"]);

// Square's search only finds names containing the words searched for, so a
// misheard or loosely said name finds nothing. Search for the whole name and
// each word of it, and keep the closest few dozen items as candidates.
async function candidateItems(env, fetchFn, query, spoken) {
  const ws = [...new Set([...words(query), ...words(spoken)])].filter((w) => w.length >= 3 && !FILLER.has(w) && !/^\d+$/.test(w));
  const searches = [...new Set([query, ...ws].filter(Boolean))].slice(0, 6);
  const found = await Promise.all(searches.map((q) =>
    square(env, fetchFn, "POST", "/catalog/search-catalog-items", { text_filter: q, limit: 100 }).then((r) => r.items || [])));
  const byId = new Map();
  for (const item of found.flat()) if (item && item.item_data && !byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()]
    .map((item) => ({ item, score: Math.max(itemScore(query, item.item_data.name), itemScore(spoken, item.item_data.name)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((c) => c.item);
}

const PICK_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "integer", description: "The said item's number." },
          item_id: { type: "string", description: "The id of the closest Square item, or empty if none is plausibly what was meant." },
          sure: { type: "boolean", description: "True if the item is clearly what was said; false if it is a best guess." },
        },
        required: ["line", "item_id", "sure"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

// Claude picks the closest Square item for each said item, from the
// candidates found for it. Returns Map(line -> { item, sure }).
async function aiPickItems(claude, said, candidates) {
  const listing = said.map((s, i) => `${i + 1}. Said: "${s}"\n` + (candidates[i].length
    ? candidates[i].map((it) => `   - id ${it.id}: ${it.item_data.name}`).join("\n") : "   (no candidates)")).join("\n\n");
  const response = await claude.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: PICK_SCHEMA } },
    system: "A bowling pro shop is making an invoice by voice. For each item said, pick the Square item that is closest to what was meant, from that item's candidates. The words are a speech transcript, so expect mishearings and loose names (\"IAMX Pearl\" can be \"I Am X Pearl\", \"standard drilling with grips\" can be \"Drilling - Standard w/ Grips\"). Ignore the ball weight; it picks the variation later. Leave item_id empty if no candidate is plausibly what was meant.",
    messages: [{ role: "user", content: listing }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined");
  const block = response.content.find((b) => b.type === "text");
  const picks = new Map();
  for (const p of (block ? JSON.parse(block.text).picks : []) || []) {
    const item = (candidates[p.line - 1] || []).find((it) => it.id === p.item_id);
    if (item) picks.set(p.line - 1, { item, sure: p.sure === true });
  }
  return picks;
}

// Each said item -> { spoken, pick, close } where close means the name was
// a near match rather than the item's own name.
async function matchItems(state, env, fetchFn, claude) {
  const aliases = await loadAliases(env, fetchFn);
  const said = state.items.map((it) => ({ ...it, ...itemQuery(it.spoken, aliases) }));
  const candidates = await Promise.all(said.map((s) => (s.query ? candidateItems(env, fetchFn, s.query, s.spoken) : [])));
  let picks = null;
  if (claude && candidates.some((c) => c.length)) {
    try {
      picks = await aiPickItems(claude, said.map((s) => s.spoken), candidates);
    } catch (err) {
      console.log("AI item pick skipped:", err && err.message);
    }
  }
  return said.map((s, i) => {
    let pick = null, close = false;
    if (picks) {
      const p = picks.get(i);
      if (p) {
        pick = pickVariation(p.item, s.weight);
        close = !p.sure;
      }
    } else {
      pick = pickItem(candidates[i], s.query, s.weight);
      close = pick && itemScore(s.query, pick.item) < 1;
    }
    return { ...s, pick, close: Boolean(pick && close) };
  });
}

// Returns { say, review }: what to speak, and anything worth Doug's review.
async function makeInvoice(state, place, env, fetchFn, claude) {
  const review = [];
  if (!env.SQUARE_ACCESS_TOKEN) return { say: "Square isn't connected yet, so I couldn't make that invoice.", review: ["Square isn't connected"] };
  const { locations } = await square(env, fetchFn, "GET", "/locations");
  const location = pickSquareLocation(locations, place);
  if (!location) return { say: "I couldn't find a Square location for the invoice.", review: ["No Square location"] };

  let customer = await findSquareCustomer(env, fetchFn, state.name, state.phone);
  let added = "";
  if (!customer && state.intent === "new_customer") {
    customer = await createSquareCustomer(env, fetchFn, state.name, state.phone);
    added = ` I added ${state.name} to Square${state.phone ? "" : " without a phone number"}.`;
  } else if (!customer) {
    review.push(state.phone ? `${state.name} (${state.phone}) isn't in Square` : `No phone number for ${state.name}`);
    return { review, say: state.phone
      ? `${state.name} isn't in Square yet. Say "create ${state.name} as a new customer" with the invoice to add them.`
      : `I couldn't find a phone number for ${state.name}, so I couldn't find them in Square.` };
  } else if (state.intent === "new_customer") {
    added = ` ${state.name} was already in Square, so I used that customer.`;
  }

  const matched = await matchItems(state, env, fetchFn, claude);
  const lines = [], missing = [], notes = [];
  for (const m of matched) {
    const pick = m.pick;
    if (!pick) { missing.push(m.spoken); review.push(`Not found in Square: "${m.spoken}"`); continue; }
    lines.push({ catalog_object_id: pick.id, quantity: String(Math.max(1, m.quantity || 1)), label: pick.label });
    if (m.close) {
      notes.push(`I used ${pick.item} for "${squash(m.spoken.replace(/\b\d{1,2}\s*(?:lb|lbs|pound|pounds|pounder)\b/gi, ""))}"`);
      review.push(`Closest match: "${m.spoken}" -> ${pick.item}`);
    }
    if (pick.guessed) {
      notes.push(m.weight ? `there's no ${m.weight} pound ${pick.item}, so I picked ${pick.variation}`
        : `I picked ${pick.variation} for the ${pick.item}`);
    }
  }
  if (!lines.length) return { review, say: `I couldn't find ${missing.join(" or ")} in Square, so I didn't make the invoice.${added}` };

  const { order } = await square(env, fetchFn, "POST", "/orders", {
    idempotency_key: idem(),
    order: {
      location_id: location.id,
      customer_id: customer.id,
      line_items: lines.map(({ catalog_object_id, quantity }) => ({ catalog_object_id, quantity })),
    },
  });
  await square(env, fetchFn, "POST", "/invoices", {
    idempotency_key: idem(),
    invoice: {
      location_id: location.id,
      order_id: order.id,
      primary_recipient: { customer_id: customer.id },
      payment_requests: [{ request_type: "BALANCE", due_date: new Date().toISOString().slice(0, 10) }],
      delivery_method: "SHARE_MANUALLY",
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
    },
  });
  const total = money(order.total_money);
  return { review, say: `Draft invoice in Square for ${state.name}: ${lines.map((l) => l.label).join(", ")}${total ? `, ${total}` : ""}.` +
    (missing.length ? ` I couldn't find ${missing.join(" or ")} in Square.` : "") +
    (notes.length ? ` ${capital(notes.join("; "))}, so check it in Square.` : "") + added };
}

// Things the assistant didn't understand or had to guess, kept in the
// voice_review table (migration/add_voice_review.sql) for Doug to look over.
async function logReview(env, fetchFn, problems, heard, said, location) {
  if (!problems.length) return;
  try {
    await fetchFn(`${env.SUPABASE_URL}/rest/v1/voice_review`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ problem: problems.join("; "), heard: heard.join(" / "), reply: said, location: location || null }),
    });
  } catch (err) {
    console.log("Review note not saved:", err && err.message);
  }
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

// "I found 3 Doug Smiths" -> the last four digits of the phone pick one.
// Returns true if this answer was about the phone, so nothing else is read from it.
function answerLastFour(state, text) {
  const d = spokenDigits(text);
  if (d.length >= 4) {
    const hits = state.options.filter((o) => digits(o.phone).endsWith(d.slice(-4)));
    if (hits.length === 1) {
      state.name = hits[0].name;
      state.phone = hits[0].phone;
      state.options = [];
    } else {
      state.lastFourMiss = d.slice(-4);
    }
    return true;
  }
  if (DONT_KNOW.test(text)) {
    state.review.push(`More than one ${state.name}; phone not known`);
    state.options = [];
    return true;
  }
  return false; // a new name, or something else: read it as usual
}

async function converse(body, env, fetchFn, claude, now) {
  const text = squash(body.text);
  const state = readState(body.state);
  state.turns += 1;
  if (text) state.heard.push(text);
  delete state.lastFourMiss;

  let answered = false;
  if (text && state.asked === "last4") answered = answerLastFour(state, text);
  if (text && state.asked === "phone") {
    const d = spokenDigits(text);
    if (d.length >= 10) { state.phone = formatPhone(d); answered = true; }
    else if (DONT_KNOW.test(text)) { state.phoneUnknown = true; answered = true; }
  }

  if (text && !answered) {
    let parsed = null;
    if (claude) {
      try {
        const ai = await aiTurn({ ...state, heard: state.heard.slice(0, -1) }, text, now, claude);
        parsed = { intent: ai.intent, items: Array.isArray(ai.items) ? ai.items : [], name: squash(ai.customer_name),
          phone: digits(ai.customer_phone), work: squash(ai.work), shop: ai.for_shop === true };
        state.ai = ai;
      } catch (err) {
        console.log("AI step skipped:", err && err.message);
        if (!state.review.includes("AI step failed")) state.review.push("AI step failed");
      }
    }
    if (!parsed) parsed = { ...ruleParse(text, state.asked), phone: "", shop: false };
    // Compared with what was said before, not the customer list's spelling.
    if (parsed.name && parsed.name.toLowerCase() !== state.spokenName.toLowerCase()) {
      state.name = state.spokenName = titleCase(parsed.name);
      state.phone = "";
      state.lookedUp = false;
      state.options = [];
    }
    if (parsed.phone.length >= 7) { state.phone = formatPhone(parsed.phone); state.lookedUp = true; state.options = []; }
    if (parsed.work) state.work = parsed.work;
    if (parsed.shop) state.shop = true;
    // Once an invoice, always an invoice; "new customer" can come later.
    if (parsed.intent === "new_customer" || (parsed.intent === "invoice" && state.intent !== "new_customer")) state.intent = parsed.intent;
    if (parsed.items && parsed.items.length) {
      state.items = parsed.items.filter((i) => i && squash(i.spoken)).map((i) => ({ spoken: squash(i.spoken), quantity: i.quantity || 1 }));
    }
  }

  if (state.name && !state.lookedUp) {
    const match = await lookupCustomer(state.name, env, fetchFn);
    state.lookedUp = true;
    if (match.found === 1) { state.name = match.name; state.phone = match.phone; }
    else if (match.found > 1) state.options = match.options;
  }

  const giveUp = state.turns >= MAX_TURNS;
  const ask = (asked, say) => {
    state.asked = asked;
    return { done: false, say, state: JSON.stringify(state) };
  };
  const stop = (say, problem) => ({ done: true, say, review: [...state.review, problem] });
  const invoice = state.intent !== "work_order";

  // Several customers by that name: the last four of the phone tells them apart.
  if (state.options.length > 1) {
    if (giveUp) {
      if (invoice) return stop("Sorry, I couldn't tell which customer it is. Please make the invoice in Square.", `More than one ${state.name}`);
      state.review.push(`More than one ${state.name}`);
      state.options = [];
    } else {
      return ask("last4", state.lastFourMiss
        ? `None of them end in ${state.lastFourMiss.split("").join(" ")}. What are the last four digits of the phone number?`
        : `I found ${state.options.length} customers named ${state.spokenName || state.name}. What are the last four digits of their phone number?`);
    }
  }

  if (invoice) {
    if (!claude || !state.ai) return stop("Sorry, I can only make invoices when the AI step is working. Please make it in Square.", "Invoice without the AI step");
    if (state.name && !state.phone && !state.phoneUnknown && !giveUp) {
      return ask("phone", `I couldn't find ${state.name} in the app or Speccy. What's their phone number?`);
    }
    if (!state.name || !state.items.length) {
      if (giveUp) return stop("Sorry, I didn't get the invoice. Please make it in Square.", "Didn't get who or what the invoice is for");
      return !state.name ? ask("invoice_name", "Who's the invoice for?") : ask("items", `What's on the invoice for ${state.name}?`);
    }
    return { done: true, invoice: state, place: pickLocation(state.heard.join(" "), body.location), review: state.review };
  }
  const needName = !state.name && !state.shop;
  if (!state.work || (needName && !giveUp)) {
    if (giveUp) return stop("Sorry, I didn't get what the work order is for. Please add it in the app.", "Didn't get the work order");
    if (!state.work && needName) return ask("both", "Who's it for, and what are we doing?");
    if (needName) return ask("name", "Who's it for?");
    return ask("work", state.name ? `What are we doing for ${state.name}?` : "What are we doing?");
  }

  const location = pickLocation(state.heard.join(" "), body.location);
  const note = state.review.some((r) => r.startsWith("More than one")) ? ` I found more than one ${state.name}, so add the phone number in the app.` : "";
  return { done: true, row: ticketRow(state, location, now), note, review: state.review };
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
  const heard = turn.invoice ? turn.invoice.heard : readState(body && body.state).heard.concat(squash(body && body.text) || []);
  if (turn.invoice) {
    let out;
    try {
      out = await makeInvoice(turn.invoice, turn.place, env, fetchFn, claude);
    } catch (err) {
      console.log("Invoice failed:", err && err.message);
      out = { say: `Sorry, Square had a problem, so there's no invoice. ${err && err.message}`, review: [`Square error: ${err && err.message}`] };
    }
    await logReview(env, fetchFn, [...turn.review, ...out.review], heard, out.say, turn.place);
    return reply(200, { done: true, say: out.say });
  }
  if (!turn.row) {
    if (turn.done && turn.review) await logReview(env, fetchFn, turn.review, heard, turn.say, body && body.location);
    return reply(200, { done: turn.done, say: turn.say, state: turn.state });
  }

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
  await logReview(env, fetchFn, turn.review, heard, turn.row.title, turn.row.location);
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
