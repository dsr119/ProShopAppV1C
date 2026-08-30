/**
 * Perfexxxxion Pro Shop -- Google Form -> Supabase
 *
 * Runs on every form submission and writes the order into the orders table,
 * so it lands at the top of Amy's queue without anyone touching a spreadsheet.
 *
 * The form itself is untouched and keeps working exactly as it does today.
 * This trigger runs AFTER the customer has submitted, so nothing here can
 * stop a submission or show the customer an error -- which is precisely why
 * a failure has to be recorded loudly rather than swallowed. A dropped order
 * is a customer standing at the counter asking about a ball nobody ordered.
 *
 * Setup lives in apps-script/README.md.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var SUPABASE_URL = 'https://ngghyuvykqqklztvvmld.supabase.co';
var SUPABASE_KEY = 'sb_publishable_X-ZHYha1P8FPVL2rvAk-bA_CdXD8g-g';

// Where failed submissions are parked so they can be replayed. Created on
// demand in whatever spreadsheet this script is bound to.
var FAILURE_SHEET = 'Supabase Sync Failures';

// Leave blank for no email. If set, you get a message the moment an order
// fails to reach Supabase, instead of finding out from the customer.
var ALERT_EMAIL = '';

var MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Normalization -- must agree with migration/migrate.py, or the app ends up
// with two spellings of the same location again.
// ---------------------------------------------------------------------------

var LOCATION_MAP = {
  'valley': 'Valley',
  'valleylanes': 'Valley',
  'valleybowlinglanes': 'Valley',
  'carbondale': 'Valley',
  'south': 'South Side',
  'southside': 'South Side',
  'scranton': 'South Side',
  'idlehours': 'South Side',
  'idlehourssouth': 'South Side',
  'both': 'Both'
};

function normalizeKey_(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns { value, unmapped }. The orders table has a CHECK constraint on
 * location, so an unrecognized answer -- the form's "Other:" box -- must come
 * back as null and be preserved in notes. Passing it through would make
 * Postgres reject the whole row and lose the order.
 */
function normalizeLocation_(raw) {
  var key = normalizeKey_(raw);
  if (!key || key === 'x' || key === 'na' || key === 'none') {
    return { value: null, unmapped: null };
  }
  if (LOCATION_MAP[key]) return { value: LOCATION_MAP[key], unmapped: null };
  return { value: null, unmapped: String(raw).trim() };
}

function normalizePhone_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return { value: null, unmapped: null };
  var digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.substring(1);
  if (digits.length === 10) {
    return {
      value: digits.substring(0, 3) + '-' + digits.substring(3, 6) + '-' + digits.substring(6),
      unmapped: null
    };
  }
  // "messenger", "Fb messenger" and a person's name all appear in the history.
  return { value: null, unmapped: s };
}

// ---------------------------------------------------------------------------
// Reading the submission
// ---------------------------------------------------------------------------

/**
 * Works whether the trigger is installed on the linked Spreadsheet
 * (e.namedValues) or on the Form itself (e.response), so the setup
 * instructions cannot pick the wrong one.
 */
function extractAnswers_(e) {
  var answers = {};

  if (e && e.namedValues) {
    for (var title in e.namedValues) {
      if (!e.namedValues.hasOwnProperty(title)) continue;
      var v = e.namedValues[title];
      answers[title] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return answers;
  }

  if (e && e.response && e.response.getItemResponses) {
    var items = e.response.getItemResponses();
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getResponse();
      answers[items[i].getItem().getTitle()] = Array.isArray(r) ? r.join(', ') : String(r);
    }
    if (e.response.getRespondentEmail) {
      var email = e.response.getRespondentEmail();
      if (email) answers['Email Address'] = email;
    }
    return answers;
  }

  throw new Error('Unrecognized trigger payload -- no namedValues or response.');
}

/**
 * Matches on a distinctive fragment of the question rather than the exact
 * title, so rewording "Please enter your full name" does not silently stop
 * capturing names.
 */
function findAnswer_(answers, fragments) {
  var keys = Object.keys(answers);
  for (var f = 0; f < fragments.length; f++) {
    var needle = normalizeKey_(fragments[f]);
    for (var k = 0; k < keys.length; k++) {
      if (normalizeKey_(keys[k]).indexOf(needle) !== -1) {
        var val = String(answers[keys[k]]).trim();
        if (val) return val;
      }
    }
  }
  return '';
}

