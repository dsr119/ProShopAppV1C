const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '..', 'app', file), 'utf8');
function drilling() {
  const ctx = vm.createContext({ Date, console });
  vm.runInContext(source('drilling.js').split('// Wiring\n')[0], ctx);
  return ctx;
}

test('open work reaches back to the start of the previous quarter', () => {
  const { openSince } = drilling();
  assert.equal(openSince(new Date(2026, 9, 2)), '2026-07-01');    // Oct -> Jul
  assert.equal(openSince(new Date(2026, 11, 31)), '2026-07-01');  // Dec -> Jul
  assert.equal(openSince(new Date(2026, 6, 1)), '2026-04-01');    // Jul -> Apr
  assert.equal(openSince(new Date(2027, 0, 1)), '2026-10-01');    // Jan -> last Oct
  assert.equal(openSince(new Date(2027, 2, 31)), '2026-10-01');   // Mar -> last Oct
});

test('orders page uses the same open-work floor as drilling', () => {
  const orders = source('orders.js'), drill = drilling();
  const body = /function openSince\(now\) \{[\s\S]*?\n\}/.exec(orders)[0];
  const ctx = vm.createContext({});
  vm.runInContext(body, ctx);
  for (const d of [new Date(2026, 9, 2), new Date(2027, 0, 15), new Date(2026, 4, 5)]) {
    assert.equal(ctx.openSince(d), drill.openSince(d));
  }
});

test('drilling location filter keeps Both, falls back to order location, keeps unlabelled rows', () => {
  const { atLocation } = drilling();
  assert.equal(atLocation({ pickup_location: 'Valley' }, ''), true);
  assert.equal(atLocation({ pickup_location: 'Valley' }, 'Valley'), true);
  assert.equal(atLocation({ pickup_location: 'Valley' }, 'South Side'), false);
  assert.equal(atLocation({ pickup_location: 'Both' }, 'Valley'), true);
  assert.equal(atLocation({ pickup_location: 'Both' }, 'South Side'), true);
  assert.equal(atLocation({ order_location: 'South Side' }, 'South Side'), true);
  assert.equal(atLocation({ order_location: 'South Side' }, 'Valley'), false);
  assert.equal(atLocation({ pickup_location: 'Valley', order_location: 'South Side' }, 'South Side'), false);
  assert.equal(atLocation({}, 'Valley'), true);
});

test('needs fitting matches the form, website and workbook wording only', () => {
  const ctx = vm.createContext({ window: {}, Date });
  vm.runInContext(source('receiving.js'), ctx);
  const { needsFitting } = ctx.window.receiving;
  assert.equal(needsFitting({ fitting: 'Need appointment to be fitted' }), true);
  assert.equal(needsFitting({ fitting: 'needs fitted' }), true);
  assert.equal(needsFitting({ fitting: 'Specs on file' }), false);
  assert.equal(needsFitting({ fitting: 'N/A' }), false);
  assert.equal(needsFitting({ fitting: null }), false);
  assert.equal(needsFitting({}), false);
});
