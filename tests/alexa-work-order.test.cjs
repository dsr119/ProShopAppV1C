const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The Supabase function is plain JS in a .ts file; load it without Deno.
function edgeFunction() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'alexa-work-order', 'index.ts'), 'utf8');
  const ctx = vm.createContext({ Response, Error, Date, JSON, String, Map, Set, Promise, Math, console, encodeURIComponent });
  vm.runInContext(src, ctx);
  return ctx;
}

const env = { ALEXA_SHARED_SECRET: 's3cret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
  SPECCY_URL: 'https://speccy.test', SPECCY_KEY: 'pub', SQUARE_ACCESS_TOKEN: 'sq' };

function post(body, secret = 's3cret') {
  return new Request('https://fn.test', {
    method: 'POST', headers: { 'x-alexa-secret': secret }, body: JSON.stringify(body),
  });
}

const item = (id, name, variations) => ({ type: 'ITEM', id, item_data: { name,
  variations: variations.map(([vid, vname, cents]) => ({ id: vid, item_variation_data: { name: vname, price_money: { amount: cents, currency: 'USD' } } })) } });
const CATALOG = [
  item('phaze', 'Storm Phaze 6', [['phaze14', '14 lb', 17995], ['phaze15', '15 lb', 17995]]),
  item('gb5', 'Ebonite Game Breaker 5 Solid', [['gb5-15', '15 lb', 14995]]),
  item('drill', 'Drilling - Standard', [['drill1', 'Regular', 4000]]),
];

// A fake shop: Supabase tables, Speccy and Square. Records what was written.
function fakeShop({ directory = [], orders = [], speccy = [], squareCustomers = [], catalog = CATALOG, aliases = [] } = {}) {
  const shop = { tickets: [], reviews: [], calls: [], lookups: 0 };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  shop.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith('https://speccy.test/')) { shop.lookups += 1; return json(speccy); }
    if (url.startsWith('https://db.test/')) {
      assert.equal(init.headers.apikey, 'key');
      const table = url.split('/rest/v1/')[1].split('?')[0];
      if (table === 'tickets') { shop.tickets.push(body); return json([{ id: 't1' }], 201); }
      if (table === 'voice_review') { shop.reviews.push(body); return json([], 201); }
      if (table === 'voice_aliases') return json(aliases);
      shop.lookups += 1;
      return json({ customer_directory: directory, orders, appointments: [] }[table] || []);
    }
    const p = url.replace('https://connect.squareup.com/v2', '');
    shop.calls.push({ path: p, body, headers: init.headers });
    if (p === '/locations') return json({ locations: [
      { id: 'LS', name: 'Pro Shop South Side', status: 'ACTIVE' }, { id: 'LV', name: 'Pro Shop Valley', status: 'ACTIVE' }] });
    if (p === '/customers/search') return json({ customers: squareCustomers.filter((c) => c.phone === body.query.filter.phone_number.fuzzy) });
    if (p === '/customers') return json({ customer: { id: 'CNEW', given_name: body.given_name, family_name: body.family_name } });
    if (p === '/catalog/search-catalog-items') {
      const q = body.text_filter.toLowerCase();
      return json({ items: catalog.filter((i) => q.split(' ').some((w) => i.item_data.name.toLowerCase().includes(w))) });
    }
    if (p === '/orders') return json({ order: { id: 'O1', total_money: { amount: 21995, currency: 'USD' } } });
    if (p === '/invoices') return json({ invoice: { id: 'I1', status: 'DRAFT' } });
    return json({ errors: [{ detail: 'unexpected ' + p }] }, 400);
  };
  return shop;
}

async function say(fn, shop, text, state, claude, location = 'Valley') {
  const res = await fn.handle(post({ text, state, location }), env, shop.fetch, claude);
  assert.equal(res.status, 200);
  return res.json();
}

// --- Claude runs the conversation ----------------------------------------------

