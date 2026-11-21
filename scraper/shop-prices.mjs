/**
 * The shop's own prices (Square item export) for bags and shoes. A bag or
 * shoe in this list always shows the shop's price on the website.
 *
 * scraper/shop-prices.csv is cut down from Square's catalog export
 * (Items -> Export): category, item name, variation and price, active bags and
 * shoes only. To refresh it, export again and run
 *   python3 scraper/shop-prices-from-square.py <export.xlsx>
 *
 * Square names are loose ("Brunswick Avalanche", no color or gender), so a
 * Square item applies to an Ace Mitchell style when every word of the Square
 * name is in the Ace name: "Avalanche" covers "Avalanche Black/Gold Mens" in
 * every color. The Square item with the most matching words wins; brand,
 * gender, hand and width must not disagree.
 */

import { readFileSync } from 'node:fs';
import { nameTokens, brandOf } from './bowling-retail.mjs';

// Variations that are a size or "Regular" say nothing about which style it is.
const PLAIN_VARIATION = /^(regular|standard|one size|x{0,2}-?(small|large)|medium|l\/xl|\d+(\.\d)?|youth.*|)$/i;

/** CSV text -> [{ category, name, price }] with color variations folded into the name. */
export function parseShopPrices(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsv(lines.shift() || '');
  const at = (k) => header.indexOf(k);
  const out = new Map();
  for (const line of lines) {
    const c = splitCsv(line);
    const category = c[at('category')], name = (c[at('name')] || '').trim(), variation = (c[at('variation')] || '').trim();
    const price = Number(c[at('price')]);
    if (!name || !(price > 0) || (category !== 'Bags' && category !== 'Shoes')) continue;
    const full = PLAIN_VARIATION.test(variation) ? name : `${name} ${variation}`;
    const key = category + '|' + full.toLowerCase();
    // Sizes of one shoe are separate rows; keep the highest price seen.
    const prev = out.get(key);
    if (!prev || price > prev.price) out.set(key, { category, name: full, price });
  }
  return [...out.values()];
}

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function loadShopPrices(path = new URL('./shop-prices.csv', import.meta.url)) {
  return parseShopPrices(readFileSync(path, 'utf8'));
}

const GROUPS = [['mens', 'womens', 'youth'], ['right', 'left'], ['wide']];

/** Square name s may apply to Ace name a: s's gender/hand/width don't contradict a's. */
function compatible(s, a) {
  for (const g of GROUPS) {
    const gs = g.filter((t) => s.has(t)), ga = g.filter((t) => a.has(t));
    if (gs.length && gs.join() !== ga.join()) return false;
  }
  return true;
}

/**
 * For each Ace Mitchell { name, category }, the shop item that covers it:
 * Map(name -> { item, words } | null). Two equally specific items with
 * different prices make it ambiguous, so no shop price.
 */
export function matchShop(aceItems, shopItems) {
  const pool = shopItems.map((s) => ({ s, tokens: nameTokens(s.name), brand: brandOf(s.name) }))
    .filter((p) => p.tokens.size > 0);
  const result = new Map();
  for (const { name, category } of aceItems) {
    if (result.has(name)) continue;
    const a = nameTokens(name);
    const brand = brandOf(name);
    let best = null, tie = false;
    for (const { s, tokens, brand: sb } of pool) {
      if (s.category !== category) continue;
      if (brand && sb && brand !== sb) continue;
      let all = true;
      for (const t of tokens) if (!a.has(t)) { all = false; break; }
      if (!all || !compatible(tokens, a)) continue;
      const words = tokens.size;
      if (!best || words > best.words) { best = { item: s, words }; tie = false; }
      else if (words === best.words && s.price !== best.item.price) tie = true;
    }
    result.set(name, best && !tie ? best : null);
  }
  return result;
}
