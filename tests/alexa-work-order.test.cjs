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
function fakeShop({ directory = [], orders = [], speccy = [], squareCustomers = [], catalog = CATALOG, aliases = [], existing = [], speccyStatus = 200 } = {}) {
  const shop = { tickets: [], reviews: [], calls: [], lookups: 0, patches: [], existing, speccyUrls: [] };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  shop.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith('https://speccy.test/')) { shop.lookups += 1; shop.speccyUrls.push(url); return json(speccyStatus === 200 ? speccy : { message: 'denied' }, speccyStatus); }
    if (url.startsWith('https://db.test/')) {
      assert.equal(init.headers.apikey, 'key');
      const table = url.split('/rest/v1/')[1].split('?')[0];
      if (table === 'tickets') {
        if (init.method === 'PATCH') { shop.patches.push({ url, body }); return json([], 200); }
        if (init.method !== 'POST') return json(shop.existing.filter((t) => !url.includes('id=eq.') || url.includes(`id=eq.${t.id}`)));
        shop.tickets.push(body); return json([{ id: 't1' }], 201);
      }
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
  return { messages: { create: async (params, opts) => {
    seen.push(JSON.parse(JSON.stringify(params)));
    seen.timeouts = (seen.timeouts || []).concat(opts && opts.timeout);
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
  assert.match(seen[0].system[0].text, /bowling pro shop/);
  assert.deepEqual([seen[0].system[0].cache_control, seen[0].tools.at(-1).cache_control], [{ type: 'ephemeral' }, { type: 'ephemeral' }]);

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
  assert.equal(JSON.parse(out.state).v, 2); // kept, for a follow-up wake word
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
  assert.equal(row.title, 'Douglas Smith - Plug 14 lb ball');
  assert.equal(row.location, 'South Side');
  assert.equal(row.priority, 'high');
  assert.equal(row.due_date, '2026-10-29');
  assert.equal(row.status, 'new');
  assert.equal(row.details, 'Customer: Douglas Smith\nPhone: 555-123-4567\n\nNeeds it for Thursday league.');
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
  assert.equal(row.details, null);
  assert.equal(row.title, 'Fix lane 3 ball return');
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
  assert.equal(shop.tickets[0].title, 'Doug Smith - Oil his ball');
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
  assert.equal(row.title, 'Doug Smith - Plug his 14 pound ball');
  assert.equal(row.details, 'Customer: Doug Smith\nPhone: 555-123-4567');
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
  assert.equal(shop.tickets[0].details, 'Customer: Doug Smith'); // no empty phone line
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

// --- finding customers, changing work orders, carrying on --------------------

test('lookup: misheard names find the close ones; De Grazia is DeGrazia; Sr. is ignored', () => {
  const fn = edgeFunction();
  const rows = [
    { customer_name: 'John Jablonski', phone: '570-111-2222' },
    { customer_name: 'Joe DeGrazia', phone: '' },
    { customer_name: 'Joe DeGrazia', phone: '570-333-4444' },
    { customer_name: 'Gary Latimer', phone: '570-555-6666' },
    { customer_name: 'Mary Smith', phone: '570-777-8888' },
  ];
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(fn.findCustomers('John Yablonsky', rows)), { matches: [], close: [{ name: 'John Jablonski', phone: '570-111-2222' }] });
  assert.deepEqual(plain(fn.findCustomers('Joe De Grazia', rows)), { matches: [{ name: 'Joe DeGrazia', phone: '570-333-4444' }], close: [] });
  assert.deepEqual(plain(fn.findCustomers('Gary Lattemirak, Sr.', rows).close), []);
  assert.deepEqual(plain(fn.findCustomers('Gary Latimer Sr', rows).matches), [{ name: 'Gary Latimer', phone: '570-555-6666' }]);
  assert.deepEqual([...fn.namePieces('John Yablonsky')], ['yab', 'abl', 'nsky']);
});

test('lookup: searches by pieces of the last name, and notes when Speccy cannot be read', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ speccyStatus: 401, directory: [{ customer_name: 'John Jablonski', phone: '570-111-2222' }] });
  const seen = [];
  const claude = fakeClaude([[use('find_customer', { name: 'John Yablonsky' })], [speak('Did you mean John Jablonski?')], [speak('Okay.', true)]], seen);
  let out = await say(fn, shop, 'work order for john yablonsky', undefined, claude);
  const r = results(seen[1])[0];
  assert.deepEqual(r.close, [{ name: 'John Jablonski', phone: '570-111-2222' }]);
  assert.equal(r.speccy, 'could not be read (error 401)');
  assert.match(decodeURIComponent(shop.speccyUrls[0]), /or=\(name\.ilike\.\*yab\*,name\.ilike\.\*abl\*,name\.ilike\.\*nsky\*\)/);
  out = await say(fn, shop, 'never mind', out.state, claude);
  assert.match(shop.reviews[0].problem, /Speccy could not be read \(error 401\)/);
});

