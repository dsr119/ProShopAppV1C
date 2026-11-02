// scraper/bowling-retail.mjs and bowling-prices.mjs, no network.
//   node --test tests/bowling-retail.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameTokens, matchNames, parseRetailListing, crawlRetail } from '../scraper/bowling-retail.mjs';
import { retailRows, styleName } from '../scraper/bowling-prices.mjs';

const P = (name, category, price = 50) => ({ name, category, price, url: 'https://www.bowling.com/products/' + name.replace(/\W+/g, '-'), image: 'img' });

test('names are normalized the same way on both sides', () => {
  assert.deepEqual([...nameTokens('Ricky IV Blk/Red Mens Size')], ['ricky', 'iv', 'black', 'red', 'mens']);
  assert.deepEqual([...nameTokens("Dexter Men's Ricky IV Black/Red")], ['mens', 'ricky', 'iv', 'black', 'red']);
  assert.deepEqual([...nameTokens('Storm 2 Ball Tote w/o Pouch')], ['2', 'tote', 'no', 'pouch']);
  assert.deepEqual([...nameTokens('Edge Double Tote without Pouch')], ['edge', '2', 'tote', 'no', 'pouch']);
});

test('matches by name, keeps gender, hand and width apart', () => {
  const retail = [
    P("Dexter Mens Ricky IV Black/Red", 'Shoes', 99.95),
    P("Dexter Mens Ricky IV Black/Red Wide", 'Shoes', 104.95),
    P("Dexter Womens Raquel V Pink", 'Shoes'),
    P("Storm Spark Single Tote Frozen Bliss", 'Bags', 39.99),
    P("Storm Spark Single Tote Black", 'Bags', 39.99),
    P("Dexter Mens Pro BOA Black Right Hand", 'Shoes'),
  ];
  const m = matchNames([
    { name: 'Ricky IV Blk/Red Mens Size', category: 'Shoes' },
    { name: 'Ricky IV Blk/Red Mens Wide Size', category: 'Shoes' },
    { name: 'Raquel V Mens Pink', category: 'Shoes' },
    { name: 'Spark Single Tote Frozen Bliss', category: 'Bags' },
    { name: 'Pro BOA Black Mens LH', category: 'Shoes' },
    { name: 'Spark Single Tote Frozen Bliss', category: 'Shoes' },
  ], retail);
  assert.equal(m.get('Ricky IV Blk/Red Mens Size').product.price, 99.95);
  assert.equal(m.get('Ricky IV Blk/Red Mens Wide Size').product.price, 104.95);
  assert.equal(m.get('Raquel V Mens Pink').ok, false);
  assert.equal(m.get('Spark Single Tote Frozen Bliss').product.name, 'Storm Spark Single Tote Frozen Bliss');
  assert.equal(m.get('Pro BOA Black Mens LH').ok, false);
});

test('a near tie is not trusted', () => {
  const m = matchNames([{ name: 'Spark Single Tote', category: 'Bags' }],
    [P('Storm Spark Single Tote Red', 'Bags'), P('Storm Spark Single Tote Blue', 'Bags')]);
  assert.equal(m.get('Spark Single Tote').ok, false);
});

test('reads JSON-LD listings and stops at the first empty page', async () => {
  const page = (names) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: names.map((n, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Product', name: n, url: '/products/' + n + '.htm', image: '//cdn-images.bowling.com/p/' + n + '.jpg', offers: { price: '49.99', priceCurrency: 'USD' } } })) })}</script>`;
  assert.equal(parseRetailListing(page(['a']), 'u')[0].image, 'https://cdn-images.bowling.com/p/a.jpg');
  const pages = { bags: [page(['a', 'b']), page(['c']), page(['c'])], shoes: [page(['d'])] };
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const kind = url.includes('bags') ? 'bags' : 'shoes';
    const n = +(url.match(/page=(\d+)/) || [0, 1])[1];
    return { ok: true, text: async () => pages[kind][n - 1] || page([]) };
  };
  const all = await crawlRetail({ fetchImpl, log: () => {}, delayMs: 0 });
  assert.deepEqual(all.map((p) => p.name), ['a', 'b', 'c', 'd']);
  assert.equal(all[0].price, 49.99);
  assert.equal(all[3].category, 'Shoes');
});

test('retail columns go on every size of a matched style, and clear when unmatched', () => {
  const rows = [
    { vendor: 'Ace Mitchell', item_code: '58100118 095', site_name: 'Renegade Blue Mesh Mens', display_name: 'Renegade Blue Mesh Mens 9.5' },
    { vendor: 'Ace Mitchell', item_code: 'X', site_name: null, display_name: 'Mystery Bag' },
  ];
  const matches = new Map([['Renegade Blue Mesh Mens', { ok: true, product: P('Brunswick Mens Renegade Blue Mesh', 'Shoes', 59.95) }]]);
  const out = retailRows(rows, matches, 'now');
  assert.equal(out[0].consumer_price, 59.95);
  assert.equal(out[1].consumer_price, null);
  assert.equal(styleName({ display_name: 'Kam Charcoal Grey Mens Size 10' }), 'Kam Charcoal Grey Mens');
});
