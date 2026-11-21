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
  blu: 'blue', bl: 'blue', nvy: 'navy', nv: 'navy', pnk: 'pink', pk: 'pink', prpl: 'purple', prp: 'purple', pur: 'purple', purp: 'purple',
  slv: 'silver', slvr: 'silver', sil: 'silver', grn: 'green', gr: 'green', org: 'orange', orng: 'orange', brn: 'brown', br: 'brown',
  char: 'charcoal', chr: 'charcoal', roy: 'royal', ryl: 'royal', rd: 'red', ylw: 'yellow', yel: 'yellow', yllw: 'yellow',
  gld: 'gold', tan: 'tan', teal: 'teal', aqua: 'teal', lt: 'light', dk: 'dark', camo: 'camo', multi: 'multi',
  men: 'mens', mens: 'mens', mns: 'mens', women: 'womens', womens: 'womens', wmns: 'womens', wms: 'womens',
  ladies: 'womens', lady: 'womens', ladys: 'womens', youth: 'youth', yth: 'youth', kids: 'youth', kid: 'youth',
  junior: 'youth', jr: 'youth', boys: 'youth', girls: 'youth',
  rh: 'right', right: 'right', lh: 'left', left: 'left', wd: 'wide', wide: 'wide',
  single: '1', one: '1', double: '2', two: '2', dbl: '2', triple: '3', three: '3', trpl: '3', four: '4', quad: '4', '4ball': '4',
  '1ball': '1', '2ball': '2', '3ball': '3', without: 'no', wo: 'no', w_o: 'no',
  sing: '1', sgl: '1', tourn: 'tournament', trny: 'tournament', ej: 'exj', smk: 'smoke', lavendar: 'lavender',
};

// Color words are scored apart from the model words: a bowling.com listing
// with no color in its name ("Ebonite Backpack") sells every color as an
// option, so it still fits "Ebonite Backpack Blue".
const COLORS = new Set([
  'black', 'white', 'gray', 'blue', 'navy', 'pink', 'purple', 'silver', 'green', 'orange', 'brown', 'charcoal', 'royal', 'red',
  'yellow', 'gold', 'tan', 'teal', 'lime', 'camo', 'leopard', 'mint', 'peach', 'cream', 'violet', 'lavender', 'rose', 'cardinal',
  'amethyst', 'smoke', 'ice', 'light', 'dark', 'multi', 'neon', 'steel', 'stone', 'parchment', 'pewter', 'gunmetal', 'champagne',
  'mauve', 'sky', 'coral', 'berry', 'grape', 'plaid', 'denim', 'chrome', 'rainbow', 'maroon', 'burgundy', 'olive', 'khaki', 'beige',
  'ivory', 'bronze', 'copper', 'turquoise', 'magenta', 'fuchsia', 'indigo', 'cyan', 'ghost', 'midnight',
]);

const DROP = new Set([
  'bowling', 'bag', 'bags', 'shoes', 'size', 'sizes', 'hand', 'handed', 'the', 'with', 'and', 'a', 'of', 'for', 'ball', 'balls',
  'in', 'new', 'edition', 'only', 'width', 'nfl', 'ncaa', 'by',
]);

// Brands are left out of the word comparison (Ace Mitchell often drops them),
// but when both names carry one, it has to be the same brand.
const BRANDS = [
  ['storm'], ['roto', 'grip'], ['brunswick'], ['dexter'], ['hammer'], ['motiv'], ['ebonite'], ['track'], ['columbia', '300'],
  ['dv8'], ['radical'], ['900', 'global'], ['kr', 'strikeforce'], ['kr'], ['linds'], ['etonic'], ['3g'], ['vise'], ['pyramid'],
  ['bsi'], ['moxy'], ['genesis'], ['global'],
];
const BRAND_WORDS = new Set(BRANDS.flat());

const GROUPS = [
  ['mens', 'womens', 'youth'],
  ['right', 'left'],
  ['wide'],
];