const TICKETS = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Bake and resurface Hammer Special Effect', details: 'Customer: John Doe\nPhone: \n\nSaid: "x"', status: 'new', submitted_at: '2026-10-27T04:00:00Z' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Beacon resurface Bionic', details: 'Customer: Joe DeGrazia\nPhone: \n\nSaid: "y"', status: 'new', submitted_at: '2026-10-27T04:05:00Z' },
];

test('editing: find a work order by customer or ball, then change only what was said', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ existing: TICKETS });
  const seen = [];
  const claude = fakeClaude([
    [use('find_work_orders', { customer_name: 'Joe de Grazias' }), use('find_work_orders', { words: 'special effect' })],
    [use('update_work_order', { id: TICKETS[1].id, title: 'Bake and resurface Bionic' }),
     use('update_work_order', { id: TICKETS[0].id, status: 'done', done_note: 'Done, not picked up yet' })],
    [speak('Done, both changed.', true)],
  ], seen);
  await say(fn, shop, 'change joe de grazias to a bake and resurface, and mark the special effect done but not picked up', undefined, claude);
  const [byName, byBall] = results(seen[1]);
  assert.deepEqual(byName.work_orders.map((t) => t.customer), ['Joe DeGrazia']);
  assert.deepEqual(byBall.work_orders.map((t) => t.title), ['Bake and resurface Hammer Special Effect']);
  assert.deepEqual(results(seen[2]).map((r) => r.changed), [['title'], ['status', 'resolution']]);
  assert.match(shop.patches[0].url, /id=eq\.22222222-2222-4222-8222-222222222222&deleted_at=is\.null$/);
  assert.deepEqual(shop.patches[0].body, { title: 'Bake and resurface Bionic' });
  assert.equal(shop.patches[1].body.status, 'done');
  assert.equal(shop.patches[1].body.resolution, 'Done, not picked up yet');
  assert.ok(shop.patches[1].body.completed_at);
});

test('editing: the customer and phone are rewritten in the details; notes are added', async () => {
  const fn = edgeFunction();
  const out = await fn.updateTicket(env, fakeShop({ existing: TICKETS }).fetch,
    { id: TICKETS[0].id, customer_name: 'Gary Latimer', phone: '5705556666', note: 'Customer called' }, new Date('2026-10-27T05:00:00Z'));
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { ok: true, changed: ['details'] });
  const shop = fakeShop({ existing: TICKETS });
  await fn.updateTicket(env, shop.fetch, { id: TICKETS[0].id, customer_name: 'Gary Latimer', phone: '5705556666', note: 'Customer called' }, new Date('2026-10-27T05:00:00Z'));
  assert.equal(shop.patches[0].body.details, 'Customer: Gary Latimer\nPhone: 570-555-6666\n\nSaid: "x"\n\nVoice note 2026-10-27: Customer called');
  assert.match((await fn.updateTicket(env, shop.fetch, { id: 'nope' }, new Date())).error, /id/);
  assert.match((await fn.updateTicket(env, shop.fetch, { id: TICKETS[0].id }, new Date())).error, /Nothing to change/);
});

