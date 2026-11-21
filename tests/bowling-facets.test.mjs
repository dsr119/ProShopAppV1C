// scraper/bowling-facets.mjs and the retail_attrs part of bowling-prices.mjs, no network.
//   node --test tests/bowling-facets.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacetOptions, crawlFacets } from '../scraper/bowling-facets.mjs';
import { retailRows } from '../scraper/bowling-prices.mjs';

// Shaped like bowling.com's filter panel.
const radio = (name, value, label, n) => `
  <span class="custom-control custom-radio">
    <input id="rad_${name}_${n}_${value}" type="radio"
           name="${name}" value="${value}"
           class="custom-control-input">
    <label
        for="rad_${name}_${n}_${value}"
        class="custom-control-label">${label}</label>
  </span>`;

const panel = [
  radio('bag-type', '0', 'All', 1), radio('bag-type', '17', 'Roller', 1), radio('bag-type', '18', 'Tote', 1),
  radio('holds-shoes', '7', 'False', 2), radio('holds-shoes', '6', 'True', 2),
  radio('color', '19', 'Black', 3), radio('color', '5', 'Blue', 3),
  radio('brand', '5', 'Storm', 4), radio('brand', '36', 'VISE', 4),
  radio('balls-held', '69', '3', 5), radio('balls-held', '238', 'None', 5),
  radio('image', '91', 'Flame', 6),
].join('\n');

const listing = (names) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: names.map((n, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: n, url: '/products/' + n + '.htm', image: '/p/' + n + '.jpg', offers: { price: '49.99', priceCurrency: 'USD' } } })) })}</script>`;

test('reads the filter options off the panel, without "All"', () => {
  const o = parseFacetOptions(panel);
  assert.deepEqual(o['bag-type'], [{ value: '17', label: 'Roller' }, { value: '18', label: 'Tote' }]);
  assert.deepEqual(o['holds-shoes'].map((x) => x.label), ['False', 'True']);
  assert.equal(o.color.length, 2);
});

test('every product on a filtered listing gets that option', async () => {
  // Which products each filtered listing shows; page 2 repeats page 1's last
  // product, page 3 is empty.
  const shows = {
    '': [['A', 'B', 'C']],
    'bag-type=17': [['A', 'B'], ['B']],
    'bag-type=18': [['B', 'C']],
    'holds-shoes=6': [['A']],
    'color=19': [['A', 'C']],
    'color=5': [['A']],
    'brand=5': [['A', 'B']],
    'brand=36': [['C']],
    'balls-held=69': [['A']],
    'balls-held=238': [['C']],
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const q = (url.split('?')[1] || '').replace(/&?page=\d+/, '');
    const n = +(url.match(/page=(\d+)/) || [0, 1])[1];
    if (q === '') return { ok: true, text: async () => panel + listing(shows[''][0]) };
    const pages = shows[q] || [];
    return { ok: true, text: async () => listing(pages[n - 1] || []) };
  };
  const attrs = await crawlFacets([{ category: 'Bags', url: 'https://www.bowling.com/shopping/all/bowling-bags/all' }],
    { fetchImpl, log: () => {}, delayMs: 0 });
  const A = attrs.get('https://www.bowling.com/products/A.htm');
  const B = attrs.get('https://www.bowling.com/products/B.htm');
  const C = attrs.get('https://www.bowling.com/products/C.htm');
  assert.deepEqual(A, { bag_type: ['Roller'], balls_held: ['3'], holds_shoes: true, brand: ['Storm'], color: ['Black', 'Blue'] });
  assert.deepEqual(B.bag_type, ['Roller', 'Tote']);
  assert.equal(B.holds_shoes, undefined);
  assert.deepEqual(C, { bag_type: ['Tote'], balls_held: ['None'], brand: ['VISE'], color: ['Black'] });
  // "False" is never crawled, and filters we don't use (image) aren't either.
  assert.ok(!fetched.some((u) => /holds-shoes=7|image=/.test(u)));
});

test('a filter page that fails is skipped, not fatal', async () => {
  const fetchImpl = async (url) => {
    if (!url.includes('?')) return { ok: true, text: async () => panel };
    if (url.includes('bag-type=17')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, text: async () => listing(url.includes('bag-type=18') && !url.includes('page=') ? ['T'] : []) };
  };
  const logs = [];
  const attrs = await crawlFacets([{ category: 'Bags', url: 'https://www.bowling.com/b' }],
    { fetchImpl, log: (m) => logs.push(m), delayMs: 0, facets: { Bags: [{ param: 'bag-type', key: 'bag_type' }] } });
  assert.deepEqual(attrs.get('https://www.bowling.com/products/T.htm'), { bag_type: ['Tote'] });
  assert.ok(logs.some((l) => /503/.test(l)));
});

test('retail_attrs goes on matched rows only, and only when asked for', () => {
  const url = 'https://www.bowling.com/products/x.htm';
  const product = { name: 'Storm Tote', price: 40, url, image: 'i' };
  const rows = [
    { vendor: 'Ace Mitchell', item_code: '1', site_name: 'Tote', display_name: 'Tote' },
    { vendor: 'Ace Mitchell', item_code: '2', site_name: 'Other', display_name: 'Other' },
    { vendor: 'Ace Mitchell', item_code: '3', site_name: 'Tote Red', display_name: 'Tote Red' },
  ];
  const matches = new Map([
    ['Tote', { ok: true, product }],
    ['Tote Red', { ok: true, product, samePicture: false }],
  ]);
  const attrs = new Map([[url, { bag_type: ['Tote'], color: ['Black'] }]]);
  const out = retailRows(rows, matches, 'now', attrs);
  assert.deepEqual(out[0].retail_attrs, { bag_type: ['Tote'], color: ['Black'] });
  assert.equal(out[1].retail_attrs, null);
  // Matched to another color of the same model: keep the type, drop the color.
  assert.deepEqual(out[2].retail_attrs, { bag_type: ['Tote'] });
  assert.ok(!('retail_attrs' in retailRows(rows, matches, 'now')[0]));
});
