// End-to-end run of scraper/ball-scraper.mjs against canned pages: no network,
// Supabase and every site it reads are answered by the fake fetch below.
//   node --test tests/ball-scraper.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const seed = JSON.parse(fs.readFileSync(new URL('../scraper/seed/balls.json', import.meta.url)));
const existing = seed.map((row, i) => ({ id: `id-${i}`, ...row }));

const BOWWWL_PAGE = `<table class="views-view-table"><tbody><tr>
  <td headers="view-nothing-2-table-column"><a href="/bowling-ball-database/storm-brand-new-ball">Brand New Ball</a></td>
  <td headers="view-field-brand-logo-table-column"><img alt="Storm Bowling"></td>
  <td headers="view-field-release-date-table-column">October 2026</td>
  <td headers="view-nothing-1-table-column"><span class="coverstock-name">NRG</span><span class="coverstock-type">Pearl Reactive</span></td>
  <td headers="view-field-factory-finish-table-column">Power Edge</td>
  <td headers="view-nothing-table-column"><span class="core-name">Element</span><span class="core-type">Asymmetric</span></td>
  <td headers="view-field-rg-table-column">2.470</td>
  <td headers="view-field-differential-table-column">0.050</td>
  <td headers="view-field-mass-bias-differential-table-column">0.015</td>
</tr></tbody></table>`;

const itemList = (items) => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'ItemList',
  itemListElement: items.map((item) => ({ '@type': 'ListItem', item: { '@type': 'Product', ...item } })),
})}</script>`;

const STORM_CATALOG = itemList([
  { name: 'Storm IQ Tour', brand: 'Storm', url: 'https://www.bowling.com/products/storm-iq-tour.htm',
    image: '//cdn-images.bowling.com/productimages/storm-iq-tour-bowling-ball-5591.jpg', offers: { price: 170 } },
  { name: 'Storm Brand New Ball', brand: 'Storm', url: 'https://www.bowling.com/products/storm-brand-new-ball.htm',
    image: '//cdn-images.bowling.com/productimages/storm-brand-new-ball-bowling-ball-1.jpg', offers: { price: 199.95 } },
  { name: 'Storm Phaze II X-Out', brand: 'Storm', url: 'https://www.bowling.com/products/storm-phaze-ii-x-out.htm', offers: { price: 99 } },
]);

const DETAIL = `<div><strong>Coverstock</strong></div><div>NRG Pearl Reactive</div>
<div><strong>Core</strong></div><div>Element Asymmetric</div>
<div><strong>Recommended Lane Condition</strong></div><div>Medium Oil</div>`;

// One current product per manufacturer source, so no source comes back empty.
function manufacturerPage(url) {
  if (url.includes('stormbowling')) {
    return '<a class="product-name-link" href="/p/iq" title="IQ Tour">IQ Tour</a><p><strong>Brand:</strong> Storm</p>' +
      '<a class="product-name-link" href="/p/new" title="Brand New Ball">Brand New Ball</a><p><strong>Brand:</strong> Storm</p>';
  }
  if (url.includes('motivbowling')) {
    return '<section class="product-index"><ul><li><a href="/b/x"><span class="title">Jackal Ghost V2</span></a></li></ul></section>';
  }
  if (/brunswickbowling|dv8bowling|radicalbowling/.test(url)) {
    return '<a href="/products/balls/current/alert" aria-label="Alert">Alert</a>';
  }
  return '<a href="/collections/balls/products/x">Some Ball $199.95</a>';
}

function installFakeFetch({ manufacturersDown = false } = {}) {
  const saved = [];
  const deleted = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    if (url.includes('supabase.co/rest/v1/balls')) {
      if (method === 'POST') { saved.push(...JSON.parse(init.body)); return new Response(null, { status: 201 }); }
      if (method === 'DELETE') { deleted.push(url); return new Response(null, { status: 204 }); }
      return Response.json(existing);
    }
    const host = new URL(url).host;
    if (host === 'www.bowwwl.com') return html(BOWWWL_PAGE);
    if (host === 'www.bowling.com') {
      if (url.includes('/shopping/storm/')) return html(STORM_CATALOG);
      if (url.includes('/shopping/')) return html('<html>nothing here</html>');
      return html(DETAIL);
    }
    if (manufacturersDown) return html('down', 503);
    return html(manufacturerPage(url));
  };
  return { saved, deleted };
}

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_URL = 'https://example.supabase.co';
const { main } = await import('../scraper/ball-scraper.mjs');
const silence = () => { const log = console.log, warn = console.warn, error = console.error; console.log = console.warn = console.error = () => {}; return () => Object.assign(console, { log, warn, error }); };

test('adds new balls, updates existing ones, and keeps the sheet rules', async () => {
  const { saved, deleted } = installFakeFetch();
  const restore = silence();
  try { await main(); } finally { restore(); }

  assert.equal(saved.length, existing.length + 1, 'one new ball, nothing lost');
  assert.equal(deleted.length, 0);
  const byKey = Object.fromEntries(saved.map((row) => [row.match_key, row]));

  const iq = byKey['storm|iqtour'];
  assert.equal(iq.price, 170, 'the higher price is kept');
  assert.equal(iq.release_month, '2012-07-01', 'an existing release month is never overwritten');
  assert.equal(iq.product_url, 'https://www.bowling.com/products/storm-iq-tour.htm');
  assert.equal(iq.discontinued, 'No', 'listed on stormbowling.com');

  const added = byKey['storm|brandnewball'];
  assert.equal(added.release_month, '2026-10-01', 'release month from Bowwwl');
  assert.equal(added.int_diff, '0.015');
  assert.equal(added.cover_type, 'Reactive');
  assert.equal(added.cover_finish, 'Pearl');
  assert.equal(added.core_type, 'Asymmetric');
  assert.equal(added.is_recent_release, true);

  assert.ok(!saved.some((row) => /x-?out/i.test(row.name)), 'condition listings are skipped');
  assert.equal(saved.filter((row) => row.is_recent_release).length, 20);

  const columbia = saved.find((row) => row.brand === 'Columbia 300');
  assert.equal(columbia.discontinued, 'Unknown', 'no official source for Columbia 300');
  const otherStorm = saved.find((row) => row.brand === 'Storm' && row.match_key !== 'storm|iqtour' && row.match_key !== 'storm|brandnewball');
  assert.equal(otherStorm.discontinued, 'Yes', 'not on the official Storm list');
});

test('a manufacturer site being down saves the scrape but leaves Discontinued alone, and fails the run', async () => {
  const { saved } = installFakeFetch({ manufacturersDown: true });
  const restore = silence();
  try {
    await assert.rejects(main(), /HTTP 503/);
  } finally { restore(); }
  assert.equal(saved.length, existing.length + 1);
  const before = Object.fromEntries(existing.map((row) => [row.match_key, row.discontinued]));
  for (const row of saved) {
    if (before[row.match_key]) assert.equal(row.discontinued, before[row.match_key]);
  }
});