test('a new wake word carries on the last conversation, with a fresh count', async () => {
  const fn = edgeFunction();
  const shop = fakeShop();
  const seen = [];
  const claude = fakeClaude([
    [use('create_work_order', { customer_name: 'Joe Sutton', title: 'Plug thumb on NU Blue', category: 'Customer', priority: 'normal' })],
    [speak("Done: plug thumb on Joe Sutton's NU Blue.", true)],
    [use('update_work_order', { id: '33333333-3333-4333-8333-333333333333', title: 'Plug thumb on NU Black' })],
    [speak('Changed to NU Black.', true)],
  ], seen);
  let out = await say(fn, shop, 'work order for joe sutton, plug the thumb on his nu blue', undefined, claude);
  assert.equal(out.done, true);
  const res = await fn.handle(post({ text: 'change that one to the nu black', state: out.state, resume: true, location: 'Valley' }), env, shop.fetch, claude);
  out = await res.json();
  const st = JSON.parse(out.state);
  assert.deepEqual(st.heard, ['change that one to the nu black']);
  assert.equal(st.turns, 1);
  // Claude saw the earlier work order.
  assert.match(JSON.stringify(seen[2].messages), /Plug thumb on NU Blue/);
});

test('resuming keeps only recent messages, cut where a person spoke', () => {
  const fn = edgeFunction();
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `said ${i}` });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `a${i}`, name: 'speak', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `a${i}`, content: 'said' }] });
  }
  const st = fn.resumeState({ v: 2, messages, heard: ['x'], turns: 5, done: ['k'], review: ['r'] });
  assert.equal(typeof st.messages[0].content, 'string');
  assert.ok(st.messages.length <= 30);
  assert.deepEqual([st.turns, st.heard.length, st.done.length, st.review.length], [0, 0, 0, 0]);
});

test('editing: a new customer name also replaces the name at the start of the title', async () => {
  const fn = edgeFunction();
  const shop = fakeShop({ existing: [{ id: TICKETS[0].id, title: 'John Doe - Bake and resurface Special Effect',
    details: 'Customer: John Doe', status: 'new' }] });
  await fn.updateTicket(env, shop.fetch, { id: TICKETS[0].id, customer_name: 'Gary Latimer' }, new Date());
  assert.deepEqual(JSON.parse(JSON.stringify(shop.patches[0].body)),
    { details: 'Customer: Gary Latimer', title: 'Gary Latimer - Bake and resurface Special Effect' });
});

// --- ball catalog ------------------------------------------------------------

const BALLS = [
  { brand: 'Storm', name: 'Phaze 6', release_month: '2026-09-01', discontinued: 'No', is_recent_release: true },
  { brand: 'Storm', name: 'Nu Blue', release_month: '2025-03-01', discontinued: 'No', is_recent_release: false },
  { brand: 'Storm', name: 'Identity', release_month: '2024-06-01', discontinued: 'No', is_recent_release: false },
  { brand: 'Hammer', name: 'Black Widow Ghost', release_month: '2025-01-01', discontinued: 'No', is_recent_release: false },
  { brand: 'Hammer', name: 'Special Effect', release_month: '2025-05-01', discontinued: 'No', is_recent_release: false },
  { brand: 'Roto Grip', name: 'Exponent Solid', release_month: '2024-01-01', discontinued: 'No', is_recent_release: false },
  { brand: 'Ebonite', name: 'Game Breaker 5 Solid', release_month: '2023-01-01', discontinued: 'Yes', is_recent_release: false },
];
function ballShop(extra = {}) {
  const shop = fakeShop(extra);
  const inner = shop.fetch;
  shop.ballCalls = 0;
  shop.fetch = async (url, init) => {
    // Like the real database: a page past the end is a 416, not an empty list.
    if (url.startsWith('https://db.test/rest/v1/balls?')) { shop.ballCalls += 1; return url.includes('offset=0&') ? new Response(JSON.stringify(BALLS), { status: 200 }) : new Response('{"code":"PGRST103"}', { status: 416 }); }
    return inner(url, init);
  };
  return shop;
}