// A scripted Claude: each call answers with the next list of blocks.
let ids = 0;
const use = (name, input) => ({ type: 'tool_use', id: `tu${++ids}`, name, input });
const speak = (s, done = false) => use('speak', { say: s, done });
function fakeClaude(script, seen = []) {
  return { messages: { create: async (params) => {
    seen.push(JSON.parse(JSON.stringify(params)));
    const next = script.shift();
    if (!next) throw new Error('script ran out');
    if (next instanceof Error) throw next;
    return { stop_reason: 'tool_use', content: next };
  } } };
}
// The tool results Claude was sent on a call.
const results = (params) => params.messages[params.messages.length - 1].content
  .filter((b) => b.type === 'tool_result').map((b) => JSON.parse(b.content === 'said' ? '"said"' : b.content));

test('opening the conversation (the laptop test) needs no Claude call', async () => {
  const fn = edgeFunction();
  const seen = [];
  const out = await say(fn, fakeShop(), '', undefined, fakeClaude([], seen));
  assert.deepEqual([out.done, out.say], [false, 'What do you need?']);
  assert.equal(seen.length, 0);
  assert.equal(JSON.parse(out.state).v, 2);
});

test('invoice: Claude asks for the last four, copes with a partial answer, and makes a draft', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({
    directory: [{ customer_name: 'Doug Smith', phone: '570-766-8210' }],
    speccy: [{ name: 'Doug Smith', phone: '570-555-1234' }],
    squareCustomers: [{ id: 'C1', given_name: 'Doug', family_name: 'Smith', phone: '5707668210' }],
  });
  const seen = [];
  const claude = fakeClaude([
    [use('find_customer', { name: 'Doug Smith' })],
    [speak('I found two Doug Smiths. What are the last four of the phone?')],
    [speak('I only caught 8 1 0. What are all four digits?')],
    [speak("Got it, the one ending 8210. What's on the invoice?")],
    [use('search_square_items', { said: '15 pound Phaze' })],
    [use('create_draft_invoice', { customer_name: 'Doug Smith', phone: '570-766-8210', lines: [{ variation_id: 'phaze15', quantity: 1 }] })],
    [speak('Draft invoice in Square for Doug Smith: Storm Phaze 6, 15 pound, $219.95.', true)],
  ], seen);

  let out = await say(fn, shop, 'Create an invoice for Doug Smith.', undefined, claude);
  assert.equal(out.say, 'I found two Doug Smiths. What are the last four of the phone?');
  assert.equal(out.done, false);
  assert.deepEqual(results(seen[1])[0].matches.map((m) => m.phone), ['570-766-8210', '570-555-1234']);
  assert.equal(seen[0].model, 'claude-haiku-5-5');
  assert.deepEqual(seen[0].tool_choice, { type: 'any' });
  assert.match(seen[0].system, /bowling pro shop/);

  out = await say(fn, shop, '8-1-0.', out.state, claude);
  assert.equal(out.say, 'I only caught 8 1 0. What are all four digits?');
  // What was said after speak joins speak's tool result, so the turns alternate.
  const lastMsg = seen[2].messages[seen[2].messages.length - 1];
  assert.equal(lastMsg.role, 'user');
  assert.deepEqual(lastMsg.content.map((b) => b.type), ['tool_result', 'text']);
  assert.equal(lastMsg.content[1].text, '8-1-0.');

  out = await say(fn, shop, '8210', out.state, claude);
  out = await say(fn, shop, 'a 15 pound Phaze', out.state, claude);
  assert.equal(out.done, true);
  assert.equal(out.state, undefined);
  assert.match(out.say, /^Draft invoice in Square for Doug Smith/);
  const found = results(seen[5])[0].items;
  assert.equal(found[0].item, 'Storm Phaze 6');
  assert.deepEqual(found[0].variations[1], { variation_id: 'phaze15', name: '15 lb', price: '$179.95' });
  assert.deepEqual(results(seen[6])[0], { ok: true, draft_invoice: 'I1', total: '$219.95', added_to_square: false, customer_in_square: 'Doug Smith' });
  const call = (p) => shop.calls.find((c) => c.path === p);
  assert.deepEqual(call('/customers/search').body.query.filter.phone_number, { fuzzy: '5707668210' });
  assert.equal(call('/orders').body.order.location_id, 'LV');
  assert.deepEqual(call('/orders').body.order.line_items, [{ catalog_object_id: 'phaze15', quantity: '1' }]);
  const inv = call('/invoices').body.invoice;
  assert.equal(inv.delivery_method, 'SHARE_MANUALLY');
  assert.equal(shop.calls.some((c) => /publish/.test(c.path)), false); // drafts only
  assert.equal(call('/locations').headers.Authorization, 'Bearer sq');
  assert.equal(shop.reviews.length, 0);
});

