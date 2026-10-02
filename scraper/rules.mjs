/**
 * Parsing and matching rules for the ball scraper.
 *
 * Everything below is copied unchanged from the Apps Script scraper that used
 * to fill the "Proshop Ball Sheet" Google Sheet, so the catalog comes out the
 * same as it did there. Only the parts that talked to Google (UrlFetchApp,
 * SpreadsheetApp, triggers, script properties) were left out; ball-scraper.mjs
 * replaces them with plain fetch() and Supabase.
 *
 * Functions that took a Sheet still do: ball-scraper.mjs hands them a small
 * stand-in object (see valuesSheet) whose getDataRange().getValues() returns
 * rows built from the balls table, so the matching rules did not have to be
 * rewritten to be moved.
 */

const BOWLING_SCRAPER_HEADERS = [
  'Image',
  'Brand',
  'Ball Name',
  'Release Date',
  'Price',
  'Image URL',
  'RG',
  'Diff',
  'Int Diff',
  'Cover Type',
  'Core Type',
  'Cover Finish',
  'Ball Place',
  'Oil Condition',
  'Ball Finish',
  'Fragrance',
  'Coverstock Name',
  'Core Name',
  'Discontinued'
];


const RECENT_RELEASES_LIMIT = 20;


const CURRENT_PRODUCTION_SOURCES = [
  ['Brunswick', 'brunswick', 'https://brunswickbowling.com/products/balls/current/p1?sort=newest'],
  ['Brunswick', 'brunswick', 'https://brunswickbowling.com/products/balls/current/p2?sort=newest'],
  ['DV8', 'brunswick', 'https://dv8bowling.com/products/balls/current'],
  ['Ebonite', 'shopify', 'https://ebonite.com/collections/balls'],
  ['Hammer', 'shopify', 'https://hammerbowling.com/collections/balls'],
  ['Radical', 'brunswick', 'https://radicalbowling.com/products/balls/current'],
  ['Track', 'shopify', 'https://trackbowling.com/collections/balls'],
  ['Motiv', 'motiv', 'https://www.motivbowling.com/products/balls/'],
  ['Storm', 'storm', 'https://www.stormbowling.com/products/equipment/bowling-balls/24/1/1/'],
  ['Storm', 'storm', 'https://www.stormbowling.com/products/equipment/bowling-balls/24/1/2/'],
  ['Storm', 'storm', 'https://www.stormbowling.com/products/equipment/bowling-balls/24/1/3/']
];


// Only brands reachable from an official source above may be marked
// discontinued. 900 Global and Roto Grip arrive via the Storm pages, which
// report each card's real brand. Columbia 300 is deliberately absent: its own
// store lists no balls, so every Columbia 300 ball would fail to match and be
// falsely tagged discontinued. Those rows report "Unknown" instead.
const CURRENT_PRODUCTION_SUPPORTED_BRANDS = [
  '900 Global', 'Brunswick', 'DV8', 'Ebonite', 'Hammer',
  'Motiv', 'Radical', 'Roto Grip', 'Storm', 'Track'
];


const BOWWWL_DATABASE_HEADERS = [
  'Ball',
  'Brand',
  'Release Date',
  'Coverstock',
  'Factory Finish',
  'Core',
  'RG',
  'Diff',
  'MB Diff'
];


function releaseMonthSortKey_(value) {
  const normalized = normalizeReleaseMonth_(value);
  const match = normalized.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i);
  if (!match) return 0;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  return Number(match[2]) * 12 + months[match[1].toLowerCase()];
}


function readRecentReleasesFromMainSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function(header) { return cleanText_(header).toLowerCase(); });
  const column = function(name) { return headers.indexOf(name.toLowerCase()); };
  const columns = {
    brand: column('Brand'),
    name: column('Ball Name'),
    releaseMonth: column('Release Date'),
    price: column('Price'),
    image: column('Image URL'),
    coverstock: column('Coverstock Name'),
    coverType: column('Cover Type'),
    coverFinish: column('Cover Finish'),
    core: column('Core Name'),
    coreType: column('Core Type'),
    finish: column('Ball Finish'),
    rg: column('RG'),
    differential: column('Diff'),
    mbDifferential: column('Int Diff'),
    laneCondition: column('Oil Condition'),
    fragrance: column('Fragrance'),
    ballPerformance: column('Ball Place'),
    discontinued: column('Discontinued')
  };
  if (columns.name === -1 || columns.releaseMonth === -1) return [];


  const releases = [];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex];
    const product = {
      brand: valueAtColumn_(row, columns.brand),
      name: valueAtColumn_(row, columns.name),
      releaseDate: valueAtColumn_(row, columns.releaseMonth),
      releaseMonth: valueAtColumn_(row, columns.releaseMonth),
      price: valueAtColumn_(row, columns.price),
      image: valueAtColumn_(row, columns.image),
      coverstock: valueAtColumn_(row, columns.coverstock),
      coverType: valueAtColumn_(row, columns.coverType),
      coverFinish: valueAtColumn_(row, columns.coverFinish),
      core: valueAtColumn_(row, columns.core),
      coreType: valueAtColumn_(row, columns.coreType),
      finish: valueAtColumn_(row, columns.finish),
      rg: valueAtColumn_(row, columns.rg),
      differential: valueAtColumn_(row, columns.differential),
      mbDifferential: valueAtColumn_(row, columns.mbDifferential),
      laneCondition: valueAtColumn_(row, columns.laneCondition),
      fragrance: valueAtColumn_(row, columns.fragrance),
      ballPerformance: valueAtColumn_(row, columns.ballPerformance),
      discontinued: valueAtColumn_(row, columns.discontinued) || 'Unknown'
    };
    if (!product.name || recentCatalogExclusion_(product)) continue;
    const type = cleanText_(product.coverType).toLowerCase();
    const reactiveType = type === 'reactive' || isReactiveCoverstock_(product.coverstock);
    if (reactiveType) releases.push(product);
  }
  return releases;
}