test('balls: misheard ball names find the real ones in the catalog', async () => {
  const fn = edgeFunction();
  const shop = ballShop();
  const top = async (said) => (await fn.findBalls(env, shop.fetch, said)).map((b) => b.ball)[0];
  assert.equal(await top('NU blue'), 'Storm Nu Blue');
  assert.equal(await top('fays 6'), 'Storm Phaze 6');
  assert.equal(await top('15 pound phaze'), 'Storm Phaze 6');
  assert.equal(await top('black widow ghost'), 'Hammer Black Widow Ghost');
  assert.equal(await top('Exponent solid'), 'Roto Grip Exponent Solid');
  assert.equal(await top('hammer special effect'), 'Hammer Special Effect');
  assert.equal((await fn.findBalls(env, shop.fetch, 'wrist brace')).length, 0);
  assert.equal(shop.ballCalls, 5); // one batch of five pages, then cached
});

test('balls: Claude checks the ball, and an unknown one is noted for review', async () => {
  const fn = edgeFunction();
  const shop = ballShop();
  const seen = [];
  const claude = fakeClaude([
    [use('find_ball', { said: 'nu blue' }), use('find_ball', { said: 'zork ultra' })],
    [speak('Which ball was the second one?', true)],
  ], seen);
  await say(fn, shop, 'work order to plug a nu blue and a zork ultra', undefined, claude);
  const [a, b] = results(seen[1]);
  assert.equal(a.balls[0].ball, 'Storm Nu Blue');
  assert.deepEqual(b.balls, []);
  assert.match(shop.reviews[0].problem, /Ball not in the catalog: "zork ultra"/);
  assert.match(seen[0].system[0].text, /find_ball/);
});

test('balls: the laptop gets the newest ball names as listening hints', async () => {
  const fn = edgeFunction();
  const res = await fn.handle(post({ hints: true }), env, ballShop().fetch);
  const { balls } = await res.json();
  assert.equal(balls[0], 'Storm Phaze 6');
  assert.ok(!balls.includes('Ebonite Game Breaker 5 Solid')); // discontinued
  const bad = await fn.handle(post({ hints: true }, 'nope'), env, ballShop().fetch);
  assert.equal(bad.status, 401);
});

// --- appointments and orders -----------------------------------------------------