function words(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\*+[^*]*\*+/g, ' ') // "**NEW 2024**", "*ADD OBC*"
    .replace(/w\/o/g, ' without ')
    .replace(/w\//g, ' with ')
    .replace(/&/g, ' and ')
    .replace(/'s\b/g, 's')
    .replace(/\bdex\s+lite\b/g, 'dexlite')
    .replace(/\bcarry\s+all\b/g, 'carryall')
    .replace(/\b([a-z])-(\d)\b/g, '$1$2') // C-9 is C9
    .replace(/(\d)\s*-?\s*ball\b/g, '$1ball ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** The brand named in a name, or null. */
export function brandOf(name) {
  const w = words(name);
  // Turbo is a grip and bag brand but also a Dexter shoe ("Turbo BOA"), so
  // only a leading "Turbo" counts as the brand.
  if (w[0] === 'turbo') return 'turbo';
  for (const b of BRANDS) {
    for (let i = 0; i + b.length <= w.length; i++) {
      if (b.every((t, j) => w[i + j] === t)) return b[0] === 'global' ? '900' : b[0];
    }
  }
  return null;
}

function tokenList(name) {
  const out = [];
  for (const w of words(name)) {
    const t = SPELLINGS[w] || w;
    if (DROP.has(t) || BRAND_WORDS.has(t) || /^20\d\d$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function nameTokens(name) {
  return new Set(tokenList(name));
}

/** Bowling.com listings that aren't the new item at its regular price. */
export function isSpecialListing(name) {
  return /almost new|x-?out|blemish|drilled|demo\b|used\b/i.test(name);
}

function groupsAgree(a, b) {
  for (const g of GROUPS) {
    const ga = g.filter((t) => a.has(t));
    const gb = g.filter((t) => b.has(t));
    if (g.length === 1) { if (ga.length !== gb.length) return false; continue; }
    if (ga.length && gb.length && ga.join() !== gb.join()) return false;
    // Hand matters both ways for shoes: a right-hand shoe isn't a left one.
    // "Right Hand or Left Hand" (swappable soles) fits either, or neither.
    if (g[0] === 'right' && gb.length < 2 && ga.join() !== gb.join()) return false;
  }
  return true;
}

/** Same word, or a one-letter typo in a longer word ("Lavendar"). */
function sameWord(x, y) {
  if (x === y) return true;
  if (x.length < 5 || y.length < 5 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

function countCommon(aList, b, bPairs) {
  let common = 0;
  for (let i = 0; i < aList.length; i++) {
    const t = aList[i];
    if (b.has(t) || bPairs.has(t)) { common++; continue; }
    // "Carry All" vs "Carryall": two Ace words that make one bowling.com word.
    if (i + 1 < aList.length && b.has(t + aList[i + 1])) { common += 2; i++; continue; }
    for (const u of b) if (sameWord(t, u)) { common++; break; }
  }
  return common;
}

function prepare(name) {
  const list = tokenList(name);
  const model = list.filter((t) => !COLORS.has(t));
  const pairs = new Set();
  for (let i = 0; i + 1 < model.length; i++) pairs.add(model[i] + model[i + 1]);
  return { set: new Set(list), model, modelSet: new Set(model), colors: new Set(list.filter((t) => COLORS.has(t))), pairs };
}

/**
 * How well bowling.com name b fits Ace Mitchell name a (both names).
 * Model words: mostly "how many of Ace's words does it have" (Ace's names are
 * the shorter, so bowling.com's extras like "2020 NFL Single Tote" cost
 * little), plus overall overlap so the closest fit wins. Colors: the same
 * colors score best; a listing with no colors scores a little less, so a
 * listing in the exact color wins when there is one.
 */
function colorFit(a, b, common) {
  let color;
  // A colorless listing only stands in for "every color" when it has no
  // words of its own beyond Ace's: "Rascal Roller Dye-Sub" is a pattern.
  const generic = !b.colors.size && common >= b.model.length;
  if (!a.colors.size) color = b.colors.size ? 0.85 : 1;
  else if (!b.colors.size) color = generic ? 0.85 : 0;
  else {
    let same = 0;
    for (const c of a.colors) if (b.colors.has(c)) same++;
    color = same / (a.colors.size + b.colors.size - same);
  }
  return color;
}

export function similarity(a, b) {
  if (typeof a === 'string') a = prepare(a);
  if (typeof b === 'string') b = prepare(b);
  if (!a.model.length || !b.model.length) return 0;
  const common = countCommon(a.model, b.modelSet, b.pairs);
  const coverage = common / a.model.length;
  const overlap = Math.min(1, (2 * common) / (a.model.length + b.model.length));
  return 0.55 * coverage + 0.2 * overlap + 0.25 * colorFit(a, b, common);
}

/**
 * Whether bowling.com's picture shows the same item: the colors agree, or
 * Ace's name gives none. Otherwise the price still fits (same model) but
 * the page should show Ace Mitchell's own picture.
 */
function samePicture(a, b) {
  if (!a.colors.size) return true;
  if (a.colors.size !== b.colors.size) return false;
  for (const c of a.colors) if (!b.colors.has(c)) return false;
  return true;
}

export const MIN_SCORE = 0.8;

/**
 * Bowling.com often lists a model in other colors than the one Ace Mitchell
 * has. When every listing that has all of Ace's model words (and at most two
 * of its own) is the same price, that is the model's price: use it, with Ace
 * Mitchell's own picture.
 */
function sameModelOtherColor(a, brand, category, pool) {
  if (a.model.length < 2) return null;
  const fits = pool.filter(({ p, prep, brand: pb }) => {
    if (p.category !== category || !groupsAgree(a.set, prep.set)) return false;
    if (brand && pb !== brand) return false; // a named brand must match
    if (countCommon(a.model, prep.modelSet, prep.pairs) < a.model.length) return false;
    const extra = prep.model.filter((t) => !a.modelSet.has(t) && !a.model.some((x, i) => x + a.model[i + 1] === t));
    return extra.length <= 2;
  });
  if (!fits.length) return null;
  const prices = new Set(fits.map((f) => f.p.price));
  if (prices.size !== 1 || [...prices][0] === '') return null;
  return { product: fits[0].p, score: 0.8, second: 0, ok: true, samePicture: false, otherColor: true };
}

/**
 * For each Ace Mitchell name, the best bowling.com product in the same
 * category. Returns Map(name -> { product, score, second, ok }); ok is false
 * when the best is too weak or too close to the runner-up to trust.
 */
export function matchNames(aceItems, retail, { minScore = MIN_SCORE } = {}) {
  const pool = retail
    .filter((p) => !isSpecialListing(p.name))
    .map((p) => ({ p, prep: prepare(p.name), brand: brandOf(p.name) }));
  const result = new Map();
  for (const { name, category } of aceItems) {
    if (result.has(name)) continue;
    const a = prepare(name);
    const brand = brandOf(name);
    let best = null, runnerUp = null;
    for (const { p, prep, brand: pb } of pool) {
      if (p.category !== category || !groupsAgree(a.set, prep.set)) continue;
      if (brand && pb && brand !== pb && !(brand === 'kr' && pb === 'kr')) continue;
      const s = similarity(a, prep);
      if (!best || s > best.score) {
        if (best) runnerUp = best;
        best = { product: p, score: s, prep };
      } else if (!runnerUp || s > runnerUp.score) runnerUp = { product: p, score: s };
    }
    // A near tie means the name doesn't tell two products apart: skip it,
    // unless the best is a near-perfect fit or both cost the same anyway.
    const second = runnerUp ? runnerUp.score : 0;
    const clear = best && (best.score - second >= 0.03 || (best.score >= 0.95 && best.score > second + 1e-9) ||
      (runnerUp && runnerUp.product.price === best.product.price));
    if (best && !(best.score >= minScore && clear)) {
      const fallback = sameModelOtherColor(a, brand, category, pool);
      if (fallback) { result.set(name, fallback); continue; }
    }
    result.set(name, best
      ? { product: best.product, score: best.score, second, ok: best.score >= minScore && !!clear, samePicture: samePicture(a, best.prep) }
      : { product: null, score: 0, second: 0, ok: false });
  }
  return result;
}