function parseCurrentProductionPage_(html, brand, parser, sourceUrl) {
  if (parser === 'brunswick') return parseBrunswickFamilyCurrent_(html, brand, sourceUrl);
  if (parser === 'shopify') return parseShopifyCurrent_(html, brand, sourceUrl);
  if (parser === 'motiv') return parseMotivCurrent_(html, brand, sourceUrl);
  if (parser === 'storm') return parseStormCurrent_(html, brand, sourceUrl);
  return [];
}


function parseBrunswickFamilyCurrent_(html, brand, sourceUrl) {
  const products = [];
  const seen = {};
  const pattern = /<a\b([^>]*href=["']([^"']*\/products\/balls\/current\/([^"'/?#]+))[^>]*>)/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (/^p\d+$/i.test(match[3])) continue;
    const title = match[1].match(/\b(?:aria-label|title)=["']([^"']+)["']/i);
    const name = cleanText_(title ? title[1] : '');
    const url = absoluteManufacturerUrl_(match[2], sourceUrl);
    if (!name || seen[url]) continue;
    seen[url] = true;
    products.push({ brand: brand, name: name, url: url, image: '' });
  }
  return products;
}


function parseShopifyCurrent_(html, brand, sourceUrl) {
  const byUrl = {};
  const pattern = /<a\b[^>]*href=["']([^"']*\/collections\/balls\/products\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const url = absoluteManufacturerUrl_(match[1], sourceUrl);
    let name = cleanText_(stripTags_(match[2])).replace(/\s*\$[\d,.]+\s*$/, '');
    if (!byUrl[url]) byUrl[url] = { brand: brand, name: '', url: url, image: '' };
    if (name) byUrl[url].name = name;
  }
  return Object.keys(byUrl).map(function(url) { return byUrl[url]; })
    .filter(function(product) { return product.name; });
}


function parseMotivCurrent_(html, brand, sourceUrl) {
  const section = html.match(/<section\b[^>]*class=["'][^"']*\bproduct-index\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i);
  if (!section) return [];
  const products = [];
  const pattern = /<li\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<span\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = pattern.exec(section[1])) !== null) {
    products.push({
      brand: brand,
      name: cleanText_(stripTags_(match[2])),
      url: absoluteManufacturerUrl_(match[1], sourceUrl),
      image: ''
    });
  }
  return products;
}


function parseStormCurrent_(html, brand, sourceUrl) {
  const products = [];
  const seen = {};
  const pattern = /<a\b([^>]*class=["'][^"']*\bproduct-name-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>[\s\S]*?<strong>\s*Brand:\s*<\/strong>\s*([^<]+)<\/p>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1].match(/\bhref=["']([^"']+)["']/i);
    const title = match[1].match(/\btitle=["']([^"']+)["']/i);
    const name = cleanText_(title ? title[1] : stripTags_(match[2]));
    const actualBrand = cleanText_(match[3]) || brand;
    const url = href ? absoluteManufacturerUrl_(href[1], sourceUrl) : '';
    if (!name || !url || seen[url]) continue;
    seen[url] = true;
    products.push({ brand: actualBrand, name: name, url: url, image: '' });
  }
  return products;
}


function absoluteManufacturerUrl_(url, sourceUrl) {
  const value = decodeHtmlEntities_(String(url || '')).trim();
  if (/^https?:\/\//i.test(value)) return normalizeUrl_(value);
  const origin = String(sourceUrl).match(/^(https?:\/\/[^/]+)/i);
  let path = value;
  if (/^\.\//.test(path)) {
    const basePath = String(sourceUrl).replace(/[?#].*/, '');
    return normalizeUrl_(basePath + path.substring(2));
  }
  return normalizeUrl_((origin ? origin[1] : '') + '/' + path.replace(/^\/+/, ''));
}


/** Reads the common 18-column output schema back into product objects. */
function readOutputProducts_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0].map(function(header) { return cleanText_(header).toLowerCase(); });
  const column = function(name) { return headers.indexOf(name.toLowerCase()); };
  const columns = {
    brand: column('Brand'), name: column('Ball Name'), releaseMonth: column('Release Date'),
    price: column('Price'), image: column('Image URL'), rg: column('RG'),
    differential: column('Diff'), mbDifferential: column('Int Diff'),
    coverType: column('Cover Type'), coreType: column('Core Type'),
    coverFinish: column('Cover Finish'), ballPerformance: column('Ball Place'),
    laneCondition: column('Oil Condition'), finish: column('Ball Finish'),
    fragrance: column('Fragrance'), coverstock: column('Coverstock Name'), core: column('Core Name'),
    discontinued: column('Discontinued')
  };
  if (columns.brand === -1 || columns.name === -1) return [];


  return values.slice(1).map(function(row) {
    const product = {};
    Object.keys(columns).forEach(function(field) {
      product[field] = valueAtColumn_(row, columns[field]);
    });
    return product;
  }).filter(function(product) { return cleanText_(product.name); });
}


/** Applies status only where an official manufacturer source is configured. */
function applyProductionStatuses_(mainProducts, currentMatches) {
  const supportedBrands = {};
  CURRENT_PRODUCTION_SUPPORTED_BRANDS.forEach(function(brand) {
    supportedBrands[compactMatchText_(brand)] = true;
  });
  mainProducts.forEach(function(product, index) {
    const supported = supportedBrands[compactMatchText_(product.brand)];
    product.discontinued = supported ? (currentMatches[index] ? 'No' : 'Yes') : 'Unknown';
  });
  return mainProducts;
}


/** Matches an official listing to the existing Bowling Balls data. */
function findOfficialProductMatch_(official, mainProducts, usedMain) {
  const officialName = productNameKey_(official.brand, official.name);
  for (let index = 0; index < mainProducts.length; index += 1) {
    if (usedMain[index]) continue;
    const candidate = mainProducts[index];
    if (compactMatchText_(candidate.brand) !== compactMatchText_(official.brand)) continue;
    const candidateName = productNameKey_(candidate.brand, candidate.name);
    if (!officialName || candidateName !== officialName) continue;
    usedMain[index] = true;
    return Object.assign({}, candidate);
  }
  return null;
}


function productNameKey_(brand, name) {
  const key = bowwwlProductKey_(brand, name);
  const separator = key.indexOf('|');
  if (separator === -1) return '';
  let nameKey = key.substring(separator + 1).replace(/bowlingball$/, '');
  const brandKey = compactMatchText_(brand);
  // Brunswick's official Fury cards omit the cover-finish suffix that
  // Bowling.com appends to the same color-specific product names.
  if (brandKey === 'brunswick') {
    if (/^(?:fury|rhino)/.test(nameKey)) nameKey = nameKey.replace(/(?:pearl|hybrid|solid)$/, '');
    nameKey = nameKey.replace(/vizaball$/, '');
  }
  // Storm's retailer names insert the cover type after "Tropical Surge";
  // the official SPI cards identify the same products by color only.
  if (brandKey === 'storm' && nameKey.indexOf('tropicalsurge') === 0) {
    nameKey = nameKey.replace(/^tropicalsurge(?:pearl|hybrid|solid)/, 'tropicalsurge');
  }
  if (brandKey === 'storm') {
    nameKey = nameKey
      .replace(/^pitchblacksolidurethane$/, 'pitchblack')
      .replace(/^normdukeclearballlimitededition$/, 'normdukeclear')
      .replace(/^clearlightningstorm$/, 'lightningstormclear')
      .replace(/^icestormoceanbluewhite$/, 'icestormoceanblue')
      .replace(/^mixlimeroyalcustard$/, 'mixcustardlimeroyal')
      .replace(/^mixlimecustardroyal$/, 'mixcustardlimeroyal')
      .replace(/^mixpurplebluewhite$/, 'mixbluepurplewhite')
      .replace(/^mixpurplewhiteblue$/, 'mixbluepurplewhite');
  }
  if (brandKey === 'hammer') {
    nameKey = nameKey
      .replace(/^rawhammer/, 'raw')
      .replace(/^raw(?:pearl|hybrid|solid)/, 'raw')
      .replace(/^blackwidow30solid$/, 'blackwidow30');
  }
  if (brandKey === 'ebonite') {
    nameKey = nameKey.replace(/^gamebreaker5solid$/, 'gamebreaker5');
  }
  if (brandKey === 'motiv') {
    if (nameKey.indexOf('ascend') === 0) nameKey = nameKey.replace(/pearl$/, '');
    if (nameKey.indexOf('aspiresky') === 0) nameKey = nameKey.replace(/^aspireskyblue/, 'aspiresky');
  }
  if (brandKey === 'rotogrip') {
    if (nameKey.indexOf('hustle') === 0) nameKey = nameKey.replace(/(?:pearl|hybrid|solid)$/, '');
    nameKey = nameKey.replace(/^rgjester/, 'jester');
  }
  if (brandKey === 'radical' && nameKey.indexOf('torpedodirecthit') === 0) {
    nameKey = nameKey.replace(/pearl$/, '');
  }
  if (brandKey === 'dv8' && nameKey.indexOf('doubletrouble') === 0) {
    nameKey = nameKey.replace(/pearl$/, '');
  }
  if (brandKey === '900global' && /^(?:onyxpolyester|onyxclear)$/.test(nameKey)) {
    nameKey = 'onyx';
  }
  return nameKey;
}


function buildCatalogUrl_(brandSlug, page) {
  return 'https://www.bowling.com/shopping/' + encodeURIComponent(brandSlug) +
    '/bowling-balls/all?page=' + page;
}


function buildBowwwlDatabaseUrl_(page) {
  const base = 'https://www.bowwwl.com/bowling-ball-database' +
    '?weight=15&overseas=0&discontinued=All';
  return page > 0 ? base + '&page=' + page : base;
}


function parseBowwwlDatabaseHtml_(html) {
  const tableMatch = html.match(
    /<table\b[^>]*class=["'][^"']*\bviews-view-table\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i
  );
  if (!tableMatch) return [];


  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(tableMatch[1])) !== null) {
    const cells = parseBowwwlCells_(rowMatch[1]);
    const ballCell = bowwwlCell_(cells, 'view-nothing-2-table-column');
    if (!ballCell) continue;


    const ballLink = bowwwlBallLink_(ballCell.html);
    if (!ballLink.name || !ballLink.url) continue;


    const brandCell = bowwwlCell_(cells, 'view-field-brand-logo-table-column');
    const brandAlt = brandCell && brandCell.html.match(/\balt=["']([^"']+)["']/i);
    const brand = cleanText_(brandAlt ? brandAlt[1] : stripTags_(brandCell ? brandCell.html : ''))
      .replace(/\s+Bowling$/i, '');
    const releaseCell = bowwwlCell_(cells, 'view-field-release-date-table-column');
    const coverstockCell = bowwwlCell_(cells, 'view-nothing-1-table-column');
    const finishCell = bowwwlCell_(cells, 'view-field-factory-finish-table-column');
    const coreCell = bowwwlCell_(cells, 'view-nothing-table-column');


    rows.push({
      ball: ballLink.name,
      brand: brand,
      releaseDate: cleanText_(stripTags_(releaseCell ? releaseCell.html : '')),
      coverstock: bowwwlNamedType_(coverstockCell ? coverstockCell.html : '', 'coverstock'),
      factoryFinish: cleanText_(stripTags_(finishCell ? finishCell.html : '')),
      core: bowwwlNamedType_(coreCell ? coreCell.html : '', 'core'),
      rg: numericPrice_(bowwwlCellText_(cells, 'view-field-rg-table-column')),
      diff: numericPrice_(bowwwlCellText_(cells, 'view-field-differential-table-column')),
      mbDiff: numericPrice_(bowwwlCellText_(cells, 'view-field-mass-bias-differential-table-column')),
      url: ballLink.url
    });
  }
  return rows;
}


function parseBowwwlCells_(rowHtml) {
  const cells = [];
  const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = cellPattern.exec(rowHtml)) !== null) {
    const headerMatch = match[1].match(/\bheaders=["']([^"']+)["']/i);
    cells.push({ header: headerMatch ? headerMatch[1] : '', html: match[2] });
  }
  return cells;
}


function bowwwlCell_(cells, header) {
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i].header === header) return cells[i];
  }
  return null;
}


