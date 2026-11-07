const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Plain JS in a .ts file, like alexa-work-order; load it without Deno.
function edgeFunction() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'work-tickets', 'index.ts'), 'utf8');
  const ctx = vm.createContext({ Response, Error, Date, JSON, String, Number, Object, Math, console, encodeURIComponent, atob, URLSearchParams, Uint8Array });
  vm.runInContext(src, ctx);
  return ctx;
}

const env = { TICKETS_SECRET: 's3cret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
  MS_CLIENT_ID: 'client', MS_TENANT_ID: 'tenant', DEEPGRAM_API_KEY: 'dg' };

const post = (body, secret = 's3cret') => new Request('https://fn.test', {
  method: 'POST', headers: { 'x-tickets-secret': secret }, body: JSON.stringify(body) });

// Fake Supabase table, Microsoft login, Graph and Deepgram.
function fakeWorld({ kv = {}, pages = [[]], tokenError = null } = {}) {
  const w = { kv: { ...kv }, calls: [] };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  w.fetch = async (url, init = {}) => {
    w.calls.push({ url, init });
    if (url.startsWith('https://db.test/rest/v1/work_tickets_kv')) {
      assert.equal(init.headers.apikey, 'key');
      if (init.method === 'POST') { const b = JSON.parse(init.body); w.kv[b.key] = b.value; return json([], 201); }
      const key = decodeURIComponent(url.match(/key=eq\.([^&]+)/)[1]);
      return json(key in w.kv ? [{ value: w.kv[key] }] : []);
    }
    if (url === 'https://login.microsoftonline.com/tenant/oauth2/v2.0/devicecode')
      return json({ device_code: 'DC', user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, message: 'Go enter ABCD-1234' });
    if (url === 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token') {
      const f = new URLSearchParams(init.body);
      if (tokenError) return json({ error: tokenError }, 400);
      if (f.get('grant_type').endsWith('device_code')) return json({ access_token: 'AT', refresh_token: 'RT1' });
      return json({ access_token: 'AT', refresh_token: f.get('refresh_token') === 'RT1' ? 'RT2' : f.get('refresh_token') });
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) return json({ mail: 'dsmith@iu19.org' });
    if (url.startsWith('https://graph.microsoft.com/v1.0/me/messages?') || url.startsWith('https://next.page/')) {
      const i = url.startsWith('https://next.page/') ? Number(url.split('/').pop()) : 0;
      return json({ value: pages[i], ...(pages[i + 1] ? { '@odata.nextLink': `https://next.page/${i + 1}` } : {}) });
    }
    if (url.includes('/reply')) return new Response(null, { status: 202 });
    if (url.startsWith('https://api.deepgram.com/')) return json({ results: { channels: [{ alternatives: [{ transcript: ' On my way  down. ' }] }] } });
    throw new Error('unexpected ' + url);
  };
  return w;
}

const call = async (body, w, e = env, secret) => {
  const res = await edgeFunction().handle(post(body, secret), e, w.fetch);
  return { status: res.status, body: await res.json() };
};

test('wrong or missing password is refused', async () => {
  const w = fakeWorld();
  assert.equal((await call({ action: 'mail' }, w, env, 'nope')).status, 401);
  assert.equal((await call({ action: 'mail' }, w, { ...env, TICKETS_SECRET: '' })).status, 500);
});

test('connect: hands back the code, then keeps the refresh token once it is entered', async () => {
  const w = fakeWorld();
  const start = await call({ action: 'connect' }, w);
  assert.equal(start.body.code, 'ABCD-1234');
  assert.equal(w.kv.device_code.code, 'DC');
  const done = await call({ action: 'connect_check' }, w);
  assert.equal(done.body.connected, true);
  assert.deepEqual(w.kv.microsoft, { refresh_token: 'RT1' });
});

test('mail: helpdesk emails only, all pages, trimmed, with the checked list; rotated token kept', async () => {
  const msg = (id) => ({ id, subject: `[[TIC #${id}]] x`, toRecipients: [{ emailAddress: { address: 'dsmith@iu19.org' } }], ccRecipients: [],
    receivedDateTime: '2026-11-05T14:00:00Z', body: { content: 'y'.repeat(9000) } });
  const w = fakeWorld({ kv: { microsoft: { refresh_token: 'RT1' }, checked: { 1478: '2026-11-05T15:00:00Z' } }, pages: [[msg('1')], [msg('2')]] });
  const out = await call({ action: 'mail', days: 30 }, w);
  assert.equal(out.status, 200);
  assert.equal(out.body.me, 'dsmith@iu19.org');
  assert.deepEqual(out.body.mails.map((m) => m.messageId), ['1', '2']);
  assert.equal(out.body.mails[0].text.length, 6000);
  assert.deepEqual(out.body.mails[0].to, ['dsmith@iu19.org']);
  assert.deepEqual(out.body.checked, { 1478: '2026-11-05T15:00:00Z' });
  const list = w.calls.find((c) => c.url.includes('/me/messages?')).url;
  assert.match(decodeURIComponent(list.replace(/\+/g, ' ')), /from\/emailAddress\/address eq 'helpdesk@iu19.org' and receivedDateTime ge /);
  assert.equal(w.kv.microsoft.refresh_token, 'RT2');
});

test('mail before connecting says how to fix it', async () => {
  const out = await call({ action: 'mail' }, fakeWorld());
  assert.equal(out.status, 502);
  assert.match(out.body.error, /Connect Outlook/);
});

test('check and undo', async () => {
  const w = fakeWorld();
  await call({ action: 'check', id: 1478 }, w);
  assert.ok(w.kv.checked['1478']);
  await call({ action: 'check', id: 1478, undo: true }, w);
  assert.deepEqual(w.kv.checked, {});
  assert.equal((await call({ action: 'check' }, w)).status, 502);
});

test('reply goes to that email as a comment, so Lansweeper adds it to the ticket', async () => {
  const w = fakeWorld({ kv: { microsoft: { refresh_token: 'RT2' } } });
  const out = await call({ action: 'reply', messageId: 'AAMk/1=', text: ' On my way. ' }, w);
  assert.equal(out.body.ok, true);
  const r = w.calls.find((c) => c.url.includes('/reply'));
  assert.equal(r.url, 'https://graph.microsoft.com/v1.0/me/messages/AAMk%2F1%3D/reply');
  assert.deepEqual(JSON.parse(r.init.body), { comment: 'On my way.' });
});

test('transcribe returns the words', async () => {
  const out = await call({ action: 'transcribe', audio: Buffer.from('abcd').toString('base64') }, fakeWorld());
  assert.equal(out.body.heard, 'On my way down.');
});
