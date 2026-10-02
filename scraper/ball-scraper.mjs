#!/usr/bin/env node
/**
 * Daily ball catalog refresh: bowling.com + Bowwwl + manufacturer sites ->
 * the `balls` table in Supabase.
 *
 * This is the Apps Script "Refresh all bowling data" pipeline, run by GitHub
 * Actions instead of a Google trigger:
 *
 *   1. Bowwwl database (two pages)   -> spec fallbacks for this run
 *   2. bowling.com, brand by brand   -> add new balls, update existing ones
 *   3. Manufacturer "current" pages  -> Discontinued Yes/No
 *   4. Newest 20 reactive balls      -> is_recent_release
 *
 * Apps Script had to stop every 4.5 minutes and reschedule itself; an Actions
 * job can run for hours, so the paging state machine is just a loop here.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. DRY_RUN=1 scrapes and prints
 * a summary without writing anything.
 */

import { pathToFileURL } from 'url';
import {
  CURRENT_PRODUCTION_SOURCES,
  BOWLING_SCRAPER_HEADERS,
  applyBowwwlFallbacks_,
  applyProductionStatuses_,
  bowwwlProductKey_,
  buildBowwwlDatabaseUrl_,
  buildCatalogUrl_,
  classifyCoreType_,
  classifyCoverFinish_,
  classifyCoverType_,
  emptyProductDetails_,
  excludedCondition_,
  findOfficialProductMatch_,
  isBlank_,
  loadProductStore_,
  normalizeReleaseMonth_,
  parseBowwwlDatabaseHtml_,
  parseCurrentProductionPage_,
  parseProductDetails_,
  parseProductsFromHtml_,
  productId_,
  productToOutputRow_,
  readOutputProducts_,
  upsertProductsIntoStore_,
} from './rules.mjs';
import { SHEET_HEADERS, dbRowToSheetRow, sheetRowsToDbRows, valuesSheet } from './catalog.mjs';
import { deleteRows, selectAll, upsertRows } from './supabase.mjs';

// Same brands and slugs as BOWLING_SCRAPER_CONFIG.brands in the Apps Script.
const BRANDS = [
  ['900 Global', '900-global'],
  ['Brunswick', 'brunswick'],
  ['Columbia 300', 'columbia-300'],
  ['DV8', 'dv8'],
  ['Ebonite', 'ebonite'],
  ['Hammer', 'hammer'],
  ['Motiv', 'motiv'],
  ['Radical', 'radical'],
  ['Roto Grip', 'roto-grip'],
  ['Storm', 'storm'],
  ['Track', 'track'],
];
const PAGE_SIZE = 36;
const DETAIL_CONCURRENCY = 8;
const TIME_ZONE = 'America/New_York';

const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'User-Agent': 'Mozilla/5.0 (compatible; PerfexxxxionProShop Bowling Catalog Importer)',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (response.ok) return await response.text();
      lastError = new Error(`${label} returned HTTP ${response.status} for ${url}`);
      // A 4xx will not change on retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await sleep(attempt * 2000);
  }
  throw lastError;
}

