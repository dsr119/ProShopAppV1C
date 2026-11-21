// Shop prices, BowlerX and the never-lower price rules, no network.
//   node --test tests/shop-prices.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShopPrices, matchShop, loadShopPrices } from '../scraper/shop-prices.mjs';
import { parseBowlerxProduct, crawlBowlerx } from '../scraper/bowlerx.mjs';
import { retailRows, webPrice, raiseIssue } from '../scraper/bowling-prices.mjs';

const CSV = `category,name,variation,price
Shoes,Brunswick Avalanche,Regular,77.95
Shoes,Brunswick Move,9,64.95
Shoes,Brunswick Move,10,66.95
Bags,Brunswick Edge Single Tote,Blue,39.99
Bags,Brunswick Edge Single Tote,Red,41.99
Shoes,Dexter Mens SST 8 Power Frame BOA Black,Regular,224.95
Shoes,Dexter Mens SST 8 Power Frame BOA Black Wide Width,Regular,234.95
Shoes,"Hammer ""Quote"" Shoe, Special",Regular,10.00
Balls,Storm Phaze,Regular,150
`;

test('reads the sheet: sizes fold together, colors stay apart, other categories dropped', () => {
  const items = parseShopPrices(CSV);
  const by = Object.fromEntries(items.map((i) => [i.name, i.price]));
  assert.equal(by['Brunswick Move'], 66.95);
  assert.equal(by['Brunswick Edge Single Tote Blue'], 39.99);
  assert.equal(by['Brunswick Edge Single Tote Red'], 41.99);
  assert.equal(by['Hammer "Quote" Shoe, Special'], 10);
  assert.ok(!('Storm Phaze' in by));
});

test('the real sheet loads', () => {
  const items = loadShopPrices();
  assert.ok(items.length > 100);
  assert.ok(items.every((i) => i.price > 0 && (i.category === 'Bags' || i.category === 'Shoes')));
});

test('a loose shop name covers every color; the most specific shop name wins', () => {
  const shop = parseShopPrices(CSV);
  const m = matchShop([
    { name: 'Avalanche Black/Gold Mens', category: 'Shoes' },
    { name: 'Avalanche Grey Mens WIDE', category: 'Shoes' },
    { name: 'Edge Single Tote Blue', category: 'Bags' },
    { name: 'Edge Single Tote Black', category: 'Bags' },
    { name: 'SST 8 Power Frame BOA Black Mens Wide', category: 'Shoes' },
    { name: 'SST 8 Power Frame BOA Black Mens', category: 'Shoes' },
    { name: 'SST 8 Power Frame BOA Black Ladies', category: 'Shoes' },
    { name: 'Avalanche Single Tote', category: 'Bags' },
    { name: 'Hammer Avalanche Mens', category: 'Shoes' },
  ], shop);
  assert.equal(m.get('Avalanche Black/Gold Mens').item.price, 77.95);
  assert.equal(m.get('Avalanche Grey Mens WIDE').item.price, 77.95);
  assert.equal(m.get('Edge Single Tote Blue').item.price, 39.99);
  // Blue and Red cost different amounts, so Black can't tell which: no shop price.
  assert.equal(m.get('Edge Single Tote Black'), null);
  assert.equal(m.get('SST 8 Power Frame BOA Black Mens Wide').item.price, 234.95);
  assert.equal(m.get('SST 8 Power Frame BOA Black Mens').item.price, 224.95);
  assert.equal(m.get('SST 8 Power Frame BOA Black Ladies'), null); // gender disagrees
  assert.equal(m.get('Avalanche Single Tote'), null); // other category
  assert.equal(m.get('Hammer Avalanche Mens'), null); // other brand
});

test('BowlerX Store API products: cents to dollars, regular price kept, sale noted', () => {
  const p = parseBowlerxProduct({
    name: 'Storm Rolling Thunder 3 Ball Roller Blue Steel/Black', permalink: 'https://www.bowlerx.com/x/',
    images: [{ src: 'https://www.bowlerx.com/i.jpg' }], is_in_stock: true,
    prices: { price: '21995', regular_price: '26495', sale_price: '21995', currency_minor_unit: 2 },
  });
  assert.deepEqual(p, { name: 'Storm Rolling Thunder 3 Ball Roller Blue Steel/Black', price: 264.95, sale: 219.95, url: 'https://www.bowlerx.com/x/', image: 'https://www.bowlerx.com/i.jpg', inStock: true });
  assert.equal(parseBowlerxProduct({ name: 'x', prices: { price: '', regular_price: '' } }), null);
});

