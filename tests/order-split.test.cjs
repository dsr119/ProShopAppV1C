const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load order.js up to its wiring, with a stub DOM for the dialog's fields.
function dialog(fields) {
  const els = {};
  const $ = (id) => (els[id] ||= { value: '', checked: false, focus() {}, classList: { toggle() {} } });
  for (const [id, v] of Object.entries(fields)) Object.assign($(id), v);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'order.js'), 'utf8').split('// Wiring')[0];
  const ctx = vm.createContext({ $, Date, console });
  vm.runInContext(src, ctx);
  return ctx;
}

test('item text splits on commas, trimming blanks and a trailing full stop', () => {
  const ctx = dialog({});
  assert.deepEqual([...ctx.noSplitItems('size 11 shoes, 12lb tzone, tzone bag.')],
    ['size 11 shoes', '12lb tzone', 'tzone bag']);
  assert.deepEqual([...ctx.noSplitItems('  ,tape,, ')], ['tape']);
  assert.deepEqual([...ctx.noSplitItems('Storm Phaze II 15lb')], ['Storm Phaze II 15lb']);
});

test('a comma entry becomes one order per item with the same customer details', () => {
  const ctx = dialog({
    f_item: { value: 'size 11 shoes, 12lb tzone, tzone bag' },
    f_name: { value: 'Pat Jones' }, f_phone: { value: '5705551234' },
    f_qty: { value: '1' }, f_fitting: { value: 'N/A' },
    f_orderloc: { value: 'Valley' }, f_pickuploc: { value: 'South Side' },
    f_notes: { value: 'paid' },
  });
  const rows = ctx.noReadForm();
  assert.deepEqual([...rows.map((r) => r.item)], ['size 11 shoes', '12lb tzone', 'tzone bag']);
  for (const r of rows) {
    assert.equal(r.customer_name, 'Pat Jones');
    assert.equal(r.phone, '570-555-1234');
    assert.equal(r.order_location, 'Valley');
    assert.equal(r.pickup_location, 'South Side');
    assert.equal(r.fitting, 'N/A');
    assert.equal(r.notes, 'paid');
    assert.equal(r.source, 'in_shop');
    assert.equal(r.submitted_at, rows[0].submitted_at);
  }
});

test('"keep as one item" saves the text unsplit', () => {
  const ctx = dialog({
    f_item: { value: 'Storm Phaze II, 15lb' }, f_keepone: { checked: true },
    f_name: { value: 'Pat' }, f_qty: { value: '1' },
  });
  const rows = ctx.noReadForm();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, 'Storm Phaze II, 15lb');
});

test('an item box of only commas is treated as empty', () => {
  const ctx = dialog({ f_item: { value: ' , , ' }, f_name: { value: 'Pat' } });
  assert.throws(() => ctx.noReadForm(), /item is required/);
});
