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
3. Delete whatever is in `Code.gs` and paste in all of
   [`form-to-supabase.gs`](form-to-supabase.gs). Save.
4. Pick **`testConnection`** from the function dropdown and press **Run**.
   Google will ask you to authorize the script — approve it. The log should
   say `Connected.`
5. Left sidebar → **Triggers** (the clock icon) → **Add Trigger**:
   - Function: `onFormSubmit`
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