const HOURS = [
  { location: 'Valley Bowling Lanes', date: '2026-10-27', open1: '6:00 PM', close1: '8:30 PM', note1: 'Doug Only', open2: null, close2: null, note2: null },
  { location: 'Idle Hours South', date: '2026-10-27', open1: '11:30 AM', close1: '2:00 PM', note1: null, open2: '6:00 PM', close2: '8:30 PM', note2: null },
  { location: 'Valley Bowling Lanes', date: '2026-10-28', open1: null, close1: null, note1: null, open2: null, close2: null, note2: null },
];
const APPTS = [
  { id: 'a1', customer_name: 'Ann Lee', phone: '555-000-1111', service: 'Conventional drill', location: 'Valley', appt_date: '2026-10-27', appt_time: '18:30:00', completed: false, notes: null },
];
const ORDERS = [
  { customer_name: 'Jim Curtis', item: 'Dexter SST 8 shoes 10.5', quantity: 1, submitted_at: '2026-10-15T12:00:00Z', shop_order_date: '2026-10-20', supplier: 'Dexter',
    checked_in_at: null, drilled: false, has_been_called: false, time_called: null, last_contacted_at: null, paid: true, out_the_door: false, pickup_location: 'Valley', notes: null },
  { customer_name: 'Jim Curtis', item: 'Storm Phaze 6 15 lb', quantity: 1, submitted_at: '2026-09-01T12:00:00Z', shop_order_date: '2026-09-02', supplier: 'Storm',
    checked_in_at: '2026-09-08T15:00:00Z', drilled: true, has_been_called: true, time_called: null, last_contacted_at: '2026-09-09T15:00:00Z', paid: true, out_the_door: false, pickup_location: 'Valley', notes: null },
  { customer_name: 'Tim Curtis', item: 'Hammer Black Widow', quantity: 1, submitted_at: '2026-10-01T12:00:00Z', shop_order_date: null,
    checked_in_at: null, drilled: false, has_been_called: false, paid: false, out_the_door: false },
];
function scheduleShop() {
  const shop = fakeShop();
  const inner = shop.fetch;
  shop.booked = [];
  shop.urls = [];
  shop.fetch = async (url, init = {}) => {
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.startsWith('https://db.test/rest/v1/hours?')) { shop.urls.push(url); return json(HOURS.filter((h) => url.includes(`date=gte.${h.date}`) || url.includes(`lte.${h.date}`))); }
    if (url.startsWith('https://db.test/rest/v1/appointments') && init.method === 'POST') { shop.booked.push(JSON.parse(init.body)); return json([{ id: 'new1' }], 201); }
    if (url.startsWith('https://db.test/rest/v1/appointments?select=id')) { shop.urls.push(url); return json(APPTS); }
    if (url.startsWith('https://db.test/rest/v1/orders?select=customer_name,item')) { shop.urls.push(url); return json(ORDERS); }
    return inner(url, init);
  };
  return shop;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('times: shop hour text and appointment times read the same way', () => {
  const fn = edgeFunction();
  assert.deepEqual([fn.toMinutes('6:00 PM'), fn.toMinutes('18:30:00'), fn.toMinutes('12:15 am'), fn.toMinutes('After League')], [1080, 1110, 15, null]);
  assert.deepEqual([fn.clock(1110), fn.clock(690), fn.clock(720)], ['6:30 PM', '11:30 AM', '12:00 PM']);
});

test('schedule: hours per location and the appointments for a day', async () => {
  const fn = edgeFunction();
  const shop = scheduleShop();
  const seen = [];
  const claude = fakeClaude([[use('check_schedule', { from: '2026-10-27' })], [speak('Valley 6 to 8:30, Ann Lee at 6:30.', true)]], seen);
  await say(fn, shop, 'what does tuesday look like', undefined, claude);
  const day = results(seen[1])[0].days[0];
  assert.deepEqual(day, { date: '2026-10-27', day: 'Tuesday',
    hours: [{ location: 'Valley', open: '6:00 PM-8:30 PM (Doug Only)' }, { location: 'South Side', open: '11:30 AM-2:00 PM, 6:00 PM-8:30 PM' }],
    appointments: [{ id: 'a1', time: '6:30 PM', customer: 'Ann Lee', service: 'Conventional drill', location: 'Valley', done: false }] });
  assert.match(shop.urls.find((u) => u.includes('appointments')), /appt_date=gte\.2026-10-27&appt_date=lte\.2026-10-27&deleted_at=is\.null/);
});

