// scraper/ace-mitchell-site.mjs against a made-up listing page, no network.
//   node --test tests/ace-mitchell-site.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing, pageLinks, crawlCatalog, SITE } from '../scraper/ace-mitchell-site.mjs';
import { mergeSiteInfo } from '../scraper/ace-mitchell.mjs';

const page = (n, next) => `<html><body><script>var sku = "SKU: NOPE";</script>
<div class="product"><a href="/con/bags/storm/spark-tote-${n}"><img src="/images/spark-${n}.jpg" alt="Spark"></a>
  <h3><a href="/con/bags/storm/spark-tote-${n}">Spark Single Tote Frozen Bliss ${n}</a></h3>
  <span>$39.99</span><div class="sku">SKU: <span>5911110000${n}</span></div></div>
<div class="product"><img data-src="https://cdn.example.com/edge.png" src="data:image/gif;base64,xx">
  <a href="/con/bags/edge-double-${n}">Edge Double Tote without Pouch</a><span>Out of Stock</span><p>SKU: 5911230200${n}</p></div>
${next ? `<a href="/con/bags?page=${n + 1}">Next</a>` : ''}<a href="/con/shoes?page=2">Shoes</a></body></html>`;

test('reads SKU, name, picture and link for each product', () => {
  const products = parseListing(page(1, true), SITE + '/con/bags');
  assert.deepEqual(products, [
    { sku: '59111100001', name: 'Spark Single Tote Frozen Bliss 1', image_url: SITE + '/images/spark-1.jpg', product_url: SITE + '/con/bags/storm/spark-tote-1', out_of_stock_on_site: false },
    { sku: '59112302001', name: 'Edge Double Tote without Pouch', image_url: 'https://cdn.example.com/edge.png', product_url: SITE + '/con/bags/edge-double-1', out_of_stock_on_site: true },
  ]);
});

test('follows only this category\'s page links', () => {
  assert.deepEqual(pageLinks(page(1, true), SITE + '/con/bags', '/con/bags'), [SITE + '/con/bags?page=2']);
});

test('crawls pages in order and dedupes', async () => {
  const pages = { '/con/bags': page(1, true), '/con/bags?page=2': page(2, false), '/con/shoes': '<p>nothing</p>', '/con/balls': '<p>nothing</p>' };
  const fetched = [];
  const fetchImpl = async (url) => {
    const key = url.replace(SITE, '');
    fetched.push(key);
    return { ok: key in pages, status: key in pages ? 200 : 404, text: async () => pages[key] || '' };
  };
  const all = await crawlCatalog({ fetchImpl, delayMs: 0, log: () => {} });
  assert.deepEqual(fetched, ['/con/bags', '/con/bags?page=2', '/con/shoes', '/con/balls']);
  assert.equal(all.length, 4);
  assert.equal(all[0].site_category, 'bags');
});

test('site info is attached to stock rows by code', () => {
  const rows = mergeSiteInfo([{ item_code: '59111100001', qty_total: 2 }, { item_code: 'X', qty_total: 0 }],
    [{ sku: '59111100001', name: 'Spark', image_url: 'i', product_url: 'u' }]);
  assert.deepEqual(rows[0], { item_code: '59111100001', qty_total: 2, site_name: 'Spark', image_url: 'i', product_url: 'u' });
  assert.equal(rows[1].image_url, null);
});