test('invoice: someone not in Square gets an error back, so Claude can ask about adding them', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const seen = [];
  const claude = fakeClaude([
    [use('create_draft_invoice', { customer_name: 'Bill Jones', phone: '5552223333', lines: [{ variation_id: 'drill1' }] })],
    [speak("Bill Jones isn't in Square. Want me to add him as a new customer?")],
    [use('create_draft_invoice', { customer_name: 'Bill Jones', phone: '5552223333', new_customer: true, lines: [{ variation_id: 'drill1' }] })],
    [speak('Added Bill Jones to Square and made the draft invoice.', true)],
  ], seen);
  let out = await say(fn, shop, 'invoice bill jones for a standard drill', undefined, claude);
  const sent = seen[1].messages[seen[1].messages.length - 1].content[0];
  assert.equal(sent.is_error, true);
  assert.match(JSON.parse(sent.content).error, /is not in Square\. Ask whether to add them/);
  assert.equal(shop.calls.some((c) => c.path === '/orders'), false);
  out = await say(fn, shop, 'yes', out.state, claude);
  assert.equal(out.done, true);
  const created = shop.calls.find((c) => c.path === '/customers').body;
  assert.deepEqual([created.given_name, created.family_name, created.phone_number], ['Bill', 'Jones', '+15552223333']);
});

test('invoice: without Square connected, the tools say so', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const seen = [];
  const claude = fakeClaude([[use('search_square_items', { said: 'phaze' })], [speak("Square isn't connected yet.", true)]], seen);
  const res = await fn.handle(post({ text: 'invoice ann lee phaze' }), { ...env, SQUARE_ACCESS_TOKEN: '' }, shop.fetch, claude);
  assert.equal((await res.json()).done, true);
  assert.match(results(seen[1])[0].error, /Square isn't connected/);
});

test('invoice: the same invoice twice in one conversation is refused', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ squareCustomers: [{ id: 'C1', family_name: 'Lee', phone: '5550001111' }] });
  const inv = { customer_name: 'Ann Lee', phone: '5550001111', lines: [{ variation_id: 'drill1', quantity: 1 }] };
  const seen = [];
  const claude = fakeClaude([[use('create_draft_invoice', inv)], [use('create_draft_invoice', inv)], [speak('Done.', true)]], seen);
  await say(fn, shop, 'invoice ann lee standard drill', undefined, claude);
  assert.equal(shop.calls.filter((c) => c.path === '/invoices').length, 1);
  assert.match(results(seen[2])[0].error, /already made/);
});

test('item search: shop words and loose names find the real Square items, closest first', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ aliases: [{ spoken: 'standard drill', square_item: 'Drilling - Standard' }] });
  let items = await fn.searchItems(env, shop.fetch, 'standard drill');
  assert.equal(items[0].item, 'Drilling - Standard');
  items = await fn.searchItems(env, shop.fetch, 'Game breaker solid');
  assert.equal(items[0].item, 'Ebonite Game Breaker 5 Solid');
  items = await fn.searchItems(env, shop.fetch, '14 pound fays 6');
  assert.equal(items[0].item, 'Storm Phaze 6');
});

test('work order: Claude looks up the phone and adds the ticket', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ directory: [{ customer_name: 'Douglas Smith', phone: '(555) 123-4567' }] });
  const seen = [];
  const claude = fakeClaude([
    [use('find_customer', { name: 'Doug Smith' })],
    [use('create_work_order', { customer_name: 'Douglas Smith', phone: '555-123-4567', title: 'Plug 14 lb ball',
      details: 'Needs it for Thursday league.', category: 'Customer', priority: 'high', due_date: '2026-10-29' })],
    [speak('Work order added for Douglas Smith: plug his 14 pound ball.', true)],
  ], seen);
  const out = await say(fn, shop, 'work order for doug smith to plug his 14 pound ball for thursday league', undefined, claude, 'South Side');
  assert.equal(out.done, true);
  assert.deepEqual(results(seen[1])[0].matches, [{ name: 'Douglas Smith', phone: '555-123-4567' }]);
  const row = shop.tickets[0];
  assert.equal(row.title, 'Plug 14 lb ball');
  assert.equal(row.location, 'South Side');
  assert.equal(row.priority, 'high');
  assert.equal(row.due_date, '2026-10-29');
  assert.equal(row.status, 'new');
  assert.match(row.details, /^Customer: Douglas Smith\nPhone: 555-123-4567\n\nNeeds it for Thursday league\.\n\nSaid: "work order for doug smith/);
  assert.deepEqual(results(seen[2])[0], { ok: true, ticket: 't1', location: 'South Side' });
});