function bowwwlCellText_(cells, header) {
  const cell = bowwwlCell_(cells, header);
  return cleanText_(stripTags_(cell ? cell.html : ''));
}


function bowwwlBallLink_(html) {
  const links = [];
  const linkPattern = /<a\b[^>]*href=["']([^"']*\/bowling-ball-database\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const name = cleanText_(stripTags_(match[2]));
    if (name) links.push({ name: name, url: absoluteBowwwlUrl_(match[1]) });
  }
  return links.length ? links[links.length - 1] : { name: '', url: '' };
}


function absoluteBowwwlUrl_(url) {
  const value = decodeHtmlEntities_(String(url || '')).trim();
  if (/^https?:\/\//i.test(value)) return normalizeUrl_(value);
  return normalizeUrl_('https://www.bowwwl.com/' + value.replace(/^\/+/, ''));
}


function bowwwlNamedType_(html, prefix) {
  const nameMatch = html.match(
    new RegExp('<span\\b[^>]*class=["\'][^"\']*\\b' + prefix + '-name\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/span>', 'i')
  );
  const typeMatch = html.match(
    new RegExp('<span\\b[^>]*class=["\'][^"\']*\\b' + prefix + '-type\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/span>', 'i')
  );
  const name = cleanText_(stripTags_(nameMatch ? nameMatch[1] : ''));
  const type = cleanText_(stripTags_(typeMatch ? typeMatch[1] : ''));
  if (name && type) return name + ' — ' + type;
  return name || type || cleanText_(stripTags_(html));
}


function parseProductDetails_(html) {
  let releaseDate = '';
  const releaseTitle = html.match(
    /title=["']The original release date of [^"']*? was ([^"']+?\.)["']/i
  );
  if (releaseTitle) {
    releaseDate = cleanText_(releaseTitle[1]).replace(/\.$/, '');
  } else {
    const releaseBlock = html.match(
      /<strong>\s*Release Date\s*<\/strong>[\s\S]{0,800}?<div\b[^>]*>([\s\S]*?)<\/div>/i
    );
    releaseDate = releaseBlock ? cleanText_(stripTags_(releaseBlock[1])) : '';
  }
  return {
    coverstock: extractProductSpec_(html, 'Coverstock'),
    core: extractProductSpec_(html, 'Core'),
    finish: extractProductSpec_(html, 'Finish'),
    rg: extractProductSpec_(html, 'RG'),
    differential: extractProductSpec_(html, 'Differential'),
    laneCondition: extractProductSpec_(html, 'Recommended Lane Condition'),
    fragrance: extractProductSpec_(html, 'Fragrance'),
    ballPerformance: extractProductSpec_(html, 'Ball Performance'),
    releaseDate: releaseDate
  };
}


function emptyProductDetails_() {
  return {
    coverstock: '',
    core: '',
    finish: '',
    rg: '',
    differential: '',
    laneCondition: '',
    fragrance: '',
    ballPerformance: '',
    releaseDate: ''
  };
}


function extractProductSpec_(html, label) {
  const escapedLabel = escapeRegExp_(label);
  const rowPattern = new RegExp(
    '<strong>\\s*' + escapedLabel + '\\s*<\\/strong>' +
    '[\\s\\S]{0,900}?<\\/div>\\s*<div\\b([^>]*)>([\\s\\S]*?)<\\/div>',
    'i'
  );
  const match = String(html || '').match(rowPattern);
  if (!match) return '';


  const titleMatch = match[1].match(/\btitle=["']([^"']+)["']/i);
  if (titleMatch) {
    const title = cleanText_(titleMatch[1]);
    const marker = (label + ':').toLowerCase();
    const markerIndex = title.toLowerCase().lastIndexOf(marker);
    if (markerIndex !== -1) {
      return title.substring(markerIndex + marker.length).trim();
    }
  }
  return cleanText_(stripTags_(match[2]));
}


function escapeRegExp_(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function stripTags_(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}


function isReactiveCoverstock_(coverstock) {
  return /\breactive\b/i.test(String(coverstock || ''));
}


function recentCatalogExclusion_(product) {
  const name = cleanText_(product && product.name).toUpperCase();
  const brand = cleanText_(product && product.brand).toUpperCase();
  if (excludedCondition_(name)) return true;
  if (brand === 'KR STRIKEFORCE' || /\bKR\s+STRIKEFORCE\b/.test(name)) return true;
  return /\bVIZ[\s-]*A[\s-]*BALL\b/.test(name);
}


/**
 * Returns catalog products for one listing page.
 *
 * Bowling.com normally embeds a Schema.org ItemList. Some brand pages ship
 * without it (DV8 as of Sep 2026), so the product-card markup is parsed as a
 * fallback rather than failing the whole run.
 */
function parseProductsFromHtml_(html, fallbackBrand, sourceUrl) {
  const structured = parseProductsFromJsonLd_(html, fallbackBrand, sourceUrl);
  if (structured.length) return structured;


  const cards = parseProductCardsFromHtml_(html, fallbackBrand, sourceUrl);
  if (cards.length) {
    console.warn(
      'No JSON-LD ItemList at %s; used the product-card fallback (%s products).',
      sourceUrl, cards.length
    );
  }
  return cards;
}


/**
 * Fallback reader for listing pages without JSON-LD. Each product tile is an
 * <a class="prlnk"> wrapping a card that carries data-brand/data-name/data-link
 * attributes plus a .yourprice span.
 */
function parseProductCardsFromHtml_(html, fallbackBrand, sourceUrl) {
  const products = [];
  const seen = {};
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const attributes = match[1];
    if (!/\bclass=["'][^"']*\bprlnk\b/i.test(attributes)) continue;


    const card = match[2];
    // Cross-sell tiles from other departments are excluded by category.
    const category = card.match(/\bdata-category=["']([^"']*)["']/i);
    if (category && !/^balls$/i.test(cleanText_(category[1]))) continue;


    // "Recently viewed" and top-nav carousels reuse the same card markup. Only
    // the catalog grid itself is tagged as a drill-down list.
    const listName = card.match(/\bdata-list=["']([^"']*)["']/i);
    if (listName && !/drill\s*down\s*pg/i.test(listName[1])) continue;


    // Those carousels also carry other manufacturers, so a card whose brand
    // does not match the page's brand is not part of this catalog.
    const cardBrand = card.match(/\bdata-brand=["']([^"']*)["']/i);
    if (
      cardBrand && fallbackBrand &&
      compactMatchText_(cardBrand[1]) !== compactMatchText_(fallbackBrand)
    ) continue;


    const hrefMatch = attributes.match(/\bhref=["']([^"']+)["']/i) ||
      card.match(/\bdata-link=["']([^"']+)["']/i);
    const url = absoluteUrl_(hrefMatch ? decodeHtmlEntities_(hrefMatch[1]) : '');
    if (!url || seen[normalizeUrl_(url)]) continue;


    const nameMatch = card.match(/\bdata-name=["']([^"']+)["']/i);
    const altMatch = card.match(/<img\b[^>]*\balt=["']([^"']+)["']/i);
    let name = cleanText_(nameMatch ? nameMatch[1] : '')
      .replace(/^Product\s+Page\s*:\s*/i, '');
    if (!name && altMatch) {
      name = cleanText_(altMatch[1]).replace(/\s+Bowling\s+Balls?$/i, '');
    }
    if (!name) continue;


    const imageMatch = card.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);


    seen[normalizeUrl_(url)] = true;
    products.push({
      brand: cleanText_(cardBrand ? cardBrand[1] : fallbackBrand),
      name: name,
      price: parseCardPrice_(card),
      currency: 'USD',
      url: url,
      image: absoluteUrl_(imageMatch ? decodeHtmlEntities_(imageMatch[1]) : ''),
      sourcePage: sourceUrl,
      scrapedAt: new Date()
    });
  }
  return products;
}


/**
 * Reads the selling price off a product card. Cards show either a plain
 * ".yourprice" span, a highlighted "SALE: $x" badge alongside the ".everyday"
 * price, or the everyday price alone. Tag attributes are stripped first, so
 * amounts quoted inside tooltip titles cannot be picked up by mistake.
 */
function parseCardPrice_(card) {
  const text = cleanText_(stripTags_(card));
  const sale = text.match(/SALE:\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
  if (sale) return numericPrice_(sale[1]);
  const first = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  return first ? numericPrice_(first[1]) : '';
}


/** Extracts Product entries from the page's Schema.org JSON-LD ItemList. */
function parseProductsFromJsonLd_(html, fallbackBrand, sourceUrl) {
  const scripts = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    const attributes = decodeHtmlEntities_(match[1]).toLowerCase();
    if (/type\s*=\s*["']application\/ld\+json["']/.test(attributes)) {
      scripts.push(match[2].trim());
    }
  }


  for (let i = 0; i < scripts.length; i += 1) {
    try {
      const data = JSON.parse(scripts[i]);
      const itemList = findProductItemList_(data);
      if (!itemList) continue;


      return itemList.map(function(entry) {
        const item = entry && entry.item ? entry.item : entry;
        const offers = Array.isArray(item.offers) ? item.offers[0] : (item.offers || {});
        const brand = typeof item.brand === 'string' ? item.brand : (item.brand && item.brand.name);
        return {
          brand: cleanText_(brand || fallbackBrand),
          name: cleanText_(item.name || ''),
          price: numericPrice_(offers.price != null ? offers.price : offers.lowPrice),
          currency: cleanText_(offers.priceCurrency || 'USD'),
          url: absoluteUrl_(item.url || ''),
          image: absoluteUrl_(imageUrl_(item.image)),
          sourcePage: sourceUrl,
          scrapedAt: new Date()
        };
      }).filter(function(product) {
        return product.name && product.url;
      });
    } catch (error) {
      console.warn('Ignored invalid JSON-LD block: %s', error.message);
    }
  }
  return [];
}


function findProductItemList_(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findProductItemList_(node[i]);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;


  if (Array.isArray(node.itemListElement)) {
    const products = node.itemListElement.filter(function(entry) {
      const item = entry && entry.item ? entry.item : entry;
      const type = item && item['@type'];
      return type === 'Product' || (Array.isArray(type) && type.indexOf('Product') !== -1);
    });
    if (products.length) return products;
  }


  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i += 1) {
    const found = findProductItemList_(node[keys[i]]);
    if (found) return found;
  }
  return null;
}


function productToOutputRow_(product) {
  return [
    imageFormula_(product.image),
    product.brand,
    product.name,
    product.releaseMonth || '',
    product.price,
    product.image,
    product.rg || '',
    product.differential || '',
    product.mbDifferential || '',
    product.coverType || '',
    product.coreType || '',
    product.coverFinish || '',
    product.ballPerformance || '',
    product.laneCondition || '',
    product.finish || '',
    product.fragrance || '',
    product.coverstock || '',
    product.core || '',
    product.discontinued || 'Unknown'
  ];
}


function imageFormula_(imageUrl) {
  const url = String(imageUrl || '').trim();
  return url ? '=IMAGE("' + url.replace(/"/g, '""') + '")' : '';
}


/** Loads, schema-migrates, filters, and deduplicates existing scraper rows. */
function loadProductStore_(sheet) {
  const store = { rows: [], byId: {}, byName: {}, originalRowCount: Math.max(0, sheet.getLastRow() - 1) };
  if (sheet.getLastRow() < 2) return store;


  const values = sheet.getDataRange().getValues();
  const oldHeaders = values[0].map(function(header) { return cleanText_(header); });
  const oldColumn = {};
  oldHeaders.forEach(function(header, index) { oldColumn[header] = index; });


  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    const source = values[rowIndex];
    const migrated = migrateExistingOutputRow_(source, oldColumn);
    const row = migrated.row;
    const name = row[BOWLING_SCRAPER_HEADERS.indexOf('Ball Name')];
    if (!name || excludedCondition_(name)) continue;
    const id = migrated.productId;
    const brand = row[BOWLING_SCRAPER_HEADERS.indexOf('Brand')];
    const nameKey = bowwwlProductKey_(brand, name);
    if (!id && !nameKey) continue;


    const existingIndex = id && Object.prototype.hasOwnProperty.call(store.byId, id) ?
      store.byId[id] :
      (nameKey && Object.prototype.hasOwnProperty.call(store.byName, nameKey) ? store.byName[nameKey] : -1);
    if (existingIndex !== -1) {
      mergeStoredRows_(store.rows[existingIndex], row);
      if (id) store.byId[id] = existingIndex;
      if (nameKey) store.byName[nameKey] = existingIndex;
    } else {
      if (id) store.byId[id] = store.rows.length;
      if (nameKey) store.byName[nameKey] = store.rows.length;
      store.rows.push(row);
    }
  }
  return store;
}


function migrateExistingOutputRow_(source, oldColumn) {
  const oldValue = function() {
    for (let i = 0; i < arguments.length; i += 1) {
      const header = arguments[i];
      if (Object.prototype.hasOwnProperty.call(oldColumn, header)) return source[oldColumn[header]];
    }
    return '';
  };
  const coverstock = oldValue('Coverstock Name', 'Coverstock');
  const oldCoverType = oldValue('Cover Type', 'Coverstock Type');
  const imageUrl = oldValue('Image URL');
  const product = {
    brand: oldValue('Brand'),
    name: oldValue('Ball Name', 'Product Name'),
    releaseMonth: oldValue('Release Date', 'Release Month'),
    price: oldValue('Price'),
    image: imageUrl,
    rg: oldValue('RG'),
    differential: oldValue('Diff', 'Differential'),
    mbDifferential: oldValue('Int Diff', 'MB Diff'),
    coverType: oldValue('Cover Type') || classifyCoverType_(coverstock) || classifyCoverType_(oldCoverType),
    coreType: oldValue('Core Type'),
    coverFinish: oldValue('Cover Finish') || classifyCoverFinish_(coverstock) || classifyCoverFinish_(oldCoverType),
    ballPerformance: oldValue('Ball Place', 'Ball Performance'),
    laneCondition: oldValue('Oil Condition', 'Recommended Lane Condition'),
    finish: oldValue('Ball Finish', 'Finish'),
    fragrance: oldValue('Fragrance'),
    coverstock: coverstock,
    core: oldValue('Core Name', 'Core'),
    discontinued: oldValue('Discontinued') || 'Unknown'
  };
  return {
    row: productToOutputRow_(product),
    productId: normalizeUrl_(oldValue('Product URL'))
  };
}


function upsertProductsIntoStore_(store, products) {
  const result = { added: 0, updated: 0, priceIncreases: 0 };
  store.byName = store.byName || {};
  products.forEach(function(product) {
    const id = productId_(product);
    if (!id) return;
    const nameKey = bowwwlProductKey_(product.brand, product.name);
    const incoming = productToOutputRow_(product);
    const existingIndex = Object.prototype.hasOwnProperty.call(store.byId, id) ?
      store.byId[id] :
      (nameKey && Object.prototype.hasOwnProperty.call(store.byName, nameKey) ? store.byName[nameKey] : -1);
    if (existingIndex === -1) {
      store.byId[id] = store.rows.length;
      if (nameKey) store.byName[nameKey] = store.rows.length;
      store.rows.push(incoming);
      result.added += 1;
      return;
    }


    store.byId[id] = existingIndex;
    if (nameKey) store.byName[nameKey] = existingIndex;
    const existing = store.rows[existingIndex];
    if (mergeScrapedRow_(existing, incoming)) result.priceIncreases += 1;
    result.updated += 1;
  });
  return result;
}


/** Merges duplicate historical rows, retaining the maximum recorded price. */
function mergeStoredRows_(target, source) {
  const priceIndex = BOWLING_SCRAPER_HEADERS.indexOf('Price');
  target[priceIndex] = higherPrice_(target[priceIndex], source[priceIndex]);
  for (let index = 0; index < target.length; index += 1) {
    if (index !== priceIndex && isBlank_(target[index]) && !isBlank_(source[index])) {
      target[index] = source[index];
    }
  }
}


/** Returns true only when the stored maximum price increased. */
function mergeScrapedRow_(target, incoming) {
  const priceIndex = BOWLING_SCRAPER_HEADERS.indexOf('Price');
  const releaseIndex = BOWLING_SCRAPER_HEADERS.indexOf('Release Date');
  const discontinuedIndex = BOWLING_SCRAPER_HEADERS.indexOf('Discontinued');
  const oldPrice = numericPrice_(target[priceIndex]);
  const mergedPrice = higherPrice_(target[priceIndex], incoming[priceIndex]);
  const priceIncreased = !isBlank_(mergedPrice) && (isBlank_(oldPrice) || Number(mergedPrice) > Number(oldPrice));
  target[priceIndex] = mergedPrice;


  for (let index = 0; index < target.length; index += 1) {
    if (index === priceIndex || index === releaseIndex) continue;
    if (
      index === discontinuedIndex && incoming[index] === 'Unknown' &&
      !isBlank_(target[index])
    ) continue;
    if (!isBlank_(incoming[index])) target[index] = incoming[index];
  }
  if (isBlank_(target[releaseIndex]) && !isBlank_(incoming[releaseIndex])) {
    target[releaseIndex] = incoming[releaseIndex];
  }
  return priceIncreased;
}


function higherPrice_(first, second) {
  const firstNumber = numericPrice_(first);
  const secondNumber = numericPrice_(second);
  if (isBlank_(firstNumber)) return secondNumber;
  if (isBlank_(secondNumber)) return firstNumber;
  return Math.max(Number(firstNumber), Number(secondNumber));
}


function valueAtColumn_(row, column) {
  return column >= 0 && column < row.length ? row[column] : '';
}


function bowwwlProductKey_(brand, ballName) {
  const brandText = cleanText_(String(brand || '').replace(/\s+Bowling$/i, ''));
  const brandKey = compactMatchText_(brandText);
  let ballText = cleanText_(ballName);
  if (!brandKey || !ballText) return '';
  const brandTokens = brandText.split(/\s+/).filter(Boolean).map(escapeRegExp_);
  if (brandTokens.length) {
    const brandPrefix = new RegExp('^' + brandTokens.join('\\s*') + '(?=\\s|[-–—:/])\\s*', 'i');
    ballText = ballText.replace(brandPrefix, '');
  }
  const ballKey = compactMatchText_(ballText);
  if (!ballKey) return '';
  return brandKey + '|' + ballKey;
}


function compactMatchText_(value) {
  return cleanText_(value)
    .toLowerCase()
    // Storm styles the IQ family as "!Q" on its own website.
    .replace(/!q\b/g, 'iq')
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}


function applyBowwwlFallbacks_(product, fallback) {
  if (!product || !fallback) return product;
  if (isBlank_(product.coverstock)) product.coverstock = fallback.coverstock;
  if (isBlank_(product.core)) product.core = fallback.core;
  if (isBlank_(product.finish)) product.finish = fallback.finish;
  if (isBlank_(product.rg)) product.rg = fallback.rg;
  if (isBlank_(product.differential)) product.differential = fallback.differential;
  // MB Diff is checked for every matched product, not only when another
  // Bowling.com detail is missing. A blank Bowwwl value normally indicates a
  // symmetric core.
  if (!isBlank_(fallback.mbDifferential)) product.mbDifferential = fallback.mbDifferential;
  return product;
}


function isBlank_(value) {
  return value === '' || value === null || typeof value === 'undefined';
}


function classifyCoreType_(value) {
  const normalized = cleanText_(value).toLowerCase();
  if (/\basymmet(?:ric|rical)\b/.test(normalized)) return 'Asymmetric';
  if (/\bsymmet(?:ric|rical)\b/.test(normalized)) return 'Symmetric';
  return '';
}


function classifyCoverType_(value) {
  const normalized = cleanText_(value).toLowerCase();
  if (/\b(?:plastic|polyester)\b/.test(normalized)) return 'Plastic';
  if (/\burethane\b/.test(normalized)) return 'Urethane';
  if (/\breactive\b/.test(normalized)) return 'Reactive';
  if (/\b(?:pearl|solid|hybrid)\b/.test(normalized)) return 'Reactive';
  return '';
}


function classifyCoverFinish_(value) {
  const normalized = cleanText_(value).toLowerCase();
  if (/\bhybrid\b/.test(normalized)) return 'Hybrid';
  if (/\bpearl\b/.test(normalized)) return 'Pearl';
  if (/\bsolid\b/.test(normalized)) return 'Solid';
  return '';
}


function normalizeReleaseMonth_(value) {
  const text = cleanText_(value);
  const match = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b(?:\s+\d{1,2},?)?[^0-9]*(\d{4})/i
  );
  if (!match) return text;
  const monthNumber = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  }[match[1].substring(0, 3).toLowerCase()];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return monthNames[monthNumber] + ' ' + match[2];
}


