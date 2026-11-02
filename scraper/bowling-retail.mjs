/**
 * Bowling.com bags and shoes -> consumer price, picture and link for the
 * Ace Mitchell items we can get.
 *
 * Bowling.com shows no UPC, and its SKUs ("ST3409BLKBLU") don't match Ace
 * Mitchell's codes, so items are matched by name: both names are cut into
 * words, colors and abbreviations are spelled out the same way ("Blk" ->
 * black, "Double" -> 2), brand and filler words are dropped, and the
 * bowling.com item sharing the most words wins. Gender, hand and width must
 * agree, so a Men's shoe never takes a Women's price.
 */

import { parseProductsFromJsonLd_, parseProductCardsFromHtml_ } from './rules.mjs';

export const RETAIL_CATEGORIES = [
  { category: 'Bags', url: 'https://www.bowling.com/shopping/all/bowling-bags/all' },
  { category: 'Shoes', url: 'https://www.bowling.com/shopping/all/bowling-shoes/all' },
];
const MAX_PAGES = 40;
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'User-Agent': 'Mozilla/5.0 (compatible; PerfexxxxionProShop Bowling Catalog Importer)',
};

/** Products on one bowling.com listing page: [{ name, price, url, image }]. */
export function parseRetailListing(html, url) {
  const structured = parseProductsFromJsonLd_(html, '', url);
  if (structured.length) return structured;
  // The card fallback was written for balls and skips cards whose
  // data-category isn't "balls", so hide that attribute from it here.
  return parseProductCardsFromHtml_(html.replace(/\bdata-category=/gi, 'data-x-category='), '', url);
}

export async function crawlRetail({ fetchImpl = fetch, log = console.log, delayMs = 1000, categories = RETAIL_CATEGORIES } = {}) {
  const all = [];
  for (const { category, url } of categories) {
    const seen = new Set();
    let page = 1;
    for (; page <= MAX_PAGES; page++) {
      if (page > 1 || all.length) await new Promise((r) => setTimeout(r, delayMs));
      const pageUrl = page === 1 ? url : `${url}?page=${page}`;
      const response = await fetchImpl(pageUrl, { headers: HEADERS, redirect: 'follow' });
      if (!response.ok) { log(`  ${pageUrl} answered ${response.status}, stopping`); break; }
      const products = parseRetailListing(await response.text(), pageUrl);
      const fresh = products.filter((p) => p.url && !seen.has(p.url));
      if (!fresh.length) break; // past the last page
      for (const p of fresh) { seen.add(p.url); all.push({ ...p, category }); }
    }
    log(`  bowling.com ${category.toLowerCase()}: ${seen.size} products on ${page - 1} pages`);
  }
  return all;
}

// ---- name matching ------------------------------------------------------

const SPELLINGS = {
  blk: 'black', bk: 'black', blck: 'black', wht: 'white', wh: 'white', grey: 'gray', gry: 'gray', gy: 'gray',
  blu: 'blue', bl: 'blue', nvy: 'navy', nv: 'navy', pnk: 'pink', pk: 'pink', prpl: 'purple', pur: 'purple', purp: 'purple',
  slv: 'silver', slvr: 'silver', sil: 'silver', grn: 'green', gr: 'green', org: 'orange', orng: 'orange', brn: 'brown', br: 'brown',
  char: 'charcoal', chr: 'charcoal', roy: 'royal', ryl: 'royal', rd: 'red', ylw: 'yellow', yel: 'yellow', yllw: 'yellow',
  gld: 'gold', tan: 'tan', teal: 'teal', aqua: 'teal', lt: 'light', dk: 'dark', camo: 'camo', multi: 'multi',
  men: 'mens', mens: 'mens', mns: 'mens', women: 'womens', womens: 'womens', wmns: 'womens', wms: 'womens',
  ladies: 'womens', lady: 'womens', ladys: 'womens', youth: 'youth', yth: 'youth', kids: 'youth', kid: 'youth',
  junior: 'youth', jr: 'youth', boys: 'youth', girls: 'youth',
  rh: 'right', right: 'right', lh: 'left', left: 'left', wd: 'wide', wide: 'wide',
  single: '1', one: '1', double: '2', two: '2', dbl: '2', triple: '3', three: '3', trpl: '3', four: '4', quad: '4', '4ball': '4',
  '1ball': '1', '2ball': '2', '3ball': '3', without: 'no', wo: 'no', w_o: 'no',
};

const DROP = new Set([
  'bowling', 'bag', 'bags', 'shoe', 'shoes', 'size', 'sizes', 'hand', 'handed', 'the', 'with', 'and', 'a', 'of', 'for', 'ball', 'balls',
  'in', 'new', 'edition', 'only',
  // brands: Ace Mitchell often leaves them off its names
  'storm', 'roto', 'grip', 'brunswick', 'dexter', 'hammer', 'motiv', 'ebonite', 'track', 'columbia', '300', 'dv8', 'radical',
  '900', 'global', 'kr', 'strikeforce', 'linds', 'etonic', '3g', 'vise', 'pyramid', 'elite', 'bsi', 'moxy', 'genesis', 'tenth',
  'frame', 'ebi', 'turbo', 'master', 'ultra', 'bowlerstore', 'brunswick', 'sp', 'by',
]);

const GROUPS = [
  ['mens', 'womens', 'youth'],
  ['right', 'left'],
  ['wide'],
];

export function nameTokens(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/w\/o/g, ' without ')
    .replace(/&/g, ' and ')
    .replace(/'s\b/g, 's')
    .replace(/(\d)\s*-?\s*ball\b/g, '$1ball ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ');
  const out = new Set();
  for (const w of words) {
    if (!w) continue;
    const t = SPELLINGS[w] || w;
    if (!DROP.has(t)) out.add(t);
  }
  return out;
}

function groupsAgree(a, b) {
  for (const g of GROUPS) {
    const ga = g.filter((t) => a.has(t));
    const gb = g.filter((t) => b.has(t));
    if (g.length === 1) { if (ga.length !== gb.length) return false; continue; }
    if (ga.length && gb.length && ga.join() !== gb.join()) return false;
    // Hand matters both ways for shoes: a right-hand shoe isn't a left one.
    if (g[0] === 'right' && ga.join() !== gb.join()) return false;
  }
  return true;
}

export function similarity(a, b) {
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return a.size + b.size ? (2 * common) / (a.size + b.size) : 0;
}

export const MIN_SCORE = 0.75;

/**
 * For each Ace Mitchell name, the best bowling.com product in the same
 * category. Returns Map(name -> { product, score, second, ok }); ok is false
 * when the best is too weak or too close to the runner-up to trust.
 */
export function matchNames(aceItems, retail, { minScore = MIN_SCORE } = {}) {
  const pool = retail.map((p) => ({ p, tokens: nameTokens(p.name) }));
  const result = new Map();
  for (const { name, category } of aceItems) {
    if (result.has(name)) continue;
    const a = nameTokens(name);
    let best = null, second = 0;
    for (const { p, tokens } of pool) {
      if (p.category !== category || !groupsAgree(a, tokens)) continue;
      const s = similarity(a, tokens);
      if (!best || s > best.score) { second = best ? best.score : 0; best = { product: p, score: s }; }
      else if (s > second) second = s;
    }
    // A near tie means the name doesn't tell two products apart: skip it.
    result.set(name, best
      ? { ...best, second, ok: best.score >= minScore && best.score - second >= 0.05 }
      : { product: null, score: 0, second: 0, ok: false });
  }
  return result;
}
