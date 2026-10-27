// The shop's voice assistant: work orders (staff tickets) and draft Square
// invoices, as a conversation.
//
//   "create an invoice for Doug Smith"  -> "I found two Doug Smiths. What are
//                                           the last four of the phone?"
//   "8210"                              -> "Got it. What's on the invoice?"
//   "a 15 pound Phaze and a standard drill" -> "Draft invoice in Square ..."
//
//   "work order for Doug Smith to plug his 14 pound ball"
//                                       -> "Work order added for Doug Smith."
//
// Claude (Haiku, for speed) runs the conversation. It decides what to say
// and what to ask, and acts only through the tools below: look up a customer
// (customer list, orders, appointments and Speccy's spec sheets, by close
// spelling too), search the Square item library, make a DRAFT invoice, add,
// find and change a ticket, and note something for review. Invoices are only ever drafts: staff check and send them from
// Square, so a mishearing never reaches a customer. Things it didn't
// understand or had to guess go to voice_review (migration/add_voice_review.sql).
// The voice_aliases table (migration/add_voice_aliases.sql) maps shop words
// like "standard drill" to the item's real name in Square.
//
// Without ANTHROPIC_API_KEY, or if Claude fails on the first turn, simple
// rules take the work order instead ("for NAME to WORK", or answers to "Who's
// it for?" / "What are we doing?") -- a work order is never lost to the AI.
//
// The caller (voice/shop_voice.py on the shop laptop) posts
// { text, state?, location? } with a shared password in the x-alexa-secret
// header, speaks back `say`, and if `done` is false listens again and posts
// the answer with the `state` it was given. A new wake word within a few
// minutes posts the last state with resume: true, so "change that one" still
// works. This function is the only thing that holds a database key; it reads
// customer names and phones, adds and changes tickets, and adds review notes.
// It never deletes anything.
//
// Deploy with "Enforce JWT verification" OFF: the laptop has no Supabase
// login, the password is the check. Secrets: ALEXA_SHARED_SECRET (set by hand;
// named for the Alexa skill this first served), ANTHROPIC_API_KEY,
// SQUARE_ACCESS_TOKEN (for invoices), SPECCY_URL / SPECCY_KEY (optional
// overrides); SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by
// Supabase. After changing a secret, deploy again so the function picks it up.
//
// Plain JavaScript on purpose, so it pastes into the dashboard editor as-is
// and the tests can load it under Node.

const MAX_TITLE = 200;
const MODEL = "claude-haiku-5-5";
const SQUARE_URL = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2026-09-16";
// Speccy (the spec sheet app) is a separate Supabase project. Its URL and
// publishable key are public (they ship in its web page); SPECCY_URL and
// SPECCY_KEY override them.
const SPECCY_URL = "https://bkvijjqhyiyfkuavmerh.supabase.co";
const SPECCY_KEY = "sb_publishable_Vba54XSri6vewRcBO8qDXQ_uinwbMOy";
const MAX_TURNS = 8;        // things said in one conversation
const MAX_STEPS = 6;        // Claude calls for one thing said

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

const dbHeaders = (env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });

// ---------------------------------------------------------------------------
// Customer lookup
// ---------------------------------------------------------------------------