function productId_(product) {
  return normalizeUrl_(product && product.url);
}


/**
 * Returns the exclusion label, or an empty string for an eligible product.
 */
function excludedCondition_(name) {
  const normalized = cleanText_(name).toUpperCase();
  if (/\bALMOST\s+NEW\b/.test(normalized)) return 'ALMOST NEW';
  if (/\bX[\s-]*OUT\b/.test(normalized)) return 'X-OUT';
  if (/\bBLEM(?:ISH(?:ED)?)?\b/.test(normalized)) return 'BLEMISHED';
  if (/\bDRILLED\b/.test(normalized)) return 'DRILLED';
  return '';
}


function normalizeUrl_(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
}


function absoluteUrl_(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  // Bowling.com serves CDN images protocol-relative ("//cdn-images...").
  if (/^\/\//.test(value)) return 'https:' + value;
  return 'https://www.bowling.com/' + value.replace(/^\/+/, '');
}


function imageUrl_(image) {
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return imageUrl_(image[0]);
  return image && (image.url || image.contentUrl) ? (image.url || image.contentUrl) : '';
}


function numericPrice_(price) {
  if (price == null || price === '') return '';
  const number = Number(String(price).replace(/[^0-9.-]/g, ''));
  return isNaN(number) ? '' : number;
}


function cleanText_(value) {
  return decodeHtmlEntities_(String(value || '')).replace(/\s+/g, ' ').trim();
}


function decodeHtmlEntities_(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&#([0-9]+);/g, function(_, number) { return String.fromCharCode(parseInt(number, 10)); })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}


export {
  BOWLING_SCRAPER_HEADERS,
  RECENT_RELEASES_LIMIT,
  CURRENT_PRODUCTION_SOURCES,
  CURRENT_PRODUCTION_SUPPORTED_BRANDS,
  BOWWWL_DATABASE_HEADERS,
  releaseMonthSortKey_,
  readRecentReleasesFromMainSheet_,
  parseCurrentProductionPage_,
  parseBrunswickFamilyCurrent_,
  parseShopifyCurrent_,
  parseMotivCurrent_,
  parseStormCurrent_,
  absoluteManufacturerUrl_,
  readOutputProducts_,
  applyProductionStatuses_,
  findOfficialProductMatch_,
  productNameKey_,
  buildCatalogUrl_,
  buildBowwwlDatabaseUrl_,
  parseBowwwlDatabaseHtml_,
  parseBowwwlCells_,
  bowwwlCell_,
  bowwwlCellText_,
  bowwwlBallLink_,
  absoluteBowwwlUrl_,
  bowwwlNamedType_,
  parseProductDetails_,
  emptyProductDetails_,
  extractProductSpec_,
  escapeRegExp_,
  stripTags_,
  isReactiveCoverstock_,
  recentCatalogExclusion_,
  parseProductsFromHtml_,
  parseProductCardsFromHtml_,
  parseCardPrice_,
  parseProductsFromJsonLd_,
  findProductItemList_,
  productToOutputRow_,
  imageFormula_,
  loadProductStore_,
  migrateExistingOutputRow_,
  upsertProductsIntoStore_,
  mergeStoredRows_,
  mergeScrapedRow_,
  higherPrice_,
  valueAtColumn_,
  bowwwlProductKey_,
  compactMatchText_,
  applyBowwwlFallbacks_,
  isBlank_,
  classifyCoreType_,
  classifyCoverType_,
  classifyCoverFinish_,
  normalizeReleaseMonth_,
  productId_,
  excludedCondition_,
  normalizeUrl_,
  absoluteUrl_,
  imageUrl_,
  numericPrice_,
  cleanText_,
  decodeHtmlEntities_,
};
