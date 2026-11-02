#!/usr/bin/env node
/**
 * Adds bowling.com's consumer price, picture and link to the Ace Mitchell
 * bags and shoes in vendor_stock. Runs right after the stock check.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. DRY_RUN=1 prints the matches
 * (and the in-stock items that found none) without saving.
 */

import { pathToFileURL } from 'node:url';
import { crawlRetail, matchNames } from './bowling-retail.mjs';

export function styleName(row) {
  return row.site_name || String(row.display_name || '').replace(/\s+(size\s+)?\d+(\.\d)?$/i, '') || row.item_code;
}

/** vendor_stock rows + match map -> retail columns for every row. */
export function retailRows(rows, matches, now) {
  return rows.map((r) => {
    const m = matches.get(styleName(r));
    const p = m && m.ok ? m.product : null;
    return {
      vendor: r.vendor,
      item_code: r.item_code,
      consumer_price: p && p.price !== '' ? p.price : null,
      retail_name: p ? p.name : null,
      retail_url: p ? p.url : null,
      retail_image: p ? p.image || null : null,
      retail_checked_at: now,
    };
  });
}

async function main() {
  const { selectAll, upsertRows } = await import('./supabase.mjs');
  const rows = (await selectAll('vendor_stock', 'item_code')).filter((r) => r.category === 'Bags' || r.category === 'Shoes');
  console.log(`${rows.length} Ace Mitchell bag and shoe rows in vendor_stock`);

  console.log('Reading bowling.com bags and shoes');
  const retail = await crawlRetail();
  if (!retail.length) throw new Error('No products read from bowling.com; the page layout may have changed.');

  const items = rows.map((r) => ({ name: styleName(r), category: r.category }));
  const matches = matchNames(items, retail);

  const inStock = new Set(rows.filter((r) => r.qty_total > 0).map(styleName));
  for (const category of ['Bags', 'Shoes']) {
    const names = [...new Set(rows.filter((r) => r.category === category).map(styleName))];
    const stocked = names.filter((n) => inStock.has(n));
    const ok = stocked.filter((n) => matches.get(n)?.ok);
    console.log(`\n${category}: ${ok.length} of ${stocked.length} in-stock styles matched a bowling.com product`);
    console.log('  Matched (sample):');
    for (const n of ok.slice(0, 40)) {
      const m = matches.get(n);
      console.log(`    ${m.score.toFixed(2)}  ${n}  ->  ${m.product.name}  $${m.product.price}`);
    }
    console.log('  Not matched (in stock), with the closest bowling.com name:');
    for (const n of stocked.filter((x) => !matches.get(x)?.ok).slice(0, 60)) {
      const m = matches.get(n);
      console.log(`    ${m.score.toFixed(2)} (next ${m.second.toFixed(2)})  ${n}  ~  ${m.product ? m.product.name : '-'}`);
    }
  }

  if (process.env.DRY_RUN === '1') { console.log('\nDry run: nothing saved.'); return; }
  const out = retailRows(rows, matches, new Date().toISOString());
  await upsertRows('vendor_stock', out, 'vendor,item_code');
  console.log(`\nSaved bowling.com info on ${out.filter((r) => r.retail_url).length} of ${out.length} rows.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
