// Turns one spoken sentence from the shop Alexa into a staff ticket.
//
// The Alexa skill (alexa/skill.js) posts here with a shared password in the
// x-alexa-secret header. This function is the only thing that holds a
// database key, and all it can do is add a "new" ticket -- so a leaked
// password lets someone add tickets, which the public anon key already
// allows. It never reads, updates or deletes anything.
//
// Deploy with "Enforce JWT verification" OFF: Alexa has no Supabase login,
// the password is the check. Secrets: ALEXA_SHARED_SECRET (set by hand);
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
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

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handle(req, env, fetchFn) {
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

  let row;
  try {
    row = ticketFromSpeech(await req.json(), new Date());
  } catch (err) {
    return reply(400, { error: err.message });
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
  return reply(200, { id: created && created.id, title: row.title, location: row.location });
}

if (typeof Deno !== "undefined") {
  Deno.serve((req) => handle(req, Deno.env.toObject(), fetch));
}
