#!/usr/bin/env node
/**
 * Adds the consumer price, picture and link to the Ace Mitchell bags and
 * shoes in vendor_stock. Runs right after the stock check.
 *
 * Price: the shop's own (shop-prices.csv) when the item is in it, otherwise
 * bowling.com / BowlerX, never lowered (see retailRows). When a website price
 * goes up, a GitHub issue lists the items, which GitHub emails to NOTIFY_LOGIN.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. DRY_RUN=1 prints the matches
 * and what each price would become, without saving. GITHUB_TOKEN,
 * GITHUB_REPOSITORY, NOTIFY_LOGIN for the price-raise issue. PRICE_RULE.
 */

import { pathToFileURL } from 'node:url';
import { crawlRetail, matchNames, RETAIL_CATEGORIES } from './bowling-retail.mjs';
import { crawlFacets } from './bowling-facets.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { loadShopPrices, matchShop } from './shop-prices.mjs';

export function styleName(row) {
  return row.site_name || String(row.display_name || '').replace(/\s+(size\s+)?\d+(\.\d)?$/i, '') || row.item_code;
}

// How the two websites' prices combine for an item not in the shop's sheet:
// 'max' (higher of the two), 'min' (lower) or 'bowlerx' (BowlerX when it
// has the item, bowling.com otherwise).
export const PRICE_RULE = process.env.PRICE_RULE || 'max';

const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);

/** The website price for one style from its two matched products. */
export function webPrice(bowling, bowlerx, rule = PRICE_RULE) {
  const a = bowling ? num(bowling.price) : null, b = bowlerx ? num(bowlerx.price) : null;
  if (a == null) return b;
  if (b == null) return a;
  if (rule === 'min') return Math.min(a, b);
  if (rule === 'bowlerx') return b;
  return Math.max(a, b);
}

/**
 * vendor_stock rows + matches -> retail columns for every row.
 *
 * Price, in order:
 *   1. In the shop's sheet (shop-prices.csv): the shop's price, always.
 *   2. Otherwise the website price (webPrice), but never lower than the
 *      price already saved: a lower one is ignored, a higher one replaces it
 *      and is listed in opts.raises so the owner can be told.
 *   3. No match anywhere this run: the saved price and link stay as they are.
 *
 * matches: bowling.com matches by style name. opts: bowlerx (BowlerX matches),
 * shop (matchShop result), attrs (bowling.com filter values by url, or null
 * to leave retail_attrs out), withSource (write price_source), rule, raises
 * (an array to push { name, category, old, price, url } onto).
 */