test('BowlerX crawl pages until a short page', async () => {
  const prod = (n) => ({ name: n, permalink: '/' + n, images: [], prices: { price: '1000', regular_price: '1000', currency_minor_unit: 2 } });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const page = +url.match(/[?&]page=(\d+)/)[1];
    const n = url.includes('bags') ? (page === 1 ? 100 : 3) : 2;
    return { ok: true, json: async () => Array.from({ length: n }, (_, i) => prod(`${page}-${i}`)) };
  };
  const all = await crawlBowlerx({ fetchImpl, log: () => {}, delayMs: 0 });
  assert.equal(all.filter((p) => p.category === 'Bags').length, 103);
  assert.equal(all.filter((p) => p.category === 'Shoes').length, 2);
  assert.equal(urls.length, 3);
});

test('web price rule: higher, lower, or BowlerX first', () => {
  const a = { price: 50 }, b = { price: 55 };
  assert.equal(webPrice(a, b, 'max'), 55);
  assert.equal(webPrice(a, b, 'min'), 50);
  assert.equal(webPrice(a, b, 'bowlerx'), 55);
  assert.equal(webPrice({ price: 60 }, b, 'bowlerx'), 55);
  assert.equal(webPrice(a, null, 'bowlerx'), 50);
  assert.equal(webPrice(null, null), null);
});

test('shop price always wins; website prices never go down; a rise is reported', () => {
  const P = (name, price) => ({ name, price, url: 'https://x/' + name, image: 'img' });
  const row = (code, name, old, source) => ({ vendor: 'Ace Mitchell', item_code: code, category: 'Shoes', site_name: name, display_name: name, consumer_price: old, price_source: source, retail_name: 'saved', retail_url: 'https://saved', retail_image: 'saved.jpg' });
  const rows = [
    row('1', 'Shop Item', 99, 'web'),       // in the sheet: shop price even though lower
    row('2', 'Cheaper Online', 80, 'web'),  // web 70 < saved 80: keep 80
    row('3', 'Dearer Online', 80, 'web'),   // web 90 > saved 80: raise, report
    row('4', 'New Item', null, null),       // first price
    row('5', 'Gone Missing', 45, 'web'),    // no match today: keep everything
    row('6', 'Was Shop', 120, 'shop'),      // left the sheet: web price, not a "raise"
  ];
  const ok = (p) => ({ ok: true, product: p });
  const matches = new Map([
    ['Shop Item', ok(P('Shop Item', 150))],
    ['Cheaper Online', ok(P('Cheaper Online', 70))],
    ['Dearer Online', ok(P('Dearer Online', 85))],
    ['New Item', ok(P('New Item', 60))],
    ['Was Shop', ok(P('Was Shop', 100))],
  ]);
  const bowlerx = new Map([['Dearer Online', ok(P('Dearer Online X', 90))]]);
  const shop = new Map([['Shop Item', { item: { name: 'Shop Item', price: 89.95 }, words: 2 }]]);
  const raises = [];
  const out = retailRows(rows, matches, 'now', null, { bowlerx, shop, withSource: true, rule: 'max', raises });
  const by = Object.fromEntries(out.map((o) => [o.item_code, o]));
  assert.equal(by[1].consumer_price, 89.95); assert.equal(by[1].price_source, 'shop');
  assert.equal(by[2].consumer_price, 80);
  assert.equal(by[3].consumer_price, 90); assert.equal(by[3].price_source, 'web');
  assert.equal(by[4].consumer_price, 60);
  assert.equal(by[5].consumer_price, 45); assert.equal(by[5].retail_url, 'https://saved'); assert.equal(by[5].price_source, 'web');
  assert.equal(by[6].consumer_price, 100);
  assert.deepEqual(raises.map((x) => [x.name, x.old, x.price]), [['Dearer Online', 80, 90]]);
  assert.ok(!('retail_attrs' in by[1]));
  assert.ok(!('price_source' in retailRows(rows, matches, 'now')[0]));
});

test('the price-raise issue mentions the owner and lists each item', () => {
  const issue = raiseIssue([{ name: 'Kam Black Mens', category: 'Shoes', old: 79.95, price: 84.95, url: 'https://b/kam' }], 'someone');
  assert.match(issue.title, /1 item/);
  assert.match(issue.body, /^@someone /);
  assert.match(issue.body, /\[Kam Black Mens\]\(https:\/\/b\/kam\) \| \$79\.95 \| \$84\.95/);
});
