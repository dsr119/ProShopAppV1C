/**
 * Bowling.com's filter panel -> attributes for each bag and shoe, so the
 * website's Shoes and Bags pages can filter by them.
 *
 * Bowling.com doesn't print these on the listing cards, but its filter panel
 * is a plain GET form ("?bag-type=17", "?width=15"). So for each filter we
 * want, every option is read off the panel and its filtered listing is
 * crawled; every product on it gets that option. A product that shows up
 * under "Wide" is a wide shoe, and so on.
 *
 * Result: Map(product url -> { bag_type: ['Roller/Tote'], balls_held: ['3'],
 * holds_shoes: true, ... }). Each filter is a list, since bowling.com files
 * some products under more than one option (several colors, say).
 */

import { parseRetailListing } from './bowling-retail.mjs';

const MAX_PAGES = 40;
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'User-Agent': 'Mozilla/5.0 (compatible; PerfexxxxionProShop Bowling Catalog Importer)',
};

// Which bowling.com filters to read, per category, and the key each is saved
// under. onlyTrue: a yes/no filter where only the "True" option is
// crawled; it is saved as true rather than a list.
export const FACETS = {
  Bags: [
    { param: 'bag-type', key: 'bag_type' },
    { param: 'balls-held', key: 'balls_held' },
    { param: 'holds-shoes', key: 'holds_shoes', onlyTrue: true },
    { param: 'brand', key: 'brand' },
    { param: 'color', key: 'color' },
  ],
  Shoes: [
    { param: 'gender', key: 'gender' },
    { param: 'shoe-performance', key: 'performance' },
    { param: 'width', key: 'width' },
    { param: 'hand', key: 'hand' },
    { param: 'brand', key: 'brand' },
    { param: 'color', key: 'color' },
  ],
};

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/**
 * The options of each filter on a bowling.com listing page:
 * { 'bag-type': [{ value: '17', label: 'Roller' }, ...], ... }. "All" (value 0)
 * is left out.
 */
export function parseFacetOptions(html) {
  const labels = new Map();
  for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)) {
    labels.set(m[1], decode(m[2].replace(/<[^>]+>/g, ' ')));
  }
  const out = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type="(radio|checkbox)"/i.test(tag)) continue;
    const id = (tag.match(/\bid="([^"]+)"/i) || [])[1];
    const name = (tag.match(/\bname="([^"]+)"/i) || [])[1];
    const value = (tag.match(/\bvalue="([^"]*)"/i) || [])[1];
    if (!name || value == null || value === '0' || !id || !labels.has(id)) continue;
    (out[name] = out[name] || []).push({ value, label: labels.get(id) });
  }
  return out;
}

async function crawlListing(url, { fetchImpl, wait }) {
  const urls = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    await wait();
    const pageUrl = page === 1 ? url : `${url}&page=${page}`;
    const response = await fetchImpl(pageUrl, { headers: HEADERS, redirect: 'follow' });
    if (!response.ok) throw new Error(`${pageUrl} answered ${response.status}`);
    const fresh = parseRetailListing(await response.text(), pageUrl).filter((p) => p.url && !seen.has(p.url));
    if (!fresh.length) break;
    for (const p of fresh) { seen.add(p.url); urls.push(p.url); }
  }
  return urls;
}

/**
 * categories: [{ category, url }] (bowling-retail's RETAIL_CATEGORIES).
 * Returns Map(product url -> attrs). A filter that fails is logged and
 * skipped, so one bad page costs that filter, not the prices.
 */
export async function crawlFacets(categories, { fetchImpl = fetch, log = console.log, delayMs = 1000, facets = FACETS } = {}) {
  const attrs = new Map();
  let first = true;
  const wait = () => {
    const p = first ? Promise.resolve() : new Promise((r) => setTimeout(r, delayMs));
    first = false;
    return p;
  };
  for (const { category, url } of categories) {
    const wanted = facets[category] || [];
    if (!wanted.length) continue;
    await wait();
    const response = await fetchImpl(url, { headers: HEADERS, redirect: 'follow' });
    if (!response.ok) { log(`  ${url} answered ${response.status}, no filters for ${category.toLowerCase()}`); continue; }
    const options = parseFacetOptions(await response.text());
    for (const f of wanted) {
      let opts = options[f.param] || [];
      if (f.onlyTrue) opts = opts.filter((o) => /^(true|yes)$/i.test(o.label));
      if (!opts.length) { log(`  ${category} filter "${f.param}" not found on bowling.com`); continue; }
      let tagged = 0;
      for (const o of opts) {
        let urls;
        try {
          urls = await crawlListing(`${url}?${encodeURIComponent(f.param)}=${encodeURIComponent(o.value)}`, { fetchImpl, wait });
        } catch (err) {
          log(`  ${category} ${f.param}=${o.label}: ${err.message}, skipped`);
          continue;
        }
        const value = o.label;
        for (const u of urls) {
          const a = attrs.get(u) || {};
          if (f.onlyTrue) a[f.key] = true;
          else { a[f.key] = a[f.key] || []; if (!a[f.key].includes(value)) a[f.key].push(value); }
          attrs.set(u, a);
          tagged++;
        }
      }
      log(`  ${category} ${f.param}: ${opts.length} options, ${tagged} products tagged`);
    }
  }
  return attrs;
}
