/**
 * Perfexxxxion Pro Shop -- weekly Supabase backup to Google Drive
 *
 * Writes every order, appointment and item to dated CSVs in a Drive folder,
 * once a week. Ten years of order history should not live in exactly one
 * place, and Supabase's free tier pauses projects that go quiet.
 *
 * Every name in this file is prefixed so it can sit in the same Apps Script
 * project as form-to-supabase.gs without colliding. Apps Script resolves
 * duplicate names arbitrarily, which is how the form trigger nearly ended up
 * running the wrong function.
 *
 * Setup lives in apps-script/README.md.
 */

var BACKUP_SUPABASE_URL = 'https://ngghyuvykqqklztvvmld.supabase.co';
var BACKUP_SUPABASE_KEY = 'sb_publishable_X-ZHYha1P8FPVL2rvAk-bA_CdXD8g-g';

var BACKUP_FOLDER = 'Perfexxxxion Pro Shop Backups';

// Roughly six months of weekly snapshots. Old ones are removed so the folder
// does not grow without limit.
var BACKUP_KEEP = 26;

// Leave blank for no email. Worth setting: a backup that quietly stopped
// running is indistinguishable from one that never existed.
var BACKUP_ALERT_EMAIL = '';

var BACKUP_TABLES = ['orders', 'appointments', 'items'];

// Supabase returns at most 1000 rows per response no matter what limit is
// asked for. Paging is not an optimization here -- without it the backup
// would silently contain the first 1000 of 2,176 orders and look fine.
var BACKUP_PAGE = 1000;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function bkHeader_(res, name) {
  var headers = res.getAllHeaders();
  for (var key in headers) {
    if (headers.hasOwnProperty(key) && key.toLowerCase() === name.toLowerCase()) {
      return String(headers[key]);
    }
  }
  return '';
}

function bkFetchAll_(table) {
  var rows = [];

  for (var from = 0; ; from += BACKUP_PAGE) {
    var res = UrlFetchApp.fetch(
      BACKUP_SUPABASE_URL + '/rest/v1/' + table + '?select=*',
      {
        headers: {
          apikey: BACKUP_SUPABASE_KEY,
          Authorization: 'Bearer ' + BACKUP_SUPABASE_KEY,
          Range: from + '-' + (from + BACKUP_PAGE - 1)
        },
        muteHttpExceptions: true
      }
    );

    var code = res.getResponseCode();
    if (code !== 200 && code !== 206) {
      throw new Error('Could not read ' + table + ': ' + code + ' ' + res.getContentText());
    }

    var batch = JSON.parse(res.getContentText() || '[]');
    rows = rows.concat(batch);

    // "0-999/2176"
    var range = bkHeader_(res, 'content-range');
    var total = range.indexOf('/') !== -1 ? Number(range.split('/')[1]) : NaN;

    if (batch.length < BACKUP_PAGE) break;
    if (!isNaN(total) && rows.length >= total) break;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function bkColumns_(rows) {
  // Union rather than the first row's keys, so a column that is null in the
  // first record still makes it into the file.
  var seen = {};
  var cols = [];
  for (var i = 0; i < rows.length; i++) {
    for (var key in rows[i]) {
      if (rows[i].hasOwnProperty(key) && !seen[key]) {
        seen[key] = true;
        cols.push(key);
      }
    }
  }
  return cols;
}

function bkEscape_(value) {
  if (value === null || value === undefined) return '';
  var s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function bkToCsv_(rows) {
  if (!rows.length) return '';
  var cols = bkColumns_(rows);
  var lines = [cols.join(',')];

  for (var i = 0; i < rows.length; i++) {
    var cells = [];
    for (var c = 0; c < cols.length; c++) cells.push(bkEscape_(rows[i][cols[c]]));
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

function bkFolder_() {
  var existing = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return existing.hasNext() ? existing.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

function bkStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Keeps the newest BACKUP_KEEP snapshots per table and trashes the rest.
 * Trash, not permanent deletion -- a pruning bug should be recoverable.
 */
function bkPrune_(folder, table) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(table + '-') === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });

  var removed = 0;
  for (var i = BACKUP_KEEP; i < files.length; i++) {
    files[i].setTrashed(true);
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function backupProShopToDrive() {
  var summary = [];
  try {
    var folder = bkFolder_();
    var stamp = bkStamp_();

    for (var i = 0; i < BACKUP_TABLES.length; i++) {
      var table = BACKUP_TABLES[i];
      var rows = bkFetchAll_(table);

      if (!rows.length) {
        // An empty result from a table that should have thousands of rows is
        // a failure wearing a success costume. Never overwrite with nothing.
        throw new Error(table + ' came back empty; refusing to write an empty backup.');
      }

      folder.createFile(table + '-' + stamp + '.csv', bkToCsv_(rows), MimeType.CSV);
      var pruned = bkPrune_(folder, table);
      summary.push(table + ': ' + rows.length + ' rows' + (pruned ? ' (' + pruned + ' old file(s) trashed)' : ''));
    }

    console.log('Backup complete -- ' + summary.join(', '));
    console.log('Folder: ' + bkFolder_().getUrl());
  } catch (err) {
    console.error('Backup FAILED: ' + err);
    if (BACKUP_ALERT_EMAIL) {
      try {
        MailApp.sendEmail(
          BACKUP_ALERT_EMAIL,
          'Pro shop: the weekly backup FAILED',
          'The weekly Supabase backup did not complete.\n\n' +
            'Error: ' + err + '\n\n' +
            'What did finish: ' + (summary.join(', ') || 'nothing') + '\n\n' +
            'Run backupProShopToDrive() by hand from the Apps Script editor to retry.'
        );
      } catch (mailErr) {
        console.error('Could not send the alert email: ' + mailErr);
      }
    }
    throw err;   // surfaces in the Apps Script execution log as a failure
  }
}

// ---------------------------------------------------------------------------
// Setup helpers -- run these by hand from the editor
// ---------------------------------------------------------------------------

/** Creates the weekly trigger. Safe to run twice; it replaces its own. */
function setupWeeklyBackupTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'backupProShopToDrive') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('backupProShopToDrive')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(3)
    .create();

  console.log('Weekly backup scheduled for Sunday mornings, around 3am.');
}

/** Shows what is in the backup folder right now. */
function listBackups() {
  var folder = bkFolder_();
  var it = folder.getFiles();
  var found = [];
  while (it.hasNext()) {
    var f = it.next();
    found.push(f.getName() + '  ' + Math.round(f.getSize() / 1024) + ' KB');
  }
  found.sort();
  console.log('Folder: ' + folder.getUrl());
  console.log(found.length ? found.join('\n') : 'No backups yet.');
}
