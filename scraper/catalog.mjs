// Converting between rows of the `balls` table and the sheet-shaped rows the
// rules in rules.mjs work on, and deciding which balls are recent releases.
// Shared by the daily scraper and the one-time sheet import.

import {
  BOWLING_SCRAPER_HEADERS,
  RECENT_RELEASES_LIMIT,
  bowwwlProductKey_,
  cleanText_,
  isBlank_,
  normalizeReleaseMonth_,
  numericPrice_,
  readRecentReleasesFromMainSheet_,
  releaseMonthSortKey_,
} from './rules.mjs';

// The sheet's 19 columns, plus the bowling.com product URL. The old sheet
// never stored the URL, so the scraper could only match rows by name; with it
// stored, migrateExistingOutputRow_ matches by URL first, as it was written to.
export const SHEET_HEADERS = BOWLING_SCRAPER_HEADERS.concat(['Product URL']);

const COLUMN = Object.fromEntries(BOWLING_SCRAPER_HEADERS.map((h, i) => [h, i]));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jul 2012" -> "2012-07-01". Anything without a month and year is null. */
export function releaseMonthToDate(value) {
  const key = releaseMonthSortKey_(value);
  if (!key) return null;
  const year = Math.floor(key / 12);
  const month = key % 12;
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** "2012-07-01" -> "Jul 2012", the form the rules compare and sort on. */
export function dateToReleaseMonth(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  return match ? `${MONTHS[Number(match[2]) - 1]} ${match[1]}` : '';
}

/**
 * Stands in for a Google Sheet. The rules only ever call getDataRange()
 * .getValues() and getLastRow() on the sheets they are handed.
 */
export function valuesSheet(values) {
  return {
    getDataRange: () => ({ getValues: () => values }),
    getLastRow: () => values.length,
  };
}

/** A `balls` row as the sheet row (plus Product URL) the rules expect. */
export function dbRowToSheetRow(row) {
  return [
    '',
    row.brand || '',
    row.name || '',
    dateToReleaseMonth(row.release_month),
    row.price == null ? '' : Number(row.price),
    row.image_url || '',
    row.rg || '',
    row.diff || '',
    row.int_diff || '',
    row.cover_type || '',
    row.core_type || '',
    row.cover_finish || '',
    row.ball_place || '',
    row.oil_condition || '',
    row.ball_finish || '',
    row.fragrance || '',
    row.coverstock || '',
    row.core || '',
    row.discontinued || 'Unknown',
    row.product_url || '',
  ];
}

function text(value) {
  if (isBlank_(value)) return null;
  const cleaned = cleanText_(String(value));
  return cleaned || null;
}

/**
 * Sheet rows (as left in the product store) -> `balls` rows ready to upsert.
 * `urls[i]` is the product URL for row i, when known.
 */
export function sheetRowsToDbRows(rows, urls, now) {
  const recentKeys = recentReleaseKeys(rows);
  const seen = new Set();
  const out = [];

  rows.forEach((row, index) => {
    const brand = text(row[COLUMN['Brand']]);
    const name = text(row[COLUMN['Ball Name']]);
    if (!brand || !name) return;

    const url = urls[index] || null;
    const matchKey = bowwwlProductKey_(brand, name) || (url ? 'url:' + url : '');
    if (!matchKey || seen.has(matchKey)) return;
    seen.add(matchKey);

    const price = numericPrice_(row[COLUMN['Price']]);
    const discontinued = text(row[COLUMN['Discontinued']]);

    out.push({
      match_key: matchKey,
      product_url: url,
      brand,
      name,
      release_month: releaseMonthToDate(row[COLUMN['Release Date']]),
      price: price === '' ? null : Math.round(price * 100) / 100,
      image_url: text(row[COLUMN['Image URL']]),
      rg: text(row[COLUMN['RG']]),
      diff: text(row[COLUMN['Diff']]),
      // The sheet showed this column with three decimals (0.020, not 0.02).
      int_diff: typeof row[COLUMN['Int Diff']] === 'number'
        ? row[COLUMN['Int Diff']].toFixed(3)
        : text(row[COLUMN['Int Diff']]),
      cover_type: text(row[COLUMN['Cover Type']]),
      core_type: text(row[COLUMN['Core Type']]),
      cover_finish: text(row[COLUMN['Cover Finish']]),
      ball_place: text(row[COLUMN['Ball Place']]),
      oil_condition: text(row[COLUMN['Oil Condition']]),
      ball_finish: text(row[COLUMN['Ball Finish']]),
      fragrance: text(row[COLUMN['Fragrance']]),
      coverstock: text(row[COLUMN['Coverstock Name']]),
      core: text(row[COLUMN['Core Name']]),
      discontinued: ['Yes', 'No'].includes(discontinued) ? discontinued : 'Unknown',
      is_recent_release: recentKeys.has(matchKey),
      updated_at: now,
    });
  });
  return out;
}

/**
 * The match keys of the newest reactive balls -- what refreshRecentReleases()
 * used to copy onto the "Recent Releases" tab, with the same sort and limit.
 */
export function recentReleaseKeys(rows) {
  const values = [BOWLING_SCRAPER_HEADERS].concat(rows.map((row) => row.slice(0, BOWLING_SCRAPER_HEADERS.length)));
  const releases = readRecentReleasesFromMainSheet_(valuesSheet(values))
    .sort((a, b) => {
      const dateDifference = releaseMonthSortKey_(b.releaseDate) - releaseMonthSortKey_(a.releaseDate);
      return dateDifference || a.name.localeCompare(b.name);
    })
    .slice(0, RECENT_RELEASES_LIMIT);
  return new Set(releases.map((product) => bowwwlProductKey_(product.brand, product.name)).filter(Boolean));
}

export { normalizeReleaseMonth_ };
