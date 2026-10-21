const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The Supabase function is plain JS in a .ts file; load it without Deno.
function edgeFunction() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'alexa-work-order', 'index.ts'), 'utf8');
  const ctx = vm.createContext({ Response, Error, Date, JSON, String, console });
  vm.runInContext(src, ctx);
  return ctx;
}

const skill = require('../alexa/skill.js');
const env = { ALEXA_SHARED_SECRET: 's3cret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key' };

function post(body, secret = 's3cret') {
  return new Request('https://fn.test', {
    method: 'POST', headers: { 'x-alexa-secret': secret }, body: JSON.stringify(body),
  });
}

test('spoken text becomes a new ticket from Alexa, location taken from the sentence', () => {
  const { ticketFromSpeech } = edgeFunction();
  const row = ticketFromSpeech({ text: '  regrip the house ball at   south side ', location: 'Valley' },
    new Date('2026-10-21T12:00:00Z'));
  assert.equal(row.title, 'Regrip the house ball at south side');
  assert.equal(row.location, 'South Side');
  assert.equal(row.submitted_by, 'Alexa');
  assert.equal(row.status, 'new');
  assert.equal(row.priority, 'normal');
});

test('location falls back to the Echo default, and junk defaults become none', () => {
  const { ticketFromSpeech } = edgeFunction();
  const now = new Date();
  assert.equal(ticketFromSpeech({ text: 'order tape', location: 'Valley' }, now).location, 'Valley');
  assert.equal(ticketFromSpeech({ text: 'order tape', location: '' }, now).location, null);
  assert.equal(ticketFromSpeech({ text: 'valley and south side need tape' }, now).location, 'Both');
  assert.throws(() => ticketFromSpeech({ text: '   ' }, now));
});

test('wrong password is refused without touching the database', async () => {
  const { handle } = edgeFunction();
  let called = false;
  const res = await handle(post({ text: 'x' }, 'nope'), env, async () => { called = true; });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('right password inserts into tickets with the service key', async () => {
  const { handle } = edgeFunction();
  let seen;
  const res = await handle(post({ text: 'fix the drill press' }), env, async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify([{ id: 'abc' }]), { status: 201 });
  });
  assert.equal(res.status, 200);
  assert.equal(seen.url, 'https://db.test/rest/v1/tickets');
  assert.equal(seen.init.headers.apikey, 'key');
  assert.equal(JSON.parse(seen.init.body).title, 'Fix the drill press');
  assert.equal((await res.json()).id, 'abc');
});

const intent = (value) => ({
  request: { type: 'IntentRequest', intent: { name: 'CreateWorkOrderIntent', slots: { request: { name: 'request', value } } } },
});

test('skill: a full sentence creates the work order and reads it back', async () => {
  let body;
  const out = await skill.handle(intent('lane 3 ball return is jammed'), async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ title: 'Lane 3 ball return is jammed' }), { status: 200 });
  });
  assert.equal(body.text, 'lane 3 ball return is jammed');
  assert.match(out.response.outputSpeech.text, /Work order added: Lane 3 ball return is jammed/);
  assert.equal(out.response.shouldEndSession, true);
});

test('skill: opening it asks a plain question and keeps listening', async () => {
  const out = await skill.handle({ request: { type: 'LaunchRequest' } }, async () => assert.fail('should not post'));
  assert.match(out.response.outputSpeech.text, /What's the work order for\?/);
  assert.equal(out.response.shouldEndSession, false);
  assert.equal(out.response.directives, undefined);
});

test('skill: a work order with nothing in it asks for the request', async () => {
  const out = await skill.handle(intent(undefined), async () => assert.fail('should not post'));
  assert.equal(out.response.directives[0].type, 'Dialog.ElicitSlot');
  assert.equal(out.response.directives[0].slotToElicit, 'request');
});

test('skill: a failed save tells the person to use the app', async () => {
  const out = await skill.handle(intent('x'), async () => new Response('nope', { status: 500 }));
  assert.match(out.response.outputSpeech.text, /couldn't add/);
});

test('skill: works where Node has no built-in fetch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'alexa', 'skill.js'), 'utf8');
  const mod = { exports: {} };
  vm.runInContext(src, vm.createContext({ module: mod, exports: mod.exports, require }));
  assert.equal(typeof mod.exports.handler, 'function');
});

test('password match ignores pasted spaces and quotes', async () => {
  const { handle } = edgeFunction();
  const res = await handle(post({ text: 'x' }, ' s3cret '), { ...env, ALEXA_SHARED_SECRET: '"s3cret"' },
    async () => new Response('[{"id":"a"}]', { status: 201 }));
  assert.equal(res.status, 200);
});

function fakeClaude(reply, seen = {}) {
  return { beta: { messages: { create: async (params) => {
    seen.params = params;
    if (reply instanceof Error) throw reply;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
  } } } };
}

function insertSpy(seen) {
  return async (url, init) => {
    seen.row = JSON.parse(init.body);
    return new Response(JSON.stringify([{ id: 'abc' }]), { status: 201 });
  };
}

test('AI: Claude fills in title, details, category, priority, due date and customer', async () => {
  const { handle } = edgeFunction();
  const seen = {};
  const claude = fakeClaude({
    title: 'Plug and redrill Bob Smith\'s ball', details: 'Customer wants it before league.',
    category: 'Customer', priority: 'high', location: 'South Side', due_date: '2026-10-23',
    customer_name: 'Bob Smith', customer_phone: '555-1234',
  }, seen);
  const res = await handle(post({ text: 'bob smith needs his ball plugged and redrilled by friday at south side 555 1234' }),
    env, insertSpy(seen), claude);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ai, true);
  assert.equal(seen.row.title, "Plug and redrill Bob Smith's ball");
  assert.equal(seen.row.category, 'Customer');
  assert.equal(seen.row.priority, 'high');
  assert.equal(seen.row.location, 'South Side');
  assert.equal(seen.row.due_date, '2026-10-23');
  assert.equal(seen.row.status, 'new');
  assert.equal(seen.row.submitted_by, 'Alexa');
  assert.match(seen.row.details, /^Customer: Bob Smith\nPhone: 555-1234\n\nCustomer wants it/);
  assert.match(seen.row.details, /Said: "bob smith needs/);
  assert.equal(seen.params.model, 'claude-opus-5-5');
  assert.equal(seen.params.output_config.format.type, 'json_schema');
});

test('AI: values the tickets table would reject fall back to the plain ticket', async () => {
  const { handle } = edgeFunction();
  const seen = {};
  const claude = fakeClaude({ title: '', details: '', category: 'Lanes', priority: 'asap',
    location: 'Not said', due_date: 'friday', customer_name: '', customer_phone: '' });
  await handle(post({ text: 'fix the drill press', location: 'Valley' }), env, insertSpy(seen), claude);
  assert.equal(seen.row.title, 'Fix the drill press');
  assert.equal(seen.row.category, null);
  assert.equal(seen.row.priority, 'normal');
  assert.equal(seen.row.location, 'Valley');
  assert.equal(seen.row.due_date, null);
});

test('AI: if Claude fails or is slow, the plain ticket is still created', async () => {
  const { handle } = edgeFunction();
  const seen = {};
  const res = await handle(post({ text: 'order more tape' }), env, insertSpy(seen), fakeClaude(new Error('timeout')));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ai, false);
  assert.equal(seen.row.title, 'Order more tape');
});