/** fetchProductDetailsBatch_, with fetch() in place of UrlFetchApp.fetchAll. */
async function fetchProductDetailsBatch(products) {
  const results = new Array(products.length);
  let next = 0;
  async function worker() {
    while (next < products.length) {
      const index = next++;
      try {
        results[index] = parseProductDetails_(await fetchPage(products[index].url, 'Bowling.com'));
      } catch (error) {
        console.warn(`Could not read details for ${products[index].url}: ${error.message}`);
        results[index] = emptyProductDetails_();
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  return results;
}

/** currentRunMonth_: "Oct 2026" in the shop's time zone. */
function currentRunMonth() {
  const parts = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: TIME_ZONE })
    .formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('month')} ${get('year')}`;
}

// --- 1. Bowwwl database -----------------------------------------------------

/** refreshBowwwlDatabase + buildBowwwlLookup_, kept in memory for this run. */
async function loadBowwwlLookup() {
  const rows = [];
  const seenUrls = new Set();
  let firstUrl = '';

  for (let page = 0; page <= 1; page += 1) {
    const sourceUrl = buildBowwwlDatabaseUrl_(page);
    const pageRows = parseBowwwlDatabaseHtml_(await fetchPage(sourceUrl, 'Bowwwl.com'));
    if (!pageRows.length) throw new Error('No Bowwwl database rows found at ' + sourceUrl);
    if (page === 0) firstUrl = pageRows[0].url;
    if (page > 0 && pageRows[0].url === firstUrl) break;
    for (const row of pageRows) {
      if (!row.url || seenUrls.has(row.url)) continue;
      seenUrls.add(row.url);
      rows.push(row);
    }
  }

  const lookup = {};
  for (const row of rows) {
    const key = bowwwlProductKey_(row.brand, row.ball);
    if (!key || lookup[key]) continue;
    lookup[key] = {
      coverstock: row.coverstock,
      finish: row.factoryFinish,
      core: row.core,
      rg: row.rg,
      differential: row.diff,
      mbDifferential: row.mbDiff,
      releaseDate: row.releaseDate,
    };
  }
  console.log(`Bowwwl database: ${rows.length} balls.`);
  return lookup;
}

// --- 2. bowling.com ---------------------------------------------------------

/** The body of continueBowlingBallScrape, minus the pause-and-resume. */
async function scrapeBowlingCom(store, bowwwlLookup) {
  const totals = { added: 0, updated: 0, priceIncreases: 0, skipped: 0, failedBrands: [] };
  const seenPageFirstIds = [];

  for (const [brandName, brandSlug] of BRANDS) {
    for (let page = 1; ; page += 1) {
      const sourceUrl = buildCatalogUrl_(brandSlug, page);
      let products;
      try {
        products = parseProductsFromHtml_(await fetchPage(sourceUrl, 'Bowling.com'), brandName, sourceUrl);
      } catch (error) {
        console.error(`${brandName}: ${error.message}`);
        products = [];
      }

      if (products.length === 0) {
        if (page === 1) totals.failedBrands.push(brandName);
        break;
      }

      // An out-of-range page redirects back to page one.
      const firstId = productId_(products[0]);
      if (seenPageFirstIds.includes(firstId)) break;
      seenPageFirstIds.push(firstId);

      const eligible = products.filter((product) => {
        if (excludedCondition_(product.name)) {
          totals.skipped += 1;
          return false;
        }
        return true;
      });

      const details = await fetchProductDetailsBatch(eligible);
      eligible.forEach((product, index) => {
        const detail = details[index] || emptyProductDetails_();
        product.coverstock = detail.coverstock || '';
        product.core = detail.core || '';
        product.finish = detail.finish || '';
        product.rg = detail.rg || '';
        product.differential = detail.differential || '';
        product.mbDifferential = '';
        product.laneCondition = detail.laneCondition || '';
        product.fragrance = detail.fragrance || '';
        product.ballPerformance = detail.ballPerformance || '';
        const bowwwlMatch = bowwwlLookup[bowwwlProductKey_(product.brand, product.name)];
        applyBowwwlFallbacks_(product, bowwwlMatch);
        product.releaseMonth = bowwwlMatch && !isBlank_(bowwwlMatch.releaseDate)
          ? normalizeReleaseMonth_(bowwwlMatch.releaseDate)
          : (detail.releaseDate ? normalizeReleaseMonth_(detail.releaseDate) : currentRunMonth());
        product.coverType = classifyCoverType_(product.coverstock) ||
          classifyCoverType_(bowwwlMatch && bowwwlMatch.coverstock);
        product.coverFinish = classifyCoverFinish_(product.coverstock) ||
          classifyCoverFinish_(bowwwlMatch && bowwwlMatch.coverstock);
        product.coreType = classifyCoreType_(product.core) ||
          classifyCoreType_(bowwwlMatch && bowwwlMatch.core) ||
          (!isBlank_(product.mbDifferential) ? 'Asymmetric' : '');
      });

      const result = upsertProductsIntoStore_(store, eligible);
      totals.added += result.added;
      totals.updated += result.updated;
      totals.priceIncreases += result.priceIncreases;
      console.log(`${brandName} page ${page}: ${products.length} listed, ${result.added} new, ${result.updated} updated.`);

      if (products.length < PAGE_SIZE) break;
      await sleep(350);
    }
  }

  if (totals.failedBrands.length >= BRANDS.length) {
    throw new Error('No products were readable for any brand. Bowling.com markup has likely changed.');
  }
  return totals;
}

// --- 3. Manufacturer current production -------------------------------------

/**
 * refreshCurrentProduction, minus the "Current Production" tab itself (the
 * website never read it). Returns the store rows with Discontinued updated.
 */
async function applyCurrentProduction(rows) {
  const officialProducts = [];
  const officialSeen = {};
  for (const [brand, parser, url] of CURRENT_PRODUCTION_SOURCES) {
    const parsed = parseCurrentProductionPage_(await fetchPage(url, brand), brand, parser, url);
    if (!parsed.length) {
      throw new Error(
        `No current-production products were found for ${brand} at ${url}. ` +
        'Statuses were not updated; the manufacturer markup may have changed.'
      );
    }
    for (const product of parsed) {
      const key = bowwwlProductKey_(product.brand, product.name);
      if (!key || officialSeen[key]) continue;
      officialSeen[key] = true;
      officialProducts.push(product);
    }
  }

  const values = [BOWLING_SCRAPER_HEADERS].concat(rows.map((row) => row.slice(0, BOWLING_SCRAPER_HEADERS.length)));
  const mainProducts = readOutputProducts_(valuesSheet(values));
  if (mainProducts.length !== rows.length) {
    throw new Error('Catalog rows and products fell out of step; statuses were not updated.');
  }
  const usedMain = {};
  officialProducts.forEach((official) => findOfficialProductMatch_(official, mainProducts, usedMain));
  applyProductionStatuses_(mainProducts, usedMain);

  const discontinued = mainProducts.filter((product) => product.discontinued === 'Yes').length;
  console.log(`Current production: ${officialProducts.length} official products; ${discontinued} catalog balls discontinued.`);
  return mainProducts.map(productToOutputRow_);
}

// --- Main -------------------------------------------------------------------

export async function main() {
  const existing = await selectAll('balls');
  console.log(`Supabase: ${existing.length} balls before this run.`);

  const bowwwlLookup = await loadBowwwlLookup();

  const store = loadProductStore_(valuesSheet([SHEET_HEADERS].concat(existing.map(dbRowToSheetRow))));
  const totals = await scrapeBowlingCom(store, bowwwlLookup);
  console.log(
    `Bowling.com: ${totals.added} added, ${totals.updated} updated, ${totals.priceIncreases} higher prices kept, ` +
    `${totals.skipped} condition listings skipped` +
    (totals.failedBrands.length ? `; nothing readable for ${totals.failedBrands.join(', ')}` : '') + '.'
  );

  // store.byId maps each product URL to its row. Rows that came from the old
  // sheet and have not been seen on bowling.com since keep no URL.
  const urls = [];
  for (const [id, index] of Object.entries(store.byId)) if (id) urls[index] = id;

  let rows = store.rows;
  let productionError = null;
  try {
    rows = await applyCurrentProduction(rows);
  } catch (error) {
    // Like the Apps Script, a broken manufacturer page leaves every
    // Discontinued value as it was rather than guessing. The scrape itself is
    // still saved, and the run is marked failed below so it gets noticed.
    productionError = error;
    console.error(error.message);
  }

  const dbRows = sheetRowsToDbRows(rows, urls, new Date().toISOString());
  console.log(`Saving ${dbRows.length} balls (${dbRows.filter((row) => row.is_recent_release).length} recent releases).`);

  // Never let a bad run empty the catalog the website shows.
  if (existing.length && dbRows.length < existing.length * 0.8) {
    throw new Error(`Refusing to save: ${dbRows.length} balls is far fewer than the ${existing.length} already stored.`);
  }

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN=1, nothing written. First row:', JSON.stringify(dbRows[0], null, 2));
  } else {
    await upsertRows('balls', dbRows, 'match_key');
    const keep = new Set(dbRows.map((row) => row.match_key));
    const stale = existing.filter((row) => !keep.has(row.match_key)).map((row) => row.id);
    if (stale.length) await deleteRows('balls', stale);
    console.log(`Saved. ${stale.length} merged duplicate row(s) removed.`);
  }

  if (productionError) throw productionError;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