test('work order: values the tickets table would reject are dropped', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const claude = fakeClaude([
    [use('create_work_order', { customer_name: '', title: 'Fix lane 3 ball return', category: 'Lanes', priority: 'asap', due_date: 'friday' })],
    [speak('Added.', true)],
  ]);
  await say(fn, shop, 'ball return on lane 3 is jammed', undefined, claude);
  const row = shop.tickets[0];
  assert.deepEqual([row.category, row.priority, row.due_date], [null, 'normal', null]);
  assert.match(row.details, /^Said: "/);
});

test('review: notes Claude makes are saved once, when the conversation ends', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const claude = fakeClaude([
    [use('note_for_review', { problem: 'Did not catch the ball name' }), speak('Which ball was that?')],
    [speak('Okay, never mind then.', true)],
  ]);
  let out = await say(fn, shop, 'invoice for a mumble mumble', undefined, claude);
  assert.equal(shop.reviews.length, 0);
  out = await say(fn, shop, 'never mind', out.state, claude);
  assert.deepEqual(shop.reviews, [{ problem: 'Did not catch the ball name', heard: 'invoice for a mumble mumble / never mind',
    reply: 'Okay, never mind then.', location: 'Valley' }]);
});

test('review: a Square error goes back to Claude and into the review notes', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const inner = shop.fetch;
  shop.fetch = async (url, init) => url.endsWith('/locations')
    ? new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', detail: 'Bad token' }] }), { status: 401 })
    : inner(url, init);
  const seen = [];
  const claude = fakeClaude([
    [use('create_draft_invoice', { customer_name: 'Ann Lee', phone: '5550001111', lines: [{ variation_id: 'drill1' }] })],
    [speak('Square gave me an error, so no invoice.', true)],
  ], seen);
  await say(fn, shop, 'invoice ann lee standard drill', undefined, claude);
  assert.equal(results(seen[1])[0].error, 'Square said 401: Bad token');
  assert.equal(shop.reviews[0].problem, 'create_draft_invoice failed: Square said 401: Bad token');
});

test('a conversation that runs too long ends and is noted', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const claude = fakeClaude(Array.from({ length: 8 }, () => [speak('Sorry, who?')]));
  let out = { state: undefined };
  for (let i = 0; i < 8; i++) out = await say(fn, shop, 'um', out.state, claude);
  assert.equal(out.done, true);
  assert.match(shop.reviews[0].problem, /ran too long/);
});

test('AI: if Claude fails on the first turn, the simple rules still make the ticket', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const out = await say(fn, shop, 'for doug smith to oil his ball', undefined, fakeClaude([new Error('timeout')]));
  assert.equal(out.done, true);
  assert.equal(shop.tickets[0].title, 'Oil his ball');
  assert.match(shop.reviews[0].problem, /^AI step failed \(timeout\)/);
});

test('AI: a ticket already added is not added again by the rules when Claude then fails', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const claude = fakeClaude([[use('create_work_order', { customer_name: '', title: 'Order tape', category: 'Supplies', priority: 'low' })],
    new Error('timeout')]);
  const out = await say(fn, shop, 'work order to order tape', undefined, claude);
  assert.equal(out.done, true);
  assert.equal(shop.tickets.length, 1);
});

test('AI: if Claude fails later, it apologizes and notes it', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const claude = fakeClaude([[speak('Who is it for?')], new Error('overloaded')]);
  let out = await say(fn, shop, 'work order', undefined, claude);
  out = await say(fn, shop, 'doug smith', out.state, claude);
  assert.equal(out.done, true);
  assert.match(out.say, /lost my train of thought/);
  assert.match(shop.reviews[0].problem, /AI step failed: overloaded/);
});