function buildOrder_(answers, timestamp) {
  var notes = [];

  var name = findAnswer_(answers, ['fullname', 'yourname', 'name']);
  var item = findAnswer_(answers, ['itemyouwouldliketoorder', 'item']);

  var phone = normalizePhone_(findAnswer_(answers, ['phonenumber', 'phone']));
  if (phone.unmapped) notes.push('phone on file: ' + phone.unmapped);

  var orderLoc = normalizeLocation_(findAnswer_(answers, ['orderlocation']));
  if (orderLoc.unmapped) notes.push('order location: ' + orderLoc.unmapped);

  var pickupLoc = normalizeLocation_(findAnswer_(answers, ['pickuplocation']));
  if (pickupLoc.unmapped) notes.push('pickup location: ' + pickupLoc.unmapped);

  var submitted = timestamp ? new Date(timestamp) : new Date();

  return {
    customer_name: name || 'Unknown',
    email: findAnswer_(answers, ['emailaddress', 'email']) || null,
    phone: phone.value,
    item: item,
    quantity: 1,
    fitting: findAnswer_(answers, ['fitted', 'specsonfile', 'fitting']) || null,
    order_location: orderLoc.value,
    pickup_location: pickupLoc.value,
    notes: notes.length ? notes.join('; ') : null,
    source: 'google_form',
    is_stock: false,
    // Left null on purpose: null means "the shop has not ordered this yet",
    // which is what pins the row to the top of the orders page.
    shop_order_date: null,
    submitted_at: submitted.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function postToSupabase_(order) {
  var lastError = '';

  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/orders', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Prefer: 'return=minimal'
      },
      payload: JSON.stringify(order),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return;

    lastError = code + ' ' + res.getContentText();

    // 4xx is a bad row -- retrying sends the identical row and fails
    // identically. Only a server-side or transport problem is worth a retry.
    if (code >= 400 && code < 500) break;
    if (attempt < MAX_ATTEMPTS) Utilities.sleep(attempt * 1000);
  }

  throw new Error('Supabase rejected the order: ' + lastError);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Trigger entry point. Deliberately NOT called onFormSubmit: a spreadsheet
 * that already has automation often has a function by that name, and Apps
 * Script warns that duplicate names give "undefined behavior" -- it picks one
 * arbitrarily, so the trigger may run the wrong code. This name will not
 * collide with anything.
 */
function syncOrderToSupabase(e) {
  var order = null;
  try {
    var answers = extractAnswers_(e);
    order = buildOrder_(answers, e && e.values ? e.values[0] : null);

    if (!order.item) throw new Error('Submission had no item; nothing to order.');

    postToSupabase_(order);
    console.log('Order synced: ' + order.customer_name + ' / ' + order.item);
  } catch (err) {
    // Never rethrow. The customer has already submitted, and an uncaught
    // error here would only fill the execution log while the order vanishes.
    console.error('Form sync failed: ' + err);
    recordFailure_(order, e, err);
  }
}

function recordFailure_(order, e, err) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      var sheet = ss.getSheetByName(FAILURE_SHEET);
      if (!sheet) {
        sheet = ss.insertSheet(FAILURE_SHEET);
        sheet.appendRow(['When', 'Error', 'Order JSON', 'Raw submission', 'Replayed']);
        sheet.setFrozenRows(1);
      }
      sheet.appendRow([
        new Date(),
        String(err),
        order ? JSON.stringify(order) : '',
        JSON.stringify((e && e.namedValues) || (e && e.values) || {}),
        ''
      ]);
    }
  } catch (logErr) {
    console.error('Could not write the failure row: ' + logErr);
  }

  if (ALERT_EMAIL) {
    try {
      MailApp.sendEmail(
        ALERT_EMAIL,
        'Pro shop: a form order did NOT reach the app',
        'A customer submitted the order form but it could not be saved.\n\n' +
          'Error: ' + err + '\n\n' +
          'Order: ' + (order ? JSON.stringify(order, null, 2) : '(not parsed)') + '\n\n' +
          'It is parked on the "' + FAILURE_SHEET + '" sheet. Run replayFailures() ' +
          'once the problem is fixed, or enter it by hand in the app.'
      );
    } catch (mailErr) {
      console.error('Could not send the alert email: ' + mailErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Manual helpers -- run these from the Apps Script editor
// ---------------------------------------------------------------------------

/** Confirms the URL and key work. Writes nothing. */
function testConnection() {
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/orders?select=id&limit=1', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 200) {
    console.log('Connected. Supabase is reachable and the key works.');
  } else {
    console.error('Connection failed: ' + code + ' ' + res.getContentText());
  }
}

/**
 * Inserts one obvious test order so the whole path can be checked, then tells
 * you how to remove it. Safe to run; it is clearly labelled in the app.
 */
function testInsert() {
  var order = buildOrder_({
    'Email Address': 'test@example.com',
    'Please enter your full name': 'ZZ Apps Script Test (delete me)',
    'Please enter your phone number': '(570) 555-0000',
    'Order Location': 'South',
    'Pickup Location': 'Valley',
    'Do you need to be fitted for your ball or do we have your specs on file': 'Specs on file',
    'Please enter the item you would like to order.': 'Ball: TEST ROW please delete 15 lb'
  }, new Date());

  postToSupabase_(order);
  console.log('Inserted. It is at the top of the orders page as "ZZ Apps Script Test".');
  console.log('Remove it with:  delete from orders where customer_name like \'ZZ Apps Script%\';');
}

/** Retries everything parked on the failure sheet. */
function replayFailures() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss && ss.getSheetByName(FAILURE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    console.log('Nothing to replay.');
    return;
  }

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  var replayed = 0;

  for (var i = 0; i < values.length; i++) {
    if (values[i][4]) continue;          // already replayed
    if (!values[i][2]) continue;         // never parsed into an order
    try {
      postToSupabase_(JSON.parse(values[i][2]));
      sheet.getRange(i + 2, 5).setValue(new Date());
      replayed++;
    } catch (err) {
      console.error('Row ' + (i + 2) + ' still failing: ' + err);
    }
  }
  console.log('Replayed ' + replayed + ' order(s).');
}
