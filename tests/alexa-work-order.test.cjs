const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The Supabase function is plain JS in a .ts file; load it without Deno.
function edgeFunction() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'alexa-work-order', 'index.ts'), 'utf8');
  const ctx = vm.createContext({ Response, Error, Date, JSON, String, Map, Promise, console, encodeURIComponent });
  vm.runInContext(src, ctx);
  return ctx;
}

const env = { ALEXA_SHARED_SECRET: 's3cret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key' };

function post(body, secret = 's3cret') {
  return new Request('https://fn.test', {
    method: 'POST', headers: { 'x-alexa-secret': secret }, body: JSON.stringify(body),
  });
}

// A fake Supabase: customer lookups answer from `customers`, ticket inserts are kept.
function fakeDb(customers = []) {
  const db = { inserted: [], lookups: 0 };
  db.fetch = async (url, init = {}) => {
    if (url.endsWith('/rest/v1/tickets')) {
      db.inserted.push(JSON.parse(init.body));
      return new Response('[{"id":"t1"}]', { status: 201 });
    }
    db.lookups += 1;
    assert.equal(init.headers.apikey, 'key');
    const table = url.split('/rest/v1/')[1].split('?')[0];
    return new Response(JSON.stringify(customers.filter((c) => (c.table || 'customer_directory') === table)), { status: 200 });
  };
  return db;
}

async function say(fn, db, text, state, claude, location) {
  const res = await fn.handle(post({ text, state, location }), env, db.fetch, claude);
  assert.equal(res.status, 200);
  return res.json();
}

// --- without Claude: simple rules ------------------------------------------

test('rules: one breath, "for NAME to WORK", looks up the phone and adds the ticket', async () => {
  const fn = edgeFunction();
  const db = fakeDb([{ customer_name: 'Doug Smith', phone: '555-123-4567' }]);
  const out = await say(fn, db, 'create a work order for doug smith to plug his 14 pound ball');
  assert.equal(out.done, true);
  assert.equal(out.say, 'Work order added for Doug Smith: Plug his 14 pound ball.');
  const row = db.inserted[0];
  assert.equal(row.title, 'Plug his 14 pound ball');
  assert.match(row.details, /^Customer: Doug Smith\nPhone: 555-123-4567\n\nSaid: "/);
  assert.equal(row.category, 'Customer');
  assert.equal(row.status, 'new');
  assert.equal(row.submitted_by, 'Alexa');
});

test('rules: asks who, then what, carrying the state between turns', async () => {
  const fn = edgeFunction();
  const db = fakeDb([{ customer_name: 'Doug Smith', phone: '5551234567', table: 'orders' }]);
  let out = await say(fn, db, '');
  assert.equal(out.done, false);
  assert.equal(out.say, "Who's it for, and what are we doing?");

  // A bare answer to "who and what" is taken as the work, so ask the name.
  out = await say(fn, db, 'for doug smith', out.state);
  assert.equal(out.done, false);
  assert.equal(out.say, 'What are we doing for Doug Smith?');

  out = await say(fn, db, 'plug and redrill his ball', out.state);
  assert.equal(out.done, true);
  assert.equal(db.inserted.length, 1);
  assert.match(db.inserted[0].details, /^Customer: Doug Smith\nPhone: 555-123-4567/);
  assert.equal(db.inserted[0].title, 'Plug and redrill his ball');
});

test('rules: "NAME, WORK" answers both questions at once', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  let out = await say(fn, db, '');
  out = await say(fn, db, 'doug smith, plug his ball', out.state);
  assert.equal(out.say, 'Work order added for Doug Smith: Plug his ball.');
});

test('rules: "for NAME" alone asks only what we are doing', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  const out = await say(fn, db, 'create a work order for doug smith');
  assert.equal(out.done, false);
  assert.equal(out.say, 'What are we doing for Doug Smith?');
  assert.equal(db.inserted.length, 0);
});

// --- customer matching -----------------------------------------------------

test("names are title-cased, O'Brien and hyphens too", async () => {
  const fn = edgeFunction();
  const out = await say(fn, fakeDb(), "for mary o'brien-smith");
  assert.equal(out.say, "What are we doing for Mary O'Brien-Smith?");
});

test('lookup: Doug finds Douglas with the same last name, using the list spelling', () => {
  const fn = edgeFunction();
  const m = fn.matchCustomer('Doug Smith', [
    { customer_name: 'Douglas Smith', phone: '(555) 123-4567' },
    { customer_name: 'Dana Smith', phone: '555-999-0000' },
  ]);
  assert.equal(m.found, 1);
  assert.equal(m.name, 'Douglas Smith');
  assert.equal(m.phone, '555-123-4567');
});

test('lookup: an exact name beats a close one; the same number twice is one match', () => {
  const fn = edgeFunction();
  const m = fn.matchCustomer('doug smith', [
    { customer_name: 'Douglas Smith', phone: '555-000-1111' },
    { customer_name: 'Doug Smith', phone: '555-123-4567' },
    { customer_name: 'DOUG  SMITH', phone: '5551234567' },
  ]);
  assert.equal(m.found, 1);
  assert.equal(m.phone, '555-123-4567');
});

