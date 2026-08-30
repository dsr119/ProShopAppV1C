# Apps Script

Two scripts. They can live in the same Apps Script project — every name in
each file is distinct, so nothing collides.

| File | What it does |
|---|---|
| [`form-to-supabase.gs`](form-to-supabase.gs) | Google Form submissions → the `orders` table |
| [`weekly-backup.gs`](weekly-backup.gs) | Weekly CSV snapshot of the database → Google Drive |

---

# Google Form → Supabase

Sends every order-form submission into the `orders` table, so it appears at
the top of the orders page without anyone opening a spreadsheet.

**The form does not change.** Customers see exactly what they see today, at
the same link. The form keeps writing to its spreadsheet as well — this runs
alongside it, so nothing is lost while both systems are in use.

## Setup

1. Open the spreadsheet the form writes to (the one with the **Shop Order
   Ledger** tab).
2. **Extensions → Apps Script**.
3. Add a **new file** (the `+` next to Files → Script), name it
   `SupabaseSync`, and paste in all of
   [`form-to-supabase.gs`](form-to-supabase.gs). Save.

   Use a new file rather than overwriting `Code.gs` — whatever is already in
   there may be doing something the shop relies on. The entry point here is
   called `syncOrderToSupabase` precisely so it cannot clash with an existing
   `onFormSubmit`. If Apps Script warns about *"functions with the same
   name … undefined behavior"*, you have the same code pasted twice; delete
   the extra copy before continuing.
4. Pick **`testConnection`** from the function dropdown and press **Run**.
   Google will ask you to authorize the script — approve it. The log should
   say `Connected.`
5. Left sidebar → **Triggers** (the clock icon) → **Add Trigger**:
   - Function: `syncOrderToSupabase`
   - Event source: **From spreadsheet**
   - Event type: **On form submit**
   - Save.
6. Run **`testInsert`** once. A row called *ZZ Apps Script Test (delete me)*
   appears at the top of the orders page. Remove it with:

   ```sql
   delete from orders where customer_name like 'ZZ Apps Script%';
   ```

7. Submit the real form once yourself and confirm it lands in the app.

## What it does to each submission

| Form question | Column | Notes |
|---|---|---|
| Email | `email` | |
| Please enter your full name | `customer_name` | |
| Please enter your phone number | `phone` | Reformatted to `570-555-1234` |
| Order Location | `order_location` | |
| Pickup Location | `pickup_location` | |
| Do you need to be fitted… | `fitting` | |
| Please enter the item… | `item` | |
| *(submission time)* | `submitted_at` | |

`source` is set to `google_form`, and `shop_order_date` is left empty — empty
is what means "the shop has not ordered this yet", which is what pins the row
to the top of the orders page.

### Two answers that need translating

**The form says "South", the app says "South Side".** The `orders` table has a
CHECK constraint that accepts only `Valley`, `South Side` and `Both`. Sending
the form's answer through unchanged fails with a constraint violation and the
order is lost, so "South" is mapped on the way in.

**Pickup Location has an "Other:" box.** Free text there is where `Scranton`,
`Idle Hours South` and a bare `x` in the old order book came from. Anything
recognizable is mapped (Scranton and Idle Hours → South Side, Carbondale →
Valley). Anything else leaves the location empty and is preserved in the
order's notes — so an unusual answer costs you a blank field, never the order.

The same happens to a phone number that isn't a phone number. `messenger` and
`Fb messenger` both appear in the history; they end up in notes.

## When a submission fails

The trigger runs *after* the customer has submitted, so it cannot show them an
error or stop the form. That makes silent failure the real risk, so:

- Failed submissions are parked on a **Supabase Sync Failures** sheet with the
  full payload.
- Set `ALERT_EMAIL` at the top of the script to get an email the moment one
  fails, rather than hearing about it from the customer.
- Once the problem is fixed, run **`replayFailures`** to send the parked rows.
  Rows already replayed are marked and skipped.

A 4xx response is not retried — the same row would be rejected the same way.
Anything else gets three attempts with a growing delay.

## If the form changes

Questions are matched on a distinctive fragment rather than the exact title,
so light rewording is safe. Adding a genuinely new question does nothing until
it is mapped in `buildOrder_`. If you rename a question to something quite
different, run `testInsert` afterwards and check the value still arrives.

---

# Weekly backup → Google Drive

Writes every order, appointment and item to dated CSVs in a Drive folder,
once a week. Ten years of order history should not live in exactly one place,
and Supabase pauses free-tier projects that go quiet.

## Setup

1. Same Apps Script project as the form trigger is fine — add a **new file**
   called `WeeklyBackup` and paste in
   [`weekly-backup.gs`](weekly-backup.gs). Save.
2. Run **`backupProShopToDrive`** once by hand. Google will ask for Drive
   permission the first time. The log ends with the folder's URL.
3. Run **`setupWeeklyBackupTrigger`** once. That schedules it for Sunday
   mornings around 3am. Safe to run twice — it replaces its own trigger.
4. Set `BACKUP_ALERT_EMAIL` at the top of the file. A backup that quietly
   stopped running is indistinguishable from one that never existed.

`listBackups` prints what is currently in the folder.

## What you get

A folder called **Perfexxxxion Pro Shop Backups** containing:

```
orders-2026-08-30.csv         every column, ~2,200 rows
appointments-2026-08-30.csv
items-2026-08-30.csv
```

Every column is included, `select=*`, so a column added later is picked up
without touching this script. Soft-deleted rows are included too — a backup
that drops the rows someone deleted is not much of a backup.

The newest 26 snapshots of each table are kept (about six months) and older
ones are moved to Drive's trash, not destroyed.

## Two things this gets right on purpose

**It pages.** Supabase returns at most 1000 rows per response regardless of
the limit requested. Without paging the backup would contain the first 1000 of
2,176 orders and give no sign anything was missing — the worst possible
failure for a backup. It walks the table with `Range` headers and checks the
reported total.

**It refuses to write an empty file.** If a table comes back with no rows, the
run fails loudly instead of replacing a good snapshot with an empty one. An
empty result from a table that should hold thousands of rows is a failure
wearing a success costume.

## Restoring

The CSVs import straight back through the Supabase dashboard
(Table Editor → Import data from CSV), or open in Excel and Google Sheets as
they are. Column order matches the table.
