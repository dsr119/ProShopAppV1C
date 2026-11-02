/**
 * Reads SKUs, names, pictures and links for bags, shoes and balls from Ace
 * Mitchell's public catalog (acemitchell.com/con/bags, /con/shoes, /con/balls), so the
 * stock check knows which codes to ask about.
 *
 * Written without being able to see the site's HTML (it is blocked from where
 * this was built), so the parsing is deliberately loose: it finds every
 * "SKU: <code>" on a listing page and takes the nearest product link and
 * picture before it. robots.txt asks for 20 seconds between requests.
 */

export const SITE = 'https://www.acemitchell.com';
export const CATEGORIES = ['/con/bags', '/con/shoes', '/con/balls'];
export const CRAWL_DELAY_MS = 20_000;
const MAX_PAGES_PER_CATEGORY = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function absolute(href, base) {
  try { return new URL(decode(href), base).href; } catch { return null; }
}

/** Products on one listing page: [{ sku, name, image_url, product_url }]. */
export function parseListing(html, pageUrl) {
  const clean = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const products = [];
  const seen = new Set();
  const skuRe = /SKU\s*:?\s*(?:<[^>]*>\s*)*([A-Z0-9][A-Z0-9 .\-]{2,30}?)\s*</gi;
  for (const m of clean.matchAll(skuRe)) {
    const sku = m[1].trim();
    if (seen.has(sku)) continue;
    seen.add(sku);
    // Look back from the SKU, but not past the previous product's SKU.
    const prev = clean.lastIndexOf('SKU', m.index - 1);
    const before = clean.slice(Math.max(0, prev, m.index - 4000), m.index);

    let name = null, product_url = null;
    for (const a of before.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const t = text(a[2]);
      if (t && t.length > 2 && !/^(add to cart|view|details|quick ?view)$/i.test(t)) {
        name = t; product_url = absolute(a[1], pageUrl);
      }
    }
    let image_url = null;
    for (const img of before.matchAll(/<img\b[^>]*>/gi)) {
      const src = img[0].match(/\b(?:data-src|data-original|src)=["']([^"']+)["']/i);
      if (src && !/^data:/.test(src[1])) image_url = absolute(src[1], pageUrl);
      if (!name) { const alt = img[0].match(/\balt=["']([^"']+)["']/i); if (alt) name = decode(alt[1]).trim(); }
    }
    if (!name) {
      // Fall back to the last line of text before the SKU.
      const t = text(before).split(/ {2,}|\$\d/).filter(Boolean).pop();
      name = t ? t.slice(-120).trim() : null;
    }
    // Informational only: the API's numbers are what count.
    const out_of_stock_on_site = /out of stock/i.test(text(before));
    products.push({ sku, name, image_url, product_url, out_of_stock_on_site });
  }
  return products;
}

/** Further pages of the same category linked from this one (?page=2, /page/2 ...). */
export function pageLinks(html, pageUrl, categoryPath) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const url = absolute(m[1], pageUrl);
    if (!url || !url.startsWith(SITE)) continue;
    const u = new URL(url);
    if (u.pathname.replace(/\/$/, '') !== categoryPath && !u.pathname.startsWith(categoryPath + '/page')) continue;
    if (/[?&](p|page|pg|pagenumber|start|offset)=\d+/i.test(u.search) || /\/page\/\d+/.test(u.pathname)) {
      u.hash = '';
      links.add(u.href);
    }
  }
  return [...links];
}

export async function crawlCatalog({ fetchImpl = fetch, delayMs = CRAWL_DELAY_MS, log = console.log, categories = CATEGORIES } = {}) {
  const bySku = new Map();
  let first = true;
  for (const path of categories) {
    const category = path.split('/').pop();
    const queue = [SITE + path];
    const visited = new Set();
    while (queue.length && visited.size < MAX_PAGES_PER_CATEGORY) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      if (!first) await sleep(delayMs);
      first = false;
      const response = await fetchImpl(url, { headers: { 'User-Agent': 'PerfexxxionProShop stock check (dealer)' } });
      if (!response.ok) { log(`  ${url} answered ${response.status}, skipping`); continue; }
      const html = await response.text();
      const products = parseListing(html, url);
      let added = 0;
      for (const p of products) {
        if (!bySku.has(p.sku)) { bySku.set(p.sku, { ...p, site_category: category }); added++; }
      }
      log(`  ${url}: ${products.length} products, ${added} new`);
      for (const next of pageLinks(html, url, path)) if (!visited.has(next)) queue.push(next);
    }
  }
  return [...bySku.values()];
}
