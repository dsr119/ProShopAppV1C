const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function drilling(elements = {}) {
  const ctx = vm.createContext({ console, Date, Intl });
  ctx.document = { getElementById: (id) => elements[id] };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/drilling.js'), 'utf8').split('// Wiring\n')[0], ctx);
  return ctx;
}

test('queue sorts by when the customer ordered, longest wait first', () => {
  const ctx = drilling({
    search: { value: '' }, location: { value: '' }, assignee: { value: '' }, showdone: { checked: false },
  });
  const rows = [
    { id: 'recent', customer_name: 'A', submitted_at: '2026-10-05T14:00:00Z', shop_order_date: '2026-10-05' },
    { id: 'due-soon', customer_name: 'B', submitted_at: '2026-10-01T14:00:00Z', shop_order_date: '2026-10-01', due_date: '2026-10-09' },
    { id: 'not-ordered', customer_name: 'C', submitted_at: '2026-09-20T14:00:00Z', shop_order_date: null },
    { id: 'legacy', customer_name: 'D', submitted_at: null, shop_order_date: '2026-09-25' },
    { id: 'undated', customer_name: 'E', submitted_at: null, shop_order_date: null },
  ];
  vm.runInContext('ROWS = rows', Object.assign(ctx, { rows }));
  assert.deepEqual(ctx.visible().map((r) => r.id), ['not-ordered', 'legacy', 'due-soon', 'recent', 'undated']);
});

test('Texted saves the time, shows it, and the column goes quiet before the migration', async () => {
  const made = [];
  const el = () => {
    const e = { children: [], events: {}, disabled: false, textContent: '' };
    e.append = (...c) => e.children.push(...c);
    e.addEventListener = (n, fn) => { e.events[n] = fn; };
    made.push(e);
    return e;
  };
  const ctx = drilling();
  ctx.document.createElement = el;
  let patch;
  ctx.db = {
    selectAll: async () => [{ id: 'one', last_contacted_at: '2026-10-01T16:05:00Z' }],
    update: async (_, filter, p) => { assert.equal(filter, 'id=eq.two'); patch = p; },
  };
  await ctx.loadContacts();
  const [, note1] = ctx.contactCell({ id: 'one' }).children;
  assert.match(note1.textContent, /^Last: 10\/1 /);

  const [button, note] = ctx.contactCell({ id: 'two' }).children;
  assert.equal(note.textContent, 'Not texted yet');
  await button.events.click();
  assert.ok(patch.last_contacted_at);
  assert.match(note.textContent, /^Last: /);
  assert.equal(button.textContent, 'Texted');

  ctx.db.selectAll = async () => { throw new Error('column does not exist'); };
  ctx.console = { error() {} };
  await ctx.loadContacts();
  const [b2, n2] = ctx.contactCell({ id: 'one' }).children;
  assert.equal(b2.disabled, true);
  assert.equal(n2.textContent, 'Unavailable');
});

test('Drilling buttons are Drilled, No drill, Schedule again, fitting or not', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/drilling.js'), 'utf8');
  assert.doesNotMatch(src, /Book fitting/);
  assert.match(src, /act\.append\(drilled, nodrill, sched\)/);
});
