#!/usr/bin/env node
/**
 * Adds bowling.com's consumer price, picture and link to the Ace Mitchell
 * bags and shoes in vendor_stock. Runs right after the stock check.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. DRY_RUN=1 prints the matches
 * (and the in-stock items that found none) without saving.
 */

import { pathToFileURL } from 'node:url';
import { crawlRetail, matchNames, RETAIL_CATEGORIES } from './bowling-retail.mjs';
import { crawlFacets } from './bowling-facets.mjs';

export function styleName(row) {
  return row.site_name || String(row.display_name || '').replace(/\s+(size\s+)?\d+(\.\d)?$/i, '') || row.item_code;
}

/**
 * vendor_stock rows + match map -> retail columns for every row. attrs is
 * bowling.com's filter values by product url (bowling-facets.mjs); pass null
 * to leave retail_attrs out (before that column exists).
 */
export function retailRows(rows, matches, now, attrs = null) {
  return rows.map((r) => {
    const m = matches.get(styleName(r));
    const p = m && m.ok ? m.product : null;
    return {
      vendor: r.vendor,
      item_code: r.item_code,
      consumer_price: p && p.price !== '' ? p.price : null,
      retail_name: p ? p.name : null,
      retail_url: p ? p.url : null,
      // A same-model match in another color keeps the price but not the picture.
      retail_image: p && m.samePicture !== false ? p.image || null : null,
      retail_checked_at: now,
      ...(attrs ? { retail_attrs: p ? attrsFor(attrs.get(p.url), m) : null } : {}),
    };
  });
}

function attrsFor(a, m) {
  if (!a) return null;
  // A match to the same model in another color (m.samePicture false) keeps
  // the price, but bowling.com's colors would be the other color's.
  if (m.samePicture === false) { const { color, ...rest } = a; return rest; }
  return a;
}

async function main() {
  const { selectAll, upsertRows } = await import('./supabase.mjs');
  const rows = (await selectAll('vendor_stock', 'item_code')).filter((r) => r.category === 'Bags' || r.category === 'Shoes');
  console.log(`${rows.length} Ace Mitchell bag and shoe rows in vendor_stock`);

  console.log('Reading bowling.com bags and shoes');
  const retail = await crawlRetail();
  if (!retail.length) throw new Error('No products read from bowling.com; the page layout may have changed.');

  const items = rows.map((r) => ({ name: styleName(r), category: r.category }));

  // DUMP=1 prints both lists as JSON lines, for tuning the matcher offline.
  if (process.env.DUMP === '1') {
    const stocked = new Map();
    for (const r of rows) {
      const k = styleName(r);
      const s = stocked.get(k) || { name: k, category: r.category, qty: 0, sized: false };
      s.qty += r.qty_total; s.sized = s.sized || / \d{3}$/.test(r.item_code);
      stocked.set(k, s);
    }
    for (const s of stocked.values()) console.log('DUMP_ACE ' + JSON.stringify(s));
    for (const p of retail) console.log('DUMP_RETAIL ' + JSON.stringify({ name: p.name, category: p.category, price: p.price, url: p.url }));
  }
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

  // Filter values (type, balls held, gender, width, hand, brand, color...)
  // for the website. Saved only once the retail_attrs column has been added
  // (supabase/migrations/20261121_vendor_stock_attrs.sql).
  const dryRun = process.env.DRY_RUN === '1';
  const hasColumn = rows.length > 0 && 'retail_attrs' in rows[0];
  let attrs = null;
  if (hasColumn || dryRun) {
    console.log('\nReading bowling.com filters');
    attrs = await crawlFacets(RETAIL_CATEGORIES);
    const tagged = new Set(rows.map(styleName).filter((n) => { const m = matches.get(n); return m?.ok && attrs.has(m.product.url); }));
    console.log(`  ${attrs.size} bowling.com products tagged; ${tagged.size} matched styles have filter values`);
    for (const n of [...tagged].slice(0, 15)) console.log(`    ${n}  ${JSON.stringify(attrs.get(matches.get(n).product.url))}`);
  } else {
    console.log('\nretail_attrs column not there yet, skipping bowling.com filters');
  }
  if (dryRun) { console.log('\nDry run: nothing saved.'); return; }
  const out = retailRows(rows, matches, new Date().toISOString(), hasColumn && attrs?.size ? attrs : null);
  await upsertRows('vendor_stock', out, 'vendor,item_code');
  console.log(`\nSaved bowling.com info on ${out.filter((r) => r.retail_url).length} of ${out.length} rows.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