export function retailRows(rows, matches, now, attrs = null, opts = {}) {
  const { bowlerx = new Map(), shop = new Map(), withSource = false, rule = PRICE_RULE, raises = null } = opts;
  const raised = new Set();
  return rows.map((r) => {
    const name = styleName(r);
    const m = matches.get(name);
    const bp = m && m.ok ? m.product : null;
    const xm = bowlerx.get(name);
    const xp = xm && xm.ok ? xm.product : null;
    const sm = shop.get(name);
    const p = bp || xp; // name, link and picture: bowling.com first
    const old = num(r.consumer_price);
    const oldSource = r.price_source || null;

    let price, source;
    if (sm) {
      price = sm.item.price;
      source = 'shop';
    } else {
      const web = webPrice(bp, xp, rule);
      if (web == null) {
        price = old;
        source = oldSource;
      } else if (old != null && oldSource !== 'shop' && web < old) {
        price = old;
        source = 'web';
      } else {
        if (old != null && oldSource !== 'shop' && web > old && raises && !raised.has(name)) {
          raised.add(name);
          raises.push({ name, category: r.category, old, price: web, url: (p && p.url) || r.retail_url || '' });
        }
        price = web;
        source = 'web';
      }
    }

    const out = {
      vendor: r.vendor,
      item_code: r.item_code,
      consumer_price: price,
      // Nothing matched this run: keep what was saved rather than blank it.
      retail_name: p ? p.name : (r.retail_name ?? null),
      retail_url: p ? p.url : (r.retail_url ?? null),
      // A same-model match in another color keeps the price but not the picture.
      retail_image: p ? ((p === bp && m.samePicture === false) ? null : p.image || null) : (r.retail_image ?? null),
      retail_checked_at: now,
    };
    if (attrs) out.retail_attrs = bp ? attrsFor(attrs.get(bp.url), m) : (p ? null : (r.retail_attrs ?? null));
    if (withSource) out.price_source = price == null ? null : source;
    return out;
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
  const hasSource = rows.length > 0 && 'price_source' in rows[0];
  let attrs = null;
  if (hasColumn || dryRun) {
    console.log('\nReading bowling.com filters');
    attrs = await crawlFacets(RETAIL_CATEGORIES);
    const tagged = new Set(rows.map(styleName).filter((n) => { const m = matches.get(n); return m?.ok && attrs.has(m.product.url); }));
    console.log(`  ${attrs.size} bowling.com products tagged; ${tagged.size} matched styles have filter values`);
  } else {
    console.log('\nretail_attrs column not there yet, skipping bowling.com filters');
  }

  // bowlerx.com and bowlingball.com refuse GitHub's servers, so their prices
  // are downloaded on the shop's computer (scraper/fetch_other_prices.py) and
  // committed as other-prices.csv. Per style, the higher matched one counts.
  const otherProducts = loadOtherPrices();
  const bowlerx = bestOf([...new Set(otherProducts.map((p) => p.source))]
    .map((src) => matchNames(items, otherProducts.filter((p) => p.source === src))));
  console.log(`\n${otherProducts.length} bowlerx.com / bowlingball.com prices from other-prices.csv`);

  // The shop's own prices win over both websites.
  const shopItems = loadShopPrices();
  const shop = matchShop(items, shopItems);

  const raises = [];
  const out = retailRows(rows, matches, new Date().toISOString(), hasColumn && attrs?.size ? attrs : null,
    { bowlerx, shop, withSource: hasSource, raises });

  // One line per in-stock style, for checking the result.
  const seen = new Set();
  let fromShop = 0, fromWeb = 0, none = 0;
  console.log(`\nPrices (rule: ${PRICE_RULE}), in-stock styles:`);
  rows.forEach((r, i) => {
    const n = styleName(r);
    if (r.qty_total <= 0 || seen.has(n)) return;
    seen.add(n);
    const sm = shop.get(n), bm = matches.get(n), xm = bowlerx.get(n);
    const o = out[i];
    if (sm) fromShop++; else if (o.consumer_price != null) fromWeb++; else none++;
    console.log('PRICE_REVIEW ' + JSON.stringify({
      category: r.category, ace: n, old: r.consumer_price ?? null, price: o.consumer_price,
      source: sm ? 'shop' : (o.consumer_price != null ? 'web' : ''),
      shop: sm ? `${sm.item.name} $${sm.item.price}` : '',
      bowling: bm?.ok ? `${bm.product.name} $${bm.product.price}` : '',
      other: xm?.ok ? `${xm.product.name} $${xm.product.price} (${xm.product.source})` : '',
    }));
  });
  console.log(`  ${fromShop} from the shop's prices (${shopItems.length} in the sheet), ${fromWeb} from the websites, ${none} with no price`);
  console.log(`  ${raises.length} website price${raises.length === 1 ? '' : 's'} went up`);
  for (const x of raises) console.log(`    ${x.name}: $${x.old} -> $${x.price}`);

  if (dryRun) { console.log('\nDry run: nothing saved.'); return; }
  await upsertRows('vendor_stock', out, 'vendor,item_code');
  console.log(`\nSaved prices on ${out.filter((r) => r.consumer_price != null).length} of ${out.length} rows.`);
  if (raises.length) await notifyRaises(raises);
}

/** other-prices.csv -> [{ source, category, name, price, url, image }]; [] when absent. */
export function loadOtherPrices(path = new URL('./other-prices.csv', import.meta.url)) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(',');
  const at = (k) => head.indexOf(k);
  return lines.map((line) => {
    const c = splitCsvLine(line);
    return { source: c[at('source')], category: c[at('category')], name: c[at('name')], price: Number(c[at('price')]), url: c[at('url')] || '', image: '' };
  }).filter((p) => p.name && p.price > 0);
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Several match maps -> one, keeping the trusted match with the higher price. */
export function bestOf(maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [name, r] of m) {
      if (!r?.ok) { if (!out.has(name)) out.set(name, r); continue; }
      const cur = out.get(name);
      if (!cur?.ok || Number(r.product.price) > Number(cur.product.price)) out.set(name, r);
    }
  }
  return out;
}

/** A GitHub issue listing the raised prices; GitHub emails the mention. */
export function raiseIssue(raises, login) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = raises.map((x) => `| ${x.category} | ${x.url ? `[${x.name}](${x.url})` : x.name} | $${Number(x.old).toFixed(2)} | $${Number(x.price).toFixed(2)} |`);
  return {
    title: `Website prices went up on ${raises.length} item${raises.length === 1 ? '' : 's'} (${date})`,
    body: `${login ? '@' + login + ' ' : ''}The daily price check found higher prices online and raised these on the Shoes and Bags pages. ` +
      `Lower prices are always ignored, and items in the shop's own price list are never changed.\n\n` +
      `| Category | Item (Ace Mitchell name) | Was | Now |\n|---|---|---|---|\n${lines.join('\n')}\n`,
  };
}

async function notifyRaises(raises) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) { console.log('No GITHUB_TOKEN, price-raise issue not opened'); return; }
  const issue = raiseIssue(raises, process.env.NOTIFY_LOGIN);
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(issue),
  });
  console.log(res.ok ? `Opened price-raise issue: ${(await res.json()).html_url}` : `Price-raise issue failed: ${res.status} ${await res.text()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