// --- without Claude: simple rules ------------------------------------------

test('rules: one breath, "for NAME to WORK", looks up the phone and adds the ticket', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ directory: [{ customer_name: 'Doug Smith', phone: '555-123-4567' }] });
  const out = await say(fn, shop, 'create a work order for doug smith to plug his 14 pound ball');
  assert.equal(out.done, true);
  assert.equal(out.say, 'Work order added for Doug Smith: Plug his 14 pound ball.');
  const row = shop.tickets[0];
  assert.match(row.details, /^Customer: Doug Smith\nPhone: 555-123-4567\n\nSaid: "/);
  assert.equal(row.category, 'Customer');
  assert.equal(row.submitted_by, 'Alexa');
  assert.equal(shop.lookups, 4); // three tables and Speccy
});

test('rules: asks who and what, carrying the state between turns', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ orders: [{ customer_name: 'Doug Smith', phone: '5551234567' }] });
  let out = await say(fn, shop, '');
  assert.equal(out.say, 'What do you need?');
  out = await say(fn, shop, 'for doug smith', out.state);
  assert.equal(out.say, 'What are we doing for Doug Smith?');
  out = await say(fn, shop, 'plug and redrill his ball', out.state);
  assert.equal(out.done, true);
  assert.match(shop.tickets[0].details, /^Customer: Doug Smith\nPhone: 555-123-4567/);
});

test('rules: "NAME, WORK" answers both at once', async () => {
  const fn = edgeFunction();
  let out = await say(fn, fakeShop(), '');
  out = await say(fn, fakeShop(), 'doug smith, plug his ball', out.state);
  assert.equal(out.say, 'Work order added for Doug Smith: Plug his ball.');
});

test("rules: names are title-cased, O'Brien and hyphens too", async () => {
  const fn = edgeFunction();
  const out = await say(fn, fakeShop(), "for mary o'brien-smith");
  assert.equal(out.say, "What are we doing for Mary O'Brien-Smith?");
});

test('rules: two different numbers for the name leaves the phone off and says so', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ directory: [{ customer_name: 'Doug Smith', phone: '555-123-4567' }],
    speccy: [{ name: 'Doug Smith', phone: '555-765-4321' }] });
  const out = await say(fn, shop, 'for doug smith to resurface his ball');
  assert.match(out.say, /more than one Doug Smith/);
  assert.match(shop.tickets[0].details, /^Customer: Doug Smith\nPhone: \n/);
});

test('rules: an invoice needs the AI, and says so', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const out = await say(fn, shop, 'create an invoice for ann lee for a phaze');
  assert.match(out.say, /only make invoices when the AI is working/);
  assert.equal(shop.reviews.length, 1);
});

// --- customer matching -----------------------------------------------------

test('lookup: Doug finds Douglas with the same last name, using the list spelling', () => {
  const fn = edgeFunction();
  const m = fn.customerMatches('Doug Smith', [
    { customer_name: 'Douglas Smith', phone: '(555) 123-4567' },
    { customer_name: 'Dana Smith', phone: '555-999-0000' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), [{ name: 'Douglas Smith', phone: '555-123-4567' }]);
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

// --- HTTP ------------------------------------------------------------------

test('wrong password is refused without touching the database', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const res = await fn.handle(post({ text: 'x' }, 'nope'), env, shop.fetch);
  assert.equal(res.status, 401);
  assert.equal(shop.tickets.length + shop.lookups, 0);
});

test('password match ignores pasted spaces and quotes', async () => {
  const fn = edgeFunction();
  const res = await fn.handle(post({ text: 'for ann lee to drill' }, ' s3cret '),
    { ...env, ALEXA_SHARED_SECRET: '"s3cret"' }, fakeShop().fetch);
  assert.equal(res.status, 200);
});

test('location comes from the words, else the device default', () => {
  const fn = edgeFunction();
  assert.equal(fn.pickLocation('at south side', 'Valley'), 'South Side');
  assert.equal(fn.pickLocation('order tape', 'Valley'), 'Valley');
  assert.equal(fn.pickLocation('order tape', ''), null);
});
