// Work tickets on the G2: Doug's IU19 helpdesk email, read through Microsoft Graph.
//
// The glasses app (g2-tickets/) posts { action, ... } with the password in the
// x-tickets-secret header. This function only fetches and sends: the app turns the
// emails into the to-do list itself (g2-tickets/src/tickets.ts), so the parsing
// is tested in one place.
//
//   connect        start Microsoft sign-in: returns a code to enter at microsoft.com/devicelogin
//   connect_check  finish it once the code is entered; keeps the refresh token
//   mail           helpdesk emails from the last `days` days (default 30), trimmed bodies
//   check          { id, undo? } check a ticket off the list (or put it back)
//   transcribe     { audio } 16 kHz 16-bit mono PCM, base64 -> { heard }
//   reply          { messageId, text } reply to that helpdesk email; Lansweeper adds it to the ticket
//
// Plain JavaScript in a .ts file, like alexa-work-order, so it can be pasted into the
// Supabase dashboard as one file and loaded by the Node tests.
//
// Secrets (Edge Functions -> Secrets): TICKETS_SECRET (the app's password),
// MS_CLIENT_ID and MS_TENANT_ID (the Entra app registration), DEEPGRAM_API_KEY
// (already set for EDITH). Optional: HELPDESK_ADDRESS (default helpdesk@iu19.org).
// Storage: the work_tickets_kv table (migration/add_work_tickets.sql) holds the
// Microsoft tokens and the checked-off list. Email itself is never stored.

const SCOPES = "offline_access User.Read Mail.Read Mail.Send";
const GRAPH = "https://graph.microsoft.com/v1.0";
const BODY_MAX = 6000; // the event line and newest note are near the top
const MAX_PAGES = 8;
const MAX_AUDIO_BYTES = 30 * 32000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-tickets-secret",
  "Access-Control-Max-Age": "86400",
};

function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Key-value storage in Supabase
// ---------------------------------------------------------------------------

