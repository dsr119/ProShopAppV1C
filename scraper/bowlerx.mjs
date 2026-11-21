/**
 * BowlerX bags and shoes -> second consumer price source next to bowling.com.
 *
 * BowlerX is a WooCommerce store, so its public Store API lists products as
 * JSON, 100 at a time (about 12 requests for both categories) instead of the
 * 88 HTML listing pages.
 *
 * Prices come back in cents. BowlerX runs sales often, so both the regular
 * and the sale price are kept; price is the regular one.
 */

export const BOWLERX_CATEGORIES = [
  { category: 'Bags', slug: 'bowling-bags' },
  { category: 'Shoes', slug: 'bowling-shoes' },
];
const API = 'https://www.bowlerx.com/wp-json/wc/store/v1/products';
const PER_PAGE = 100;
const MAX_PAGES = 30;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; PerfexxxxionProShop Bowling Catalog Importer)',
};

const decode = (s) => String(s || '')
  .replace(/&#8211;|&ndash;/g, '-').replace(/&#8217;|&#039;|&#39;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();

/** One Store API product -> { name, price, sale, url, image, inStock } or null. */
export function parseBowlerxProduct(p) {
  const pr = p && p.prices;
  if (!pr) return null;
  const unit = Number(pr.currency_minor_unit ?? 2);
  const toDollars = (v) => (v == null || v === '' || isNaN(+v) ? null : Math.round(+v * 100 / 10 ** unit) / 100);
  const regular = toDollars(pr.regular_price) ?? toDollars(pr.price);
  const now = toDollars(pr.price);
  if (!regular) return null;
  return {
    name: decode(p.name),
    price: regular,
    sale: now != null && now < regular ? now : null,
    url: p.permalink || '',
    image: (p.images && p.images[0] && p.images[0].src) || '',
    inStock: p.is_in_stock !== false,
  };
}

export async function crawlBowlerx({ fetchImpl = fetch, log = console.log, delayMs = 1000, categories = BOWLERX_CATEGORIES } = {}) {
  const all = [];
  let first = true;
  for (const { category, slug } of categories) {
    let count = 0, page = 1;
    for (; page <= MAX_PAGES; page++) {
      if (!first) await new Promise((r) => setTimeout(r, delayMs));
      first = false;
      const url = `${API}?category=${slug}&per_page=${PER_PAGE}&page=${page}`;
      const response = await fetchImpl(url, { headers: HEADERS, redirect: 'follow' });
      if (!response.ok) { log(`  ${url} answered ${response.status}, stopping`); break; }
      const batch = await response.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const p of batch) {
        const item = parseBowlerxProduct(p);
        if (item) { all.push({ ...item, category }); count++; }
      }
      if (batch.length < PER_PAGE) { page++; break; }
    }
    log(`  bowlerx.com ${category.toLowerCase()}: ${count} products on ${page - 1} pages`);
  }
  return all;
}