test('openings: shop hours minus bookings, in half hours', async () => {
  const fn = edgeFunction();
  fn.todayInShop = () => '2026-10-26';
  const out = plain(await fn.findOpenings(env, scheduleShop().fetch, { from: '2026-10-27', to: '2026-10-28', location: 'Valley' }));
  assert.deepEqual(out, { minutes: 30, days: [{ date: '2026-10-27', day: 'Tuesday',
    open: [{ location: 'Valley', free: ['6:00 PM', '7:00 PM', '7:30 PM', '8:00 PM'] }] }] });
  const long = plain(await fn.findOpenings(env, scheduleShop().fetch, { from: '2026-10-27', to: '2026-10-27', location: 'Valley', minutes: 60 }));
  assert.deepEqual(long.days[0].open[0].free, ['7:00 PM', '7:30 PM']);
  // Later the same day, times already gone aren't offered.
  fn.todayInShop = () => '2026-10-27';
  fn.minutesNowInShop = () => 19 * 60 + 15;
  const late = plain(await fn.findOpenings(env, scheduleShop().fetch, { from: '2026-10-27', to: '2026-10-27', location: 'Valley' }));
  assert.deepEqual(late.days[0].open[0].free, ['7:30 PM', '8:00 PM']);
});

test('booking: a clash or closed shop needs an OK; then it books at the laptop\'s location', async () => {
  const fn = edgeFunction();
  fn.todayInShop = () => '2026-10-27';
  const shop = scheduleShop();
  let out = plain(await fn.bookAppointment(env, shop.fetch, { customer_name: 'Bob Ray', service: 'Conventional drill', date: '2026-10-27', time: '6:30 PM', location: 'Valley' }));
  assert.equal(out.needs_ok, true);
  assert.match(out.warnings[0], /Ann Lee is already booked at 6:30 PM/);
  out = plain(await fn.bookAppointment(env, shop.fetch, { customer_name: 'Bob Ray', service: 'Drill', date: '2026-10-27', time: '3 PM', location: 'Valley' }));
  assert.match(out.warnings[0], /outside shop hours/);
  out = plain(await fn.bookAppointment(env, shop.fetch, { customer_name: 'Bob Ray', service: 'Drill', date: '2026-10-28', time: '6 PM', location: 'Valley' }));
  assert.match(out.warnings[0], /closed at Valley/);
  assert.equal(shop.booked.length, 0);

  const seen = [];
  const claude = fakeClaude([[use('book_appointment', { customer_name: 'Bob Ray', phone: '5701234567', service: 'Conventional drill', date: '2026-10-27', time: '7:00 PM' })],
    [speak('Booked Tuesday at 7.', true)]], seen);
  await say(fn, shop, 'book bob ray tuesday at 7 for a conventional drill', undefined, claude, 'Valley');
  assert.deepEqual(results(seen[1])[0], { ok: true, appointment: 'new1', date: '2026-10-27', day: 'Tuesday', time: '7:00 PM', location: 'Valley' });
  assert.deepEqual(shop.booked[0], { customer_name: 'Bob Ray', phone: '570-123-4567', service: 'Conventional drill', location: 'Valley',
    appt_date: '2026-10-27', appt_time: '19:00', notes: null });
  out = plain(await fn.bookAppointment(env, shop.fetch, { customer_name: 'Bob Ray', service: 'Drill', date: '2026-10-27', time: '6:30 PM', location: 'Valley', confirmed: true }));
  assert.equal(out.ok, true);
  out = plain(await fn.bookAppointment(env, shop.fetch, { customer_name: 'Bob Ray', service: 'Drill', date: '2020-01-06', location: 'Valley' }));
  assert.match(out.warnings[0], /Monday 2020-01-06 has already passed/);
});

test('orders: a customer\'s order status, narrowed by item', async () => {
  const fn = edgeFunction();
  const shop = scheduleShop();
  let out = plain(await fn.findOrders(env, shop.fetch, { customer_name: 'Jim Curtis', item: 'shoes' }));
  assert.deepEqual(out.orders.map((o) => [o.item, o.status]), [['Dexter SST 8 shoes 10.5', 'ordered 2026-10-20 from Dexter, not in yet, paid']]);
  out = plain(await fn.findOrders(env, shop.fetch, { customer_name: 'Jim Curtis' }));
  assert.deepEqual(out.orders.map((o) => o.status), ['ordered 2026-10-20 from Dexter, not in yet, paid', 'arrived 2026-09-08, drilled, customer contacted 2026-09-09, paid']);
  out = plain(await fn.findOrders(env, shop.fetch, { customer_name: 'Jim Curtis', item: 'bag' }));
  assert.equal(out.orders.length, 2);
  assert.match(out.note, /Nothing matched that item/);
  assert.match(decodeURIComponent(shop.urls.find((u) => u.includes('orders'))), /or=\(customer_name\.ilike\.\*cur\*,customer_name\.ilike\.\*urt\*,customer_name\.ilike\.\*rtis\*\)/);
});