function db(env, fetchFn) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  const base = `${env.SUPABASE_URL}/rest/v1/work_tickets_kv`;
  return {
    async get(key) {
      const res = await fetchFn(`${base}?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
      if (!res.ok) throw new Error(`Storage said ${res.status}. Has migration/add_work_tickets.sql been run?`);
      const rows = await res.json();
      return rows.length ? rows[0].value : null;
    },
    async set(key, value) {
      const res = await fetchFn(base, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`Storage said ${res.status} saving ${key}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft sign-in (device code flow: no redirect page needed)
// ---------------------------------------------------------------------------

const authority = (env) => `https://login.microsoftonline.com/${env.MS_TENANT_ID || "organizations"}/oauth2/v2.0`;

async function form(fetchFn, url, fields) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

async function connect(env, fetchFn, store) {
  const { ok, data } = await form(fetchFn, `${authority(env)}/devicecode`, { client_id: env.MS_CLIENT_ID, scope: SCOPES });
  if (!ok) throw new Error(data.error_description || data.error || "Microsoft wouldn't start the sign-in");
  await store.set("device_code", { code: data.device_code, expires: Date.now() + data.expires_in * 1000 });
  return { code: data.user_code, url: data.verification_uri, say: data.message };
}

async function connectCheck(env, fetchFn, store) {
  const pending = await store.get("device_code");
  if (!pending || pending.expires < Date.now()) return { connected: false, say: "No sign-in waiting. Start again." };
  const { ok, data } = await form(fetchFn, `${authority(env)}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: env.MS_CLIENT_ID,
    device_code: pending.code,
  });
  if (!ok) {
    if (data.error === "authorization_pending") return { connected: false, say: "Waiting for you to enter the code." };
    throw new Error(data.error_description || data.error || "Sign-in failed");
  }
  await store.set("microsoft", { refresh_token: data.refresh_token });
  await store.set("device_code", null);
  return { connected: true, say: "Connected to Outlook." };
}

// A fresh access token for each request. Microsoft rotates refresh tokens, so keep the new one.
async function accessToken(env, fetchFn, store) {
  const saved = await store.get("microsoft");
  if (!saved || !saved.refresh_token) throw new Error("Outlook isn't connected yet. Use Connect Outlook on the phone.");
  const { ok, data } = await form(fetchFn, `${authority(env)}/token`, {
    grant_type: "refresh_token",
    client_id: env.MS_CLIENT_ID,
    refresh_token: saved.refresh_token,
    scope: SCOPES,
  });
  if (!ok) throw new Error(`Outlook sign-in expired (${data.error || "refused"}). Connect Outlook again on the phone.`);
  if (data.refresh_token && data.refresh_token !== saved.refresh_token) await store.set("microsoft", { refresh_token: data.refresh_token });
  return data.access_token;
}

async function graph(fetchFn, token, url, init = {}) {
  const res = await fetchFn(url.startsWith("http") ? url : `${GRAPH}${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"', "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Outlook said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 202 || res.status === 204 ? {} : res.json();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const addresses = (list) => (list || []).map((r) => (r.emailAddress || {}).address).filter(Boolean);

async function mail(env, fetchFn, store, days) {
  const token = await accessToken(env, fetchFn, store);
  const me = await graph(fetchFn, token, "/me?$select=mail,userPrincipalName");
  const helpdesk = (env.HELPDESK_ADDRESS || "helpdesk@iu19.org").replace(/'/g, "");
  const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 90) * 86400000).toISOString();
  const params = new URLSearchParams({
    $filter: `from/emailAddress/address eq '${helpdesk}' and receivedDateTime ge ${since}`,
    $select: "id,subject,toRecipients,ccRecipients,receivedDateTime,body",
    $top: "50",
  });
  const mails = [];
  let url = `/me/messages?${params}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const out = await graph(fetchFn, token, url);
    for (const m of out.value || []) {
      mails.push({
        messageId: m.id,
        subject: m.subject || "",
        from: helpdesk,
        to: addresses(m.toRecipients),
        cc: addresses(m.ccRecipients),
        date: m.receivedDateTime,
        text: String((m.body || {}).content || "").slice(0, BODY_MAX),
      });
    }
    url = out["@odata.nextLink"] || "";
  }
  const checked = (await store.get("checked")) || {};
  return { me: me.mail || me.userPrincipalName, mails, checked };
}

async function check(store, id, undo) {
  if (!Number.isInteger(id)) throw new Error("Which ticket? Send { id }.");
  const checked = (await store.get("checked")) || {};
  if (undo) delete checked[id];
  else checked[id] = new Date().toISOString();
  // Keep the list small: ticket numbers only climb.
  const ids = Object.keys(checked).map(Number).sort((a, b) => b - a);
  for (const old of ids.slice(500)) delete checked[old];
  await store.set("checked", checked);
  return { ok: true, checked };
}

function base64Bytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function transcribe(env, fetchFn, audio) {
  if (!env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY is not set");
  const pcm = base64Bytes(audio);
  if (pcm.length > MAX_AUDIO_BYTES) throw new Error("That was too long; keep it under 30 seconds.");
  const params = new URLSearchParams({ model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1", smart_format: "true" });
  const res = await fetchFn(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, "Content-Type": "application/octet-stream" },
    body: pcm,
  });
  if (!res.ok) throw new Error(`Speech to text said ${res.status}`);
  const out = await res.json();
  const words = ((((out.results || {}).channels || [])[0] || {}).alternatives || [])[0];
  return { heard: String((words && words.transcript) || "").replace(/\s+/g, " ").trim() };
}

// Graph's reply puts `comment` above the quoted email, which is exactly where
// Lansweeper looks ("Everything above this line is added to your ticket").
async function reply(env, fetchFn, store, messageId, text) {
  const words = String(text || "").trim();
  if (!messageId || !words) throw new Error("Send { messageId, text }.");
  if (words.length > 2000) throw new Error("That reply is too long for the glasses.");
  const token = await accessToken(env, fetchFn, store);
  await graph(fetchFn, token, `/me/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ comment: words }),
  });
  return { ok: true, say: "Reply sent." };
}

async function handle(req, env, fetchFn) {
  const respond = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond(405, { error: "POST only" });

  const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
  const expected = clean(env.TICKETS_SECRET);
  const given = clean(req.headers.get("x-tickets-secret"));
  if (!expected) return respond(500, { error: "TICKETS_SECRET is not set" });
  if (!sameSecret(given, expected)) return respond(401, { error: `Wrong password (got ${given.length} characters, expected ${expected.length})` });

  let body;
  try {
    body = (await req.json()) || {};
  } catch {
    return respond(400, { error: "Send JSON: { action, ... }" });
  }
  const store = db(env, fetchFn);
  try {
    switch (body.action) {
      case "connect":
        if (!env.MS_CLIENT_ID) return respond(500, { error: "MS_CLIENT_ID is not set" });
        return respond(200, await connect(env, fetchFn, store));
      case "connect_check":
        return respond(200, await connectCheck(env, fetchFn, store));
      case "mail":
        return respond(200, await mail(env, fetchFn, store, body.days));
      case "check":
        return respond(200, await check(store, Number(body.id), !!body.undo));
      case "transcribe":
        return respond(200, await transcribe(env, fetchFn, body.audio));
      case "reply":
        return respond(200, await reply(env, fetchFn, store, body.messageId, body.text));
      default:
        return respond(400, { error: "Unknown action" });
    }
  } catch (err) {
    return respond(502, { error: String((err && err.message) || err) });
  }
}

if (typeof Deno !== "undefined") {
  Deno.serve((req) => handle(req, Deno.env.toObject(), fetch));
}
