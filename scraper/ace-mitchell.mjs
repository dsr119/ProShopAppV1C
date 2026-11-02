#!/usr/bin/env node
/**
 * Ace Mitchell stock check: asks Ace Mitchell's NetSuite "price and
 * availability" service about every item code in ace-mitchell-items.txt and
 * saves the answers to the Supabase `vendor_stock` table.
 *
 * The service only looks items up by code; it cannot list what Ace Mitchell
 * carries. So the codes to check come from the list file (or ACE_ITEM_CODES
 * for a one-off test). Codes look like "BR157 12": the product number, a
 * space, then the size or weight.
 *
 * Env:
 *   ACE_MITCHELL_EMAIL, ACE_MITCHELL_PASSWORD  the dealer login (Actions secrets only)
 *   ACE_ITEM_CODES   optional: comma- or newline-separated codes to check
 *                    instead of the list file
 *   DRY_RUN=1        print what came back, save nothing
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   for saving
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ACCOUNT = '3727826';
export const ROLE = '1005';
export const ENDPOINT = `https://${ACCOUNT}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=15&deploy=1`;
// Ace Mitchell's docs say about 64 items per request before it may time out.
export const BATCH_SIZE = 50;

/** Item codes from a text file or env string: one per line or comma separated, # comments allowed. */
export function parseItemCodes(text) {
  const seen = new Set();
  const codes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const part of line.replace(/#.*/, '').split(',')) {
      const code = part.trim().replace(/\s+/g, ' ');
      if (code && !seen.has(code.toUpperCase())) {
        seen.add(code.toUpperCase());
        codes.push(code);
      }
    }
  }
  return codes;
}

export function buildUrl(codes) {
  return `${ENDPOINT}&itemCodes=${codes.map(encodeURIComponent).join(',')}`;
}

export function authHeader(email, password) {
  return `NLAuth nlauth_account=${ACCOUNT}, nlauth_email=${email}, nlauth_signature=${password}, nlauth_role=${ROLE}`;
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : null;
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The service's XML -> { found: [...], errors: [{ item_code, error }] }.
 * A response that is not PriceAndAvailabilityResponse (bad login, NetSuite
 * error page) throws, so a broken run never wipes the table.
 */
export function parseResponse(xml) {
  if (!/<PriceAndAvailabilityResponse[\s>]/.test(xml)) {
    throw new Error('Unexpected reply from Ace Mitchell: ' + String(xml).slice(0, 300));
  }
  const found = [];
  const errors = [];
  for (const [, body] of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const item_code = tag(body, 'ItemCode');
    const error = tag(body, 'Error');
    if (error) { errors.push({ item_code, error }); continue; }
    const avail = tag(body, 'Availability') !== null ? body.match(/<Availability>([\s\S]*?)<\/Availability>/)[1] : '';
    const price = parseFloat(tag(body, 'NetPrice'));
    found.push({
      item_code,
      display_name: tag(body, 'DisplayName') || tag(body, 'SalesDescription'),
      sales_description: tag(body, 'SalesDescription'),
      upc: tag(body, 'UPCCode'),
      category: tag(body, 'ParentClass_Category'),
      net_price: Number.isFinite(price) ? price : null,
      qty_oh: int(tag(avail, 'OH')),
      qty_ny: int(tag(avail, 'NY')),
      qty_tn: int(tag(avail, 'TN')),
      qty_total: int(tag(avail, 'Total')),
    });
  }
  return { found, errors };
}

export async function checkStock(codes, { email, password, fetchImpl = fetch, log = console.log } = {}) {
  if (!email || !password) throw new Error('ACE_MITCHELL_EMAIL and ACE_MITCHELL_PASSWORD must be set.');
  const found = [];
  const errors = [];
  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    const response = await fetchImpl(buildUrl(batch), {
      headers: { Authorization: authHeader(email, password), 'Content-Type': 'text/plain' },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Ace Mitchell answered ${response.status}: ${text.slice(0, 300)}`);
    const result = parseResponse(text);
    found.push(...result.found);
    errors.push(...result.errors);
    log(`Checked ${Math.min(i + BATCH_SIZE, codes.length)} of ${codes.length}`);
  }
  return { found, errors };
}

async function main() {
  const listFile = new URL('./ace-mitchell-items.txt', import.meta.url);
  const codes = parseItemCodes(process.env.ACE_ITEM_CODES || fs.readFileSync(listFile, 'utf8'));
  if (!codes.length) {
    console.log('No item codes to check. Add them to scraper/ace-mitchell-items.txt.');
    return;
  }
  const { found, errors } = await checkStock(codes, {
    email: process.env.ACE_MITCHELL_EMAIL,
    password: process.env.ACE_MITCHELL_PASSWORD,
  });

  console.log(`\nFound ${found.length}, in stock ${found.filter((r) => r.qty_total > 0).length}, not found ${errors.length}\n`);
  for (const r of found) {
    console.log(`  ${r.item_code.padEnd(14)} ${String(r.qty_total).padStart(4)} in stock  (OH ${r.qty_oh} / NY ${r.qty_ny} / TN ${r.qty_tn})  ${r.category || ''}  ${r.display_name || ''}`);
  }
  for (const e of errors) console.log(`  ${String(e.item_code).padEnd(14)} ERROR ${e.error}`);

  if (process.env.DRY_RUN === '1') { console.log('\nDry run: nothing saved.'); return; }
  if (!found.length) return;
  const { upsertRows } = await import('./supabase.mjs');
  const checked_at = new Date().toISOString();
  await upsertRows('vendor_stock', found.map((r) => ({ vendor: 'Ace Mitchell', ...r, checked_at })), 'vendor,item_code');
  console.log(`Saved ${found.length} rows to vendor_stock.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