test('the prompt knows today in New York and this week\'s dates', () => {
  const fn = edgeFunction();
  const p = fn.systemPrompt(new Date('2026-10-28T02:00:00Z'), 'Valley'); // 10 PM Tuesday in New York
  assert.match(p, /Today is Tuesday 2026-10-27/);
  assert.match(p, /this week is Monday 2026-10-26 to Sunday 2026-11-01/);
});

test('model: Haiku by default; the laptop or the VOICE_MODEL secret can pick a bigger one', async () => {
  const fn = edgeFunction();
  const run = async (body, extraEnv = {}) => {
    const seen = [];
    const claude = fakeClaude([[speak('Hi.', false)]], seen);
    await fn.handle(post({ text: 'hello', location: 'Valley', ...body }), { ...env, ...extraEnv }, fakeShop().fetch, claude);
    return [seen[0].model, seen.timeouts[0]];
  };
  assert.deepEqual(await run({}), ['claude-haiku-5-5', 8000]);
  assert.deepEqual(await run({ model: 'Sonnet' }), ['claude-sonnet-5-5', 25000]);
  assert.deepEqual(await run({}, { VOICE_MODEL: 'opus' }), ['claude-opus-5-5', 25000]);
  assert.deepEqual(await run({ model: 'gpt' }), ['claude-haiku-5-5', 8000]);
});

test('a confirmation given with the action is said only when the action worked', async () => {
  const fn = edgeFunction();
  // Created: said straight away, one Claude call.
  let seen = [];
  let shop = fakeShop();
  let out = await say(fn, shop, 'work order for Doug Smith to plug his ball', undefined,
    fakeClaude([[use('create_work_order', { title: 'Doug Smith - Plug ball', category: 'Customer', customer_name: 'Doug Smith' }), speak('Done: plug on Doug Smith\'s ball.', true)]], seen));
  assert.equal(seen.length, 1);
  assert.equal(out.say, "Done: plug on Doug Smith's ball.");
  assert.equal(shop.tickets.length, 1);
  // Paired with a lookup: not said; Claude sees the results and speaks again.
  seen = [];
  shop = fakeShop();
  out = await say(fn, shop, 'work order for Doug Smith', undefined,
    fakeClaude([[use('find_customer', { name: 'Doug Smith' }), speak('Done.', true)], [speak('What are we doing for Doug?', false)]], seen));
  assert.equal(seen.length, 2);
  assert.equal(out.say, 'What are we doing for Doug?');
  assert.match(seen[1].messages.at(-1).content.find((b) => b.content.startsWith('Not said')).content, /check the results/);
});

test('ping warms the ball catalog', async () => {
  const fn = edgeFunction();
  const shop = ballShop();
  const res = await fn.handle(post({ ping: true }), env, shop.fetch, null);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(shop.ballCalls, 5);
});

test('each reply carries a short trace of what the AI looked up, for the laptop log', async () => {
  const fn = edgeFunction();
  const out = await say(fn, fakeShop(), 'work order for Doug Smith', undefined,
    fakeClaude([[use('find_customer', { name: 'Doug Smith' })], [speak('What are we doing?', false)]]));
  assert.equal(out.trace.length, 1);
  assert.match(out.trace[0], /^find_customer \{"name":"Doug Smith"\} -> \{/);
});