test('lookup: two different numbers for the name leaves the phone off and says so', async () => {
  const fn = edgeFunction();
  const db = fakeDb([
    { customer_name: 'Doug Smith', phone: '555-123-4567' },
    { customer_name: 'Doug Smith', phone: '555-765-4321', table: 'appointments' },
  ]);
  const out = await say(fn, db, 'for doug smith to resurface his ball');
  assert.equal(out.done, true);
  assert.match(out.say, /more than one Doug Smith/);
  assert.match(db.inserted[0].details, /^Customer: Doug Smith\nPhone: \n/);
});

// --- with Claude -------------------------------------------------------------

function fakeClaude(replies, seen = []) {
  return { beta: { messages: { create: async (params) => {
    seen.push(params);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }] };
  } } } };
}
const blank = { customer_name: '', customer_phone: '', for_shop: false, work: '', title: '', details: '',
  category: 'Other', priority: 'normal', due_date: '' };

test('AI: one breath becomes a tidy ticket with title, priority and due date', async () => {
  const fn = edgeFunction();
  const db = fakeDb([{ customer_name: 'Doug Smith', phone: '555-123-4567' }]);
  const seen = [];
  const claude = fakeClaude([{ ...blank, customer_name: 'Doug Smith', work: 'plug his 14 pound ball',
    title: 'Plug 14 lb ball', category: 'Customer', priority: 'high', due_date: '2026-10-23',
    details: 'Needs it for Thursday league.' }], seen);
  const out = await say(fn, db, 'work order for doug smith to plug his fourteen pound ball for thursday league', '', claude);
  assert.equal(out.say, 'Work order added for Doug Smith: Plug 14 lb ball.');
  const row = db.inserted[0];
  assert.equal(row.priority, 'high');
  assert.equal(row.due_date, '2026-10-23');
  assert.match(row.details, /^Customer: Doug Smith\nPhone: 555-123-4567\n\nNeeds it for Thursday league\.\n\nSaid: "/);
  assert.equal(seen[0].model, 'claude-opus-5-5');
  assert.equal(seen[0].output_config.format.type, 'json_schema');
});

test('AI: name first, then the work; Claude sees the earlier answers', async () => {
  const fn = edgeFunction();
  const db = fakeDb([{ customer_name: 'Doug Smith', phone: '555-123-4567' }]);
  const seen = [];
  const claude = fakeClaude([
    { ...blank, customer_name: 'Doug Smith', category: 'Customer' },
    { ...blank, customer_name: 'Doug Smith', work: 'new grips', title: 'Install new grips', category: 'Customer' },
  ], seen);
  let out = await say(fn, db, 'doug smith', '', claude);
  assert.equal(out.say, 'What are we doing for Doug Smith?');
  out = await say(fn, db, 'new grips', out.state, claude);
  assert.equal(out.say, 'Work order added for Doug Smith: Install new grips.');
  assert.match(seen[1].messages[0].content, /What are we doing\?[\s\S]*1\. doug smith\n2\. new grips/);
  assert.equal(db.lookups, 3); // three tables, once
});

test('AI: a shop job needs no customer', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  const claude = fakeClaude([{ ...blank, for_shop: true, work: 'lane 3 ball return jammed',
    title: 'Fix lane 3 ball return', category: 'Equipment', priority: 'urgent' }]);
  const out = await say(fn, db, 'the ball return on lane 3 is jammed', '', claude, 'Valley');
  assert.equal(out.say, 'Work order added: Fix lane 3 ball return.');
  assert.equal(db.inserted[0].category, 'Equipment');
  assert.equal(db.inserted[0].location, 'Valley');
});

test('AI: if Claude fails, the rules still make the ticket', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  const out = await say(fn, db, 'for doug smith to oil his ball', '', fakeClaude([new Error('timeout')]));
  assert.equal(out.done, true);
  assert.equal(db.inserted[0].title, 'Oil his ball');
});

test('AI: values the tickets table would reject are dropped', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  const claude = fakeClaude([{ ...blank, customer_name: 'Ann Lee', work: 'grips', title: '',
    category: 'Lanes', priority: 'asap', due_date: 'friday' }]);
  await say(fn, db, 'ann lee grips', '', claude);
  const row = db.inserted[0];
  assert.equal(row.title, 'Grips');
  assert.equal(row.category, 'Customer');
  assert.equal(row.priority, 'normal');
  assert.equal(row.due_date, null);
});

// --- HTTP ------------------------------------------------------------------

test('wrong password is refused without touching the database', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  const res = await fn.handle(post({ text: 'x' }, 'nope'), env, db.fetch);
  assert.equal(res.status, 401);
  assert.equal(db.inserted.length + db.lookups, 0);
});

test('password match ignores pasted spaces and quotes', async () => {
  const fn = edgeFunction();
  const db = fakeDb();
  const res = await fn.handle(post({ text: 'for ann lee to drill' }, ' s3cret '),
    { ...env, ALEXA_SHARED_SECRET: '"s3cret"' }, db.fetch);
  assert.equal(res.status, 200);
});

test('location comes from the words, else the device default', () => {
  const fn = edgeFunction();
  assert.equal(fn.pickLocation('at south side', 'Valley'), 'South Side');
  assert.equal(fn.pickLocation('order tape', 'Valley'), 'Valley');
  assert.equal(fn.pickLocation('order tape', ''), null);
});
