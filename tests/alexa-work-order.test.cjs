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

const env = { ALEXA_SHARED_SECRET: 's3cret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
  SPECCY_URL: 'https://speccy.test', SPECCY_KEY: 'pub' };

function post(body, secret = 's3cret') {
  return new Request('https://fn.test', {
    method: 'POST', headers: { 'x-alexa-secret': secret }, body: JSON.stringify(body),
  });
}

// A fake Supabase: customer lookups answer from `customers`, ticket inserts are kept.
function fakeDb(customers = []) {
  const db = { inserted: [], lookups: 0 };
  db.fetch = async (url, init = {}) => {
    if (url.startsWith('https://speccy.test/')) {
      db.speccy = (db.speccy || 0) + 1;
      return new Response(JSON.stringify(db.speccyRows || []), { status: 200 });
    }
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
  return { messages: { create: async (params) => {
    seen.push(params);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }] };
  } } };
}
const blank = { intent: 'work_order', items: [], customer_name: '', customer_phone: '', for_shop: false, work: '', title: '', details: '',
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
  assert.equal(seen[0].model, 'claude-haiku-5-5');
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
  assert.equal(db.speccy, 1); // and the spec sheets
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

// --- Square invoices ---------------------------------------------------------

// A fake Square plus Supabase: records every Square call.
function fakeShop({ squareCustomers = [], catalog = [], aliases = [], speccy = [], directory = [] } = {}) {
  const shop = { calls: [], inserted: [] };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  shop.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith('https://speccy.test/')) return json(speccy);
    if (url.startsWith('https://db.test/rest/v1/voice_aliases')) return json(aliases);
    if (url.startsWith('https://db.test/rest/v1/customer_directory')) return json(directory);
    if (url.startsWith('https://db.test/')) return json([]);
    const path = url.replace('https://connect.squareup.com/v2', '');
    shop.calls.push({ path, body, headers: init.headers });
    if (path === '/locations') return json({ locations: [
      { id: 'LS', name: 'Pro Shop South Side', status: 'ACTIVE' }, { id: 'LV', name: 'Pro Shop Valley', status: 'ACTIVE' }] });
    if (path === '/customers/search') return json({ customers: squareCustomers });
    if (path === '/customers') return json({ customer: { id: 'CNEW', given_name: body.given_name } });
    if (path === '/catalog/search-catalog-items') {
      const q = body.text_filter.toLowerCase();
      return json({ items: catalog.filter((i) => q.split(' ').some((w) => i.item_data.name.toLowerCase().includes(w))) });
    }
    if (path === '/orders') return json({ order: { id: 'O1', total_money: { amount: 28995, currency: 'USD' } } });
    if (path === '/invoices') return json({ invoice: { id: 'I1', status: 'DRAFT' } });
    return json({ errors: [{ detail: 'unexpected ' + path }] }, 400);
  };
  return shop;
}

const item = (id, name, variations) => ({ type: 'ITEM', id, item_data: { name,
  variations: variations.map(([vid, vname]) => ({ id: vid, item_variation_data: { name: vname } })) } });
const CATALOG = [
  item('tag', 'Motiv Tag', [['tag14', '14 lb'], ['tag15', '15 lb']]),
  item('drill', 'Drilling - Standard', [['drill1', 'Regular']]),
  item('slug', 'Thumb Slug + Insert Combo', [['slug1', 'Regular']]),
];
const sqEnv = { ...env, SQUARE_ACCESS_TOKEN: 'sq' };

async function sayShop(fn, shop, text, state, claude) {
  const res = await fn.handle(post({ text, state, location: 'Valley' }), sqEnv, shop.fetch, claude);
  assert.equal(res.status, 200);
  return res.json();
}

test('invoice: items matched by name, alias and weight; a draft for the Square customer', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({
    catalog: CATALOG,
    aliases: [{ spoken: 'standard drill', square_item: 'Drilling - Standard' }, { spoken: 'slug combo', square_item: 'Thumb Slug + Insert Combo' }],
    directory: [{ customer_name: 'Doug Smith', phone: '555-123-4567' }],
    squareCustomers: [{ id: 'C1', given_name: 'Doug', family_name: 'Smith' }],
  });
  const claude = fakeClaude([{ ...blank, intent: 'invoice', customer_name: 'Doug Smith',
    items: [{ spoken: '14 lb Motiv Tag', quantity: 1 }, { spoken: 'standard drill', quantity: 1 }, { spoken: 'slug combo', quantity: 1 }] }]);
  const out = await sayShop(fn, shop, 'create an invoice for doug smith for a 14 pound motiv tag a standard drill and a slug combo', '', claude);
  assert.equal(out.done, true);
  assert.equal(out.say, 'Draft invoice in Square for Doug Smith: Motiv Tag 14 lb, Drilling - Standard, Thumb Slug + Insert Combo, $289.95.');
  const call = (p) => shop.calls.find((c) => c.path === p);
  assert.deepEqual(call('/customers/search').body.query.filter.phone_number, { fuzzy: '5551234567' });
  const order = call('/orders').body.order;
  assert.equal(order.location_id, 'LV');
  assert.equal(order.customer_id, 'C1');
  assert.deepEqual(order.line_items, [
    { catalog_object_id: 'tag14', quantity: '1' }, { catalog_object_id: 'drill1', quantity: '1' }, { catalog_object_id: 'slug1', quantity: '1' }]);
  const inv = call('/invoices').body.invoice;
  assert.equal(inv.order_id, 'O1');
  assert.equal(inv.primary_recipient.customer_id, 'C1');
  assert.equal(inv.delivery_method, 'SHARE_MANUALLY');
  assert.equal(inv.accepted_payment_methods.card, true);
  assert.equal(shop.calls.some((c) => /publish/.test(c.path)), false); // drafts only
  assert.equal(call('/locations').headers['Square-Version'], '2026-09-16');
  assert.equal(call('/locations').headers.Authorization, 'Bearer sq');
});