const nameKey = (v) => squash(v).toLowerCase().replace(/[^a-z' -]/g, "");
const digits = (v) => String(v || "").replace(/\D/g, "");

function formatPhone(v) {
  const d = digits(v).replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : squash(v);
}

// 2 for the same name, 1 for the same last name with a first name that
// starts the same way ("Doug" / "Douglas"), else 0.
function nameScore(spoken, name) {
  const want = nameKey(spoken).split(" ").filter(Boolean);
  const have = nameKey(name).split(" ").filter(Boolean);
  if (!want.length || !have.length) return 0;
  if (have.join(" ") === want.join(" ")) return 2;
  if (want.length > 1 && have.length > 1 && have[have.length - 1] === want[want.length - 1]) {
    const a = have[0], b = want[0];
    if (a.startsWith(b) || b.startsWith(a)) return 1;
  }
  return 0;
}

// The customers among { customer_name, phone } rows that fit a spoken name,
// best fits first, one per phone number.
function customerMatches(spoken, rows) {
  let best = 0;
  const byPhone = new Map();
  for (const row of rows) {
    const s = nameScore(spoken, row.customer_name);
    const phone = digits(row.phone);
    if (!s || phone.length < 7) continue;
    if (s > best) { best = s; byPhone.clear(); }
    if (s === best && !byPhone.has(phone)) byPhone.set(phone, { name: squash(row.customer_name), phone: formatPhone(row.phone) });
  }
  return [...byPhone.values()];
}

// Kept for the simple rules: one phone among the best -> use it.
function matchCustomer(spoken, rows) {
  const m = customerMatches(spoken, rows);
  return m.length === 1 ? { found: 1, ...m[0] } : { found: m.length };
}

const SUFFIXES = new Set(["sr", "jr", "ii", "iii", "iv"]);
const nameWords = (v) => nameKey(v).replace(/[^a-z ]/g, "").split(" ").filter((w) => w && !SUFFIXES.has(w));
// Last name as one sound-ish string: "De Grazia" = "DeGrazia", "-sky" = "-ski".
const lastKey = (ws) => ws.slice(ws.length > 1 ? 1 : 0).join("").replace(/sky\b/g, "ski").replace(/ph/g, "f");

// Search pieces of the last name, so a misheard spelling still finds the
// row: "Yablonsky" searches *yab*, *abl*, *nsky* (finds "Jablonski").
function namePieces(name) {
  const last = nameWords(name).slice(-1)[0] || "";
  if (last.length < 3) return last ? [last] : [];
  const pieces = [last.slice(0, 3), last.slice(1, 4), last.length >= 5 ? last.slice(-4) : ""];
  return [...new Set(pieces.filter((p) => p.length >= 3))];
}

// Customers whose last name shares a piece with the spoken one, from the
// customer list, orders, appointments and Speccy's spec sheets (most recently
// measured first). speccy says whether Speccy could be read.
async function customerRows(name, env, fetchFn) {
  const pieces = namePieces(name);
  if (!pieces.length) return { rows: [], speccy: "not searched" };
  const or = (col) => `or=(${pieces.map((p) => `${col}.ilike.*${p}*`).join(",")})`;
  const tables = ["customer_directory", "orders", "appointments"];
  const lists = await Promise.all(tables.map(async (table) => {
    try {
      const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/${table}?select=customer_name,phone` +
        `&${or("customer_name")}&deleted_at=is.null&limit=300`, { headers: dbHeaders(env) });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  }));
  const key = env.SPECCY_KEY || SPECCY_KEY;
  let speccy = "read", fromSpeccy = [];
  try {
    const res = await fetchFn(`${env.SPECCY_URL || SPECCY_URL}/rest/v1/customers?select=name,phone` +
      `&${or("name")}&removed_at=is.null&order=last_spec_at.desc.nullslast&limit=100`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (res.ok) fromSpeccy = (await res.json()).map((r) => ({ customer_name: r.name, phone: r.phone }));
    else speccy = `could not be read (error ${res.status})`;
  } catch (err) {
    speccy = `could not be read (${err && err.message})`;
  }
  return { rows: [...lists.flat(), ...fromSpeccy], speccy };
}

// For Claude: who fits the spoken name (same name, or "Doug" for "Douglas"),
// and failing that the closest-sounding names ("Yablonsky" -> "Jablonski").
// One entry per name and phone; phone is "" when none is on file.
function findCustomers(spoken, rows) {
  const want = nameWords(spoken);
  const matches = new Map(), close = new Map();
  if (!want.length) return { matches: [], close: [] };
  for (const row of rows) {
    const name = squash(row.customer_name);
    const have = nameWords(name);
    if (!have.length) continue;
    const phone = digits(row.phone).length >= 7 ? formatPhone(row.phone) : "";
    const key = `${have.join(" ")}|${digits(phone)}`;
    const firstFits = want.length < 2 || have[0].startsWith(want[0]) || want[0].startsWith(have[0]);
    const sameLast = lastKey(have) === lastKey(want);
    if (sameLast && firstFits) {
      if (!matches.has(key)) matches.set(key, { name, phone });
      continue;
    }
    const like = wordLike(lastKey(want), lastKey(have));
    const score = like + (firstFits ? 0.15 : 0) + (sameLast ? 0.3 : 0);
    if ((like >= 0.65 && firstFits) || like >= 0.85 || sameLast) {
      if (!close.has(key) || close.get(key).score < score) close.set(key, { name, phone, score });
    }
  }
  // A name with a phone beats the same name without one.
  const keep = (list) => list.filter((c, _, all) => c.phone || !all.some((o) => o.phone && nameKey(o.name) === nameKey(c.name)));
  return {
    matches: keep([...matches.values()]).slice(0, 8),
    close: matches.size ? [] : keep([...close.values()].sort((a, b) => b.score - a.score)).slice(0, 5).map(({ name, phone }) => ({ name, phone })),
  };
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

async function loadAliases(env, fetchFn) {
  try {
    const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/voice_aliases?select=spoken,square_item`, { headers: dbHeaders(env) });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

const words = (v) => nameKey(v).replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean);

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

const FILLER = new Set(["and", "with", "the", "for", "a", "an", "of", "one", "lb", "lbs", "pound", "pounds", "ball", "new"]);

// Square's search only finds names containing the words searched for, so a
// misheard or loosely said name finds nothing. Search for the whole name,
// any shop word's real name (voice_aliases) and each word, and return the
// closest items with their variations and prices.
async function searchItems(env, fetchFn, said) {
  const aliases = await loadAliases(env, fetchFn);
  const padded = ` ${words(said).join(" ")} `;
  const aliased = aliases.filter((a) => a.spoken && padded.includes(` ${words(a.spoken).join(" ")} `)).map((a) => squash(a.square_item));
  const query = squash(said.replace(/\b\d{1,2}\s*(?:lb|lbs|pound|pounds|pounder)\b/gi, " "));
  const ws = words(query).filter((w) => w.length >= 3 && !FILLER.has(w) && !/^\d+$/.test(w));
  const searches = [...new Set([...aliased, query, ...ws].filter(Boolean))].slice(0, 6);
  const found = await Promise.all(searches.map((q) =>
    square(env, fetchFn, "POST", "/catalog/search-catalog-items", { text_filter: q, limit: 100 }).then((r) => r.items || [])));
  const byId = new Map();
  for (const item of found.flat()) if (item && item.item_data && !byId.has(item.id)) byId.set(item.id, item);
  const score = (name) => Math.max(itemScore(query, name), ...aliased.map((a) => itemScore(a, name) + 1));
  return [...byId.values()]
    .map((item) => ({ item, score: score(item.item_data.name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ item }) => ({
      item: item.item_data.name,
      variations: (item.item_data.variations || []).map((v) => {
        const d = v.item_variation_data || {};
        return { variation_id: v.id, name: d.name || "", price: money(d.price_money) };
      }),
    }));
}

async function draftInvoice(env, fetchFn, input, place) {
  const name = squash(input.customer_name);
  const { locations } = await square(env, fetchFn, "GET", "/locations");
  const location = pickSquareLocation(locations, place);
  if (!location) return { error: "No Square location found." };
  let customer = await findSquareCustomer(env, fetchFn, name, input.phone);
  let added = false;
  if (!customer) {
    if (!input.new_customer) {
      return { error: digits(input.phone).length >= 10
        ? `${name} (${formatPhone(input.phone)}) is not in Square. Ask whether to add them as a new customer.`
        : "A 10-digit phone number is needed to find the customer in Square." };
    }
    customer = await createSquareCustomer(env, fetchFn, name, input.phone);
    added = true;
  }
  const lines = (input.lines || []).filter((l) => l && l.variation_id);
  if (!lines.length) return { error: "No items on the invoice." };
  const { order } = await square(env, fetchFn, "POST", "/orders", {
    idempotency_key: idem(),
    order: {
      location_id: location.id,
      customer_id: customer.id,
      line_items: lines.map((l) => ({ catalog_object_id: l.variation_id, quantity: String(Math.max(1, l.quantity || 1)) })),
    },
  });
  const { invoice } = await square(env, fetchFn, "POST", "/invoices", {
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
  return { ok: true, draft_invoice: invoice && invoice.id, total: money(order.total_money),
    added_to_square: added, customer_in_square: [customer.given_name, customer.family_name].filter(Boolean).join(" ") || name };
}

// ---------------------------------------------------------------------------
// Tickets and review notes
// ---------------------------------------------------------------------------

async function insertTicket(env, fetchFn, row) {
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/tickets`, {
    method: "POST",
    headers: { ...dbHeaders(env), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Database said ${res.status}: ${await res.text()}`);
  const [created] = await res.json();
  return created;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const customerOf = (details) => ((/^Customer: (.*)$/m.exec(details || "") || [])[1] || "").trim();

// Recent work orders, newest first, narrowed by customer and/or title words.
async function findTickets(env, fetchFn, { customer_name, words: said }) {
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/tickets?select=id,title,details,status,due_date,submitted_at` +
    `&deleted_at=is.null&order=submitted_at.desc&limit=200`, { headers: dbHeaders(env) });
  if (!res.ok) throw new Error(`Database said ${res.status}`);
  const want = nameWords(customer_name || "");
  const ws = words(said || "").filter((w) => w.length >= 3);
  return (await res.json())
    .filter((t) => {
      const who = nameWords(customerOf(t.details));
      if (want.length && !(who.length && wordLike(lastKey(want), lastKey(who)) >= 0.65)) return false;
      if (ws.length && !ws.some((w) => words(`${t.title} ${t.details}`).some((h) => wordLike(w, h) >= 0.75))) return false;
      return true;
    })
    .slice(0, 6)
    .map((t) => ({ id: t.id, title: t.title, customer: customerOf(t.details), status: t.status, due_date: t.due_date,
      added: String(t.submitted_at || "").slice(0, 10) }));
}

// Changes only the fields given. The customer lines and notes live in details.
async function updateTicket(env, fetchFn, input, now) {
  if (!UUID.test(String(input.id || ""))) return { error: "Need the work order's id (from create_work_order or find_work_orders)." };
  const url = `${env.SUPABASE_URL}/rest/v1/tickets?id=eq.${input.id}&deleted_at=is.null`;
  const res = await fetchFn(`${url}&select=id,title,details,status,completed_at`, { headers: dbHeaders(env) });
  const [t] = res.ok ? await res.json() : [];
  if (!t) return { error: "No work order with that id." };
  const changes = {};
  const has = (k) => typeof input[k] === "string" && input[k].trim();
  if (has("title")) changes.title = squash(input.title).slice(0, MAX_TITLE);
  if (has("priority") && PRIORITIES.includes(input.priority)) changes.priority = input.priority;
  if (has("location") && PLACES.includes(input.location)) changes.location = input.location;
  if (has("due_date")) changes.due_date = /^\d{4}-\d{2}-\d{2}$/.test(input.due_date) ? input.due_date : null;
  if (has("status") && ["new", "assigned", "in_progress", "blocked", "done"].includes(input.status)) {
    changes.status = input.status;
    changes.completed_at = input.status === "done" ? (t.completed_at || now.toISOString()) : null;
  }
  if (has("done_note")) changes.resolution = squash(input.done_note);
  let details = t.details || "";
  if (has("customer_name") || has("phone")) {
    const name = has("customer_name") ? squash(input.customer_name) : customerOf(details);
    const phone = has("phone") ? formatPhone(input.phone) : ((/^Phone: (.*)$/m.exec(details) || [])[1] || "").trim();
    const contact = `Customer: ${name}\nPhone: ${phone}`;
    details = /^Customer: .*\nPhone: .*$/m.test(details) ? details.replace(/^Customer: .*\nPhone: .*$/m, contact) : `${contact}\n\n${details}`;
  }
  if (has("note")) details = `${details}\n\nVoice note ${now.toISOString().slice(0, 10)}: ${squash(input.note)}`.trim();
  if (details !== (t.details || "")) changes.details = details;
  if (!Object.keys(changes).length) return { error: "Nothing to change." };
  const upd = await fetchFn(url, {
    method: "PATCH",
    headers: { ...dbHeaders(env), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(changes),
  });
  if (!upd.ok) throw new Error(`Database said ${upd.status}: ${await upd.text()}`);
  return { ok: true, changed: Object.keys(changes).filter((k) => k !== "completed_at") };
}

// A ticket row from what we know; values the tickets table would reject are dropped.
function ticketRow({ name, phone, work, title, details, category, priority, due_date, heard }, location, now) {
  const ok = (v, test) => (typeof v === "string" && test(v.trim()) ? v.trim() : null);
  let t = ok(title, Boolean) || capital(squash(work));
  if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE - 1) + "…";
  const contact = name ? `Customer: ${name}\nPhone: ${phone || ""}` : "";
  return {
    submitted_by: "Alexa",
    submitted_at: now.toISOString(),
    location,
    title: t,
    details: [contact, ok(details, Boolean), `Said: "${heard.join(" / ")}"`].filter(Boolean).join("\n\n"),
    category: ok(category, (v) => CATEGORIES.includes(v)) || (name ? "Customer" : null),
    priority: ok(priority, (v) => PRIORITIES.includes(v)) || "normal",
    due_date: ok(due_date, (v) => /^\d{4}-\d{2}-\d{2}$/.test(v)),
    status: "new",
  };
}

// Things the assistant didn't understand or had to guess, kept in the
// voice_review table (migration/add_voice_review.sql) for review.
async function logReview(env, fetchFn, problem, heard, said, location) {
  if (!problem) return;
  try {
    await fetchFn(`${env.SUPABASE_URL}/rest/v1/voice_review`, {
      method: "POST",
      headers: { ...dbHeaders(env), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ problem, heard: heard.join(" / "), reply: said, location: location || null }),
    });
  } catch (err) {
    console.log("Review note not saved:", err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Claude runs the conversation
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "find_customer",
    description: "Look up a customer by name in the shop's customer list, orders, appointments and Speccy spec sheets. matches: customers with that name ('Doug' fits 'Douglas'), with phone ('' if none on file). close: when nothing matches, the closest-sounding names (the transcript often misspells names). speccy says whether the spec sheets could be read.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "search_square_items",
    description: "Search the Square item library for one thing to put on an invoice, as said (e.g. 'Phaze 6', 'standard drill'). Returns the closest items with their variations (usually ball weights) and prices. Search once per thing.",
    input_schema: { type: "object", properties: { said: { type: "string" } }, required: ["said"] },
  },
  {
    name: "create_draft_invoice",
    description: "Make a DRAFT invoice in Square (never sent; staff send it). Needs the customer's 10-digit phone to find them in Square; set new_customer only when the speaker said to add them as a new customer. Lines use variation_id values from search_square_items.",
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        phone: { type: "string" },
        new_customer: { type: "boolean" },
        lines: { type: "array", items: { type: "object", properties: { variation_id: { type: "string" }, quantity: { type: "integer" } }, required: ["variation_id"] } },
      },
      required: ["customer_name", "phone", "lines"],
    },
  },
  {
    name: "create_work_order",
    description: "Add a work order (staff ticket). customer_name is empty for a job on the shop itself (machines, lanes, building, supplies).",
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        phone: { type: "string", description: "From find_customer, or empty if not known." },
        title: { type: "string", description: "Short and specific, e.g. 'Plug and redrill 14 lb ball'. No customer name." },
        details: { type: "string", description: "Specifics the title leaves out, or empty." },
        category: { type: "string", enum: CATEGORIES },
        priority: { type: "string", enum: PRIORITIES },
        due_date: { type: "string", description: "YYYY-MM-DD, or empty." },
        location: { type: "string", enum: PLACES },
      },
      required: ["customer_name", "title", "category", "priority"],
    },
  },
  {
    name: "find_work_orders",
    description: "Find recent work orders (newest first) to change one: by customer name and/or words in the title. Returns id, title, customer, status, due date and when it was added.",
    input_schema: { type: "object", properties: { customer_name: { type: "string" }, words: { type: "string" } } },
  },
  {
    name: "update_work_order",
    description: "Change a work order by id (from create_work_order or find_work_orders). Only include what changes. status: new (to review), assigned, in_progress, blocked, done. note is added to the details; done_note is the resolution, e.g. 'Done, not picked up yet'.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        customer_name: { type: "string" },
        phone: { type: "string" },
        note: { type: "string" },
        status: { type: "string", enum: ["new", "assigned", "in_progress", "blocked", "done"] },
        done_note: { type: "string" },
        priority: { type: "string", enum: PRIORITIES },
        due_date: { type: "string", description: "YYYY-MM-DD, or 'none' to clear it." },
        location: { type: "string", enum: PLACES },
      },
      required: ["id"],
    },
  },
  {
    name: "note_for_review",
    description: "Save a short note for the owner to review: something you couldn't understand, a guess you had to make, or something asked for that you can't do.",
    input_schema: { type: "object", properties: { problem: { type: "string" } }, required: ["problem"] },
  },
  {
    name: "speak",
    description: "Say something to the person. Every turn ends with this. done is true when the job is finished or dropped, false when you asked something and are waiting for the answer.",
    input_schema: { type: "object", properties: { say: { type: "string" }, done: { type: "boolean" } }, required: ["say", "done"] },
  },
];

function systemPrompt(now, location) {
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
  return `You are the voice assistant at a bowling pro shop, on a laptop at ${location || "the shop"}. Staff talk to you, often while working, to add or change work orders and make draft invoices in Square. You hear a speech transcript: names and ball names are often misheard, so fix the obvious ones.

Be brief. Most replies are a few words, never more than one short sentence plus one question. Confirm with the essentials only: "Done: plug thumb on Joe Sutton's NU Blue." Don't repeat back location, priority or anything they didn't ask about, and don't ask for anything optional (due date, priority, details). No lists or symbols; say "14 pound", not "14 lb"; never read out phone numbers. Every turn ends with the speak tool.

Customers: look them up with find_customer. If there's one match, use it without comment. If several, ask for the last four digits of the phone (if they give only some digits, say what you heard and ask for the rest; "either one" means the first). If none match but close names come back, ask once: "Did you mean John Jablonski?" If nothing is close, or they say to just make it or it's a new customer, go ahead without a phone and say "no phone on file". Don't ask them to spell names more than once.

Work orders: need who (or a shop job: lanes, machines, building, supplies) and what we're doing. As soon as you have both, create it. Category Customer for a customer's job. Priority normal unless they say otherwise (urgent for safety or something stopping business, high for today or tonight's league, low if it can wait). Today is ${weekday} ${today}; turn "Friday" or "tomorrow" into a date only if they mention one.

Changing work orders: "change that one", "make it a bake and resurface", "mark the Special Effect done but not picked up". Use the id from this conversation, or find_work_orders by customer or ball, then update_work_order. If several fit, ask which in a few words. You can't delete work orders; say to do that in the app.

Invoices: who and what. The customer's 10-digit phone is needed to find them in Square (if none, ask for it). Search each item with search_square_items and use only an item that clearly is what was said; otherwise ask ("Did you mean the Game Breaker 5 Solid?"). For a ball, pick the variation by weight, asking the weight if there are several. Then create_draft_invoice and say who, what and the total. It is a draft: never say it was sent. If they aren't in Square, ask whether to add them as a new customer.

Earlier messages may be from a few minutes ago; use them for "that one" or "the last one". Use note_for_review when you couldn't understand something, had to guess, or were asked for something you can't do. If they say never mind, cancel or we're done, stop (done). Never invent customers, phone numbers, items, prices or work orders: only use what the tools return.`;
}

// Only what the API needs back: text and tool calls.
const keepBlock = (b) => (b.type === "text" ? { type: "text", text: b.text }
  : b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } : null);

async function runTool(name, input, ctx) {
  const { env, fetchFn, state, now } = ctx;
  input = input || {};
  if (name === "find_customer") {
    const { rows, speccy } = await customerRows(input.name, env, fetchFn);
    if (speccy !== "read" && speccy !== "not searched" && !state.review.some((r) => r.startsWith("Speccy"))) state.review.push(`Speccy ${speccy}`);
    return { ...findCustomers(input.name, rows), speccy };
  }
  if (name === "find_work_orders") return { work_orders: await findTickets(env, fetchFn, input) };
  if (name === "update_work_order") return await updateTicket(env, fetchFn, input, now);
  if (name === "search_square_items") {
    if (!env.SQUARE_ACCESS_TOKEN) return { error: "Square isn't connected (no SQUARE_ACCESS_TOKEN), so invoices can't be made." };
    return { items: await searchItems(env, fetchFn, squash(input.said)) };
  }
  if (name === "create_draft_invoice") {
    if (!env.SQUARE_ACCESS_TOKEN) return { error: "Square isn't connected (no SQUARE_ACCESS_TOKEN), so invoices can't be made." };
    const key = JSON.stringify(input);
    if (state.done.includes(key)) return { error: "That exact invoice was already made in this conversation." };
    const out = await draftInvoice(env, fetchFn, input, ctx.place);
    if (out.ok) state.done.push(key);
    return out;
  }
  if (name === "create_work_order") {
    const key = JSON.stringify(input);
    if (state.done.includes(key)) return { error: "That exact work order was already added in this conversation." };
    const place = PLACES.includes(input.location) ? input.location : ctx.place;
    const row = ticketRow({ ...input, name: squash(input.customer_name), phone: input.phone ? formatPhone(input.phone) : "",
      work: input.title, heard: state.heard }, place, now);
    const created = await insertTicket(env, fetchFn, row);
    state.done.push(key);
    return { ok: true, ticket: created && created.id, location: place };
  }
  if (name === "note_for_review") {
    state.review.push(squash(input.problem));
    return { ok: true };
  }
  return { error: `No tool named ${name}` };
}

function readAgentState(raw) {
  try {
    const s = JSON.parse(raw);
    if (s && s.v === 2) return s;
  } catch { /* first turn */ }
  return null;
}

// A new wake word within a few minutes carries the last conversation on (so
// "change that one" works), with a fresh turn count. Only the most recent
// messages are kept, cut where a person spoke so tool calls stay paired.
function resumeState(state) {
  state.turns = 0;
  state.heard = [];
  state.review = [];
  state.done = [];
  const KEEP = 30;
  if (state.messages.length > KEEP) {
    let i = state.messages.length - KEEP;
    while (i < state.messages.length && typeof state.messages[i].content !== "string") i++;
    state.messages = state.messages.slice(i);
  }
  return state;
}

// One thing said. Returns { done, say, state? }.
async function agentTurn(body, state, env, fetchFn, claude, now) {
  const text = squash(body.text);
  state.turns += 1;
  if (text) state.heard.push(text);
  const said = text || "(said nothing)";
  // After speak, the last message holds its tool result; what was said next joins it.
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: said });
  else state.messages.push({ role: "user", content: said });

  const place = pickLocation(state.heard.join(" "), body.location);
  const ctx = { env, fetchFn, state, now, place };
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(now, body.location),
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages: state.messages,
    });
    if (response.stop_reason === "refusal") throw new Error("Claude declined");
    const content = response.content.map(keepBlock).filter(Boolean);
    state.messages.push({ role: "assistant", content });
    const calls = content.filter((b) => b.type === "tool_use");
    if (!calls.length) {
      // No tool call despite tool_choice: speak the text, keep listening.
      const say = content.filter((b) => b.type === "text").map((b) => b.text).join(" ") || "Sorry, say that again?";
      return { done: false, say };
    }
    const results = [];
    let spoken = null;
    for (const call of calls) {
      if (call.name === "speak") {
        spoken = { say: squash(call.input && call.input.say) || "Okay.", done: !!(call.input && call.input.done) };
        results.push({ type: "tool_result", tool_use_id: call.id, content: "said" });
        continue;
      }
      let out;
      try {
        out = await runTool(call.name, call.input, ctx);
      } catch (err) {
        console.log(`${call.name} failed:`, err && err.message);
        out = { error: String((err && err.message) || err) };
        if (call.name !== "find_customer") state.review.push(`${call.name} failed: ${out.error}`);
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
    }
    state.messages.push({ role: "user", content: results });
    if (spoken) return spoken;
  }
  state.review.push("Got stuck (too many steps)");
  return { done: true, say: "Sorry, I got stuck on that one. Please add it in the app or Square." };
}

// ---------------------------------------------------------------------------
// Simple rules, when Claude isn't available: work orders only
// ---------------------------------------------------------------------------

function blankState() {
  return { name: "", spokenName: "", phone: "", lookedUp: false, work: "", heard: [], asked: "", turns: 0 };
}

function readState(raw) {
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === "object" && s.v !== 2) return { ...blankState(), ...s };
  } catch { /* first turn, or junk -- start over */ }
  return blankState();
}

// "for Doug Smith to plug his ball", "for Doug Smith", or a plain answer to
// whatever was just asked.
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

async function rulesTurn(body, env, fetchFn, now) {
  const text = squash(body.text);
  const state = readState(body.state);
  state.turns += 1;
  if (text) {
    state.heard.push(text);
    if (/\binvoice\b/i.test(text)) return { done: true, say: "Sorry, I can only make invoices when the AI is working. Please make it in Square.", review: "Invoice asked for without the AI" };
    const parsed = ruleParse(text, state.asked);
    if (parsed.name && parsed.name.toLowerCase() !== state.spokenName.toLowerCase()) {
      state.name = state.spokenName = titleCase(parsed.name);
      state.phone = "";
      state.lookedUp = false;
    }
    if (parsed.work) state.work = parsed.work;
  }

  let note = "";
  if (state.name && !state.lookedUp) {
    const match = matchCustomer(state.name, (await customerRows(state.name, env, fetchFn)).rows);
    state.lookedUp = true;
    if (match.found === 1) { state.name = match.name; state.phone = match.phone; }
    else if (match.found > 1) note = ` I found more than one ${state.name}, so add the phone number in the app.`;
  }

  const giveUp = state.turns >= MAX_TURNS;
  if (!state.work || (!state.name && !giveUp)) {
    if (giveUp) return { done: true, say: "Sorry, I didn't get what the work order is for. Please add it in the app.", review: "Didn't get the work order" };
    state.asked = !state.work && !state.name ? "both" : !state.name ? "name" : "work";
    const say = state.asked === "both" ? "Who's it for, and what are we doing?"
      : state.asked === "name" ? "Who's it for?"
      : `What are we doing for ${state.name}?`;
    return { done: false, say: say + note, state: JSON.stringify(state) };
  }

  const location = pickLocation(state.heard.join(" "), body.location);
  const row = ticketRow({ ...state }, location, now);
  await insertTicket(env, fetchFn, row);
  return { done: true, say: `Work order added${state.name ? ` for ${state.name}` : ""}: ${row.title}.${note}` };
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
    body = (await req.json()) || {};
  } catch {
    return reply(400, { error: "Send JSON: { text, state?, location? }" });
  }
  const now = new Date();
  const text = squash(body.text);

  // A first turn with nothing said (the laptop's --test) just opens the conversation.
  const existing = readAgentState(body.state);
  if (!text && !body.state) {
    const state = claude ? { v: 2, messages: [], heard: [], turns: 0, done: [], review: [] } : { ...blankState(), asked: "both" };
    return reply(200, { done: false, say: "What do you need?", state: JSON.stringify(state) });
  }

  if (claude && (existing || !body.state)) {
    const state = existing ? (body.resume ? resumeState(existing) : existing) : { v: 2, messages: [], heard: [], turns: 0, done: [], review: [] };
    let turn;
    try {
      turn = await agentTurn(body, state, env, fetchFn, claude, now);
    } catch (err) {
      console.log("AI step failed:", err && err.message);
      if (state.turns <= 1 && !state.done.length) {
        // Nothing lost or done yet: the simple rules take it from here.
        const rules = await rulesTurn({ ...body, state: "" }, env, fetchFn, now).catch((e) => ({ done: true, say: `Sorry, that didn't work. ${e.message}` }));
        await logReview(env, fetchFn, `AI step failed (${err && err.message})${rules.review ? `; ${rules.review}` : ""}`, [text], rules.say, body.location);
        return reply(200, { done: rules.done, say: rules.say, state: rules.state });
      }
      state.review.push(`AI step failed: ${err && err.message}`);
      turn = { done: true, say: "Sorry, I lost my train of thought. Please start again, or add it in the app." };
    }
    const done = turn.done || state.turns >= MAX_TURNS;
    if (!turn.done && done) state.review.push("Conversation ran too long");
    // Review notes ride along in the state and are saved once, when the conversation ends.
    if (done && state.review.length) {
      await logReview(env, fetchFn, state.review.join("; "), state.heard, turn.say, pickLocation(state.heard.join(" "), body.location));
      state.review = [];
    }
    // The state comes back even when done, for the laptop to resume with.
    return reply(200, { done, say: turn.say, state: JSON.stringify(state) });
  }

  try {
    const turn = await rulesTurn(body, env, fetchFn, now);
    if (turn.done && turn.review) await logReview(env, fetchFn, turn.review, readState(body.state).heard.concat(text || []), turn.say, body.location);
    return reply(200, { done: turn.done, say: turn.say, state: turn.state });
  } catch (err) {
    return reply(502, { error: String((err && err.message) || err) });
  }
}

if (typeof Deno !== "undefined") {
  let claude;
  const getClaude = async (env) => {
    if (claude === undefined) {
      claude = null;
      if (env.ANTHROPIC_API_KEY) {
        const { default: Anthropic } = await import("npm:@anthropic-ai/sdk");
        // Each Claude call has 8 seconds; a turn may take a few.
        claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 8000, maxRetries: 0 });
      }
    }
    return claude;
  };
  Deno.serve(async (req) => {
    const env = Deno.env.toObject();
    return handle(req, env, fetch, await getClaude(env));
  });
}