test('invoice: asks who, then what, across turns', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ catalog: CATALOG, directory: [{ customer_name: 'Ann Lee', phone: '555-000-1111' }],
    squareCustomers: [{ id: 'C2', family_name: 'Lee' }] });
  const claude = fakeClaude([
    { ...blank, intent: 'invoice' },
    { ...blank, intent: 'invoice', customer_name: 'Ann Lee' },
    { ...blank, intent: 'invoice', customer_name: 'Ann Lee', items: [{ spoken: 'Motiv Tag', quantity: 1 }] },
  ]);
  let out = await sayShop(fn, shop, 'create an invoice', '', claude);
  assert.equal(out.say, "Who's the invoice for?");
  out = await sayShop(fn, shop, 'ann lee', out.state, claude);
  assert.equal(out.say, "What's on the invoice for Ann Lee?");
  out = await sayShop(fn, shop, 'a motiv tag', out.state, claude);
  assert.equal(out.say, 'Draft invoice in Square for Ann Lee: Motiv Tag 14 lb, $289.95. I picked 14 lb for the Motiv Tag, so check it in Square.');
});

test('invoice: someone not in Square is not invoiced, and told how to add them', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ catalog: CATALOG, directory: [{ customer_name: 'Bill Jones', phone: '555-222-3333' }] });
  const claude = fakeClaude([{ ...blank, intent: 'invoice', customer_name: 'Bill Jones', items: [{ spoken: 'Motiv Tag', quantity: 1 }] }]);
  const out = await sayShop(fn, shop, 'invoice for bill jones for a motiv tag', '', claude);
  assert.match(out.say, /^Bill Jones isn't in Square yet/);
  assert.equal(shop.calls.some((c) => c.path === '/orders' || c.path === '/customers'), false);
});

test('new customer: details from the spec sheets, added to Square, then invoiced', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ catalog: CATALOG, speccy: [{ name: 'William Jones', phone: '(555) 444-9999' }] });
  const claude = fakeClaude([{ ...blank, intent: 'new_customer', customer_name: 'Bill Jones',
    items: [{ spoken: '15 pound motiv tag', quantity: 1 }] }]);
  const out = await sayShop(fn, shop, 'create bill jones as a new customer and an invoice for a 15 pound motiv tag', '', claude);
  // "Bill" isn't "William": no spec sheet match, so he's added as said, without a phone.
  assert.match(out.say, /I added Bill Jones to Square without a phone number\.$/);
  const created = shop.calls.find((c) => c.path === '/customers').body;
  assert.equal(created.given_name, 'Bill');
  assert.equal(created.family_name, 'Jones');
  assert.equal(shop.calls.find((c) => c.path === '/orders').body.order.line_items[0].catalog_object_id, 'tag15');
});

test('new customer: a spec sheet match supplies the full name and phone', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ catalog: CATALOG, speccy: [{ name: 'Billy Jones', phone: '(555) 444-9999' }] });
  const claude = fakeClaude([{ ...blank, intent: 'new_customer', customer_name: 'Bill Jones',
    items: [{ spoken: 'motiv tag', quantity: 1 }] }]);
  const out = await sayShop(fn, shop, 'new customer bill jones invoice motiv tag', '', claude);
  assert.match(out.say, /^Draft invoice in Square for Billy Jones: .* I added Billy Jones to Square\.$/);
  const created = shop.calls.find((c) => c.path === '/customers').body;
  assert.equal(created.phone_number, '+15554449999');
});

test('invoice: nothing found in Square means no invoice', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ catalog: CATALOG, directory: [{ customer_name: 'Ann Lee', phone: '555-000-1111' }],
    squareCustomers: [{ id: 'C2' }] });
  const claude = fakeClaude([{ ...blank, intent: 'invoice', customer_name: 'Ann Lee', items: [{ spoken: 'wrist brace', quantity: 1 }] }]);
  const out = await sayShop(fn, shop, 'invoice ann lee wrist brace', '', claude);
  assert.equal(out.say, "I couldn't find wrist brace in Square, so I didn't make the invoice.");
  assert.equal(shop.calls.some((c) => c.path === '/invoices'), false);
});

test('invoice: without the AI step, or without Square, it says so', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  let out = await sayShop(fn, shop, 'create an invoice for ann lee for a motiv tag', '', null);
  assert.match(out.say, /only make invoices when the AI step is working/);
  const claude = fakeClaude([{ ...blank, intent: 'invoice', customer_name: 'Ann Lee', items: [{ spoken: 'tag', quantity: 1 }] }]);
  const res = await fn.handle(post({ text: 'invoice ann lee tag' }), env, shop.fetch, claude);
  assert.match((await res.json()).say, /Square isn't connected yet/);
});

test('invoice: a Square error is spoken, not swallowed', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ directory: [{ customer_name: 'Ann Lee', phone: '555-000-1111' }] });
  const inner = shop.fetch;
  shop.fetch = async (url, init) => url.endsWith('/locations')
    ? new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', detail: 'Bad token' }] }), { status: 401 })
    : inner(url, init);
  const claude = fakeClaude([{ ...blank, intent: 'invoice', customer_name: 'Ann Lee', items: [{ spoken: 'tag', quantity: 1 }] }]);
  const out = await sayShop(fn, shop, 'invoice ann lee tag', '', claude);
  assert.equal(out.say, "Sorry, Square had a problem, so there's no invoice. Square said 401: Bad token");
});
