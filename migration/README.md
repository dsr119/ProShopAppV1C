# Migration: Order Book workbook → Supabase

One-time import of the `PerfexxxxionProShop Order Book` workbook into the
`orders`, `appointments`, and `items` tables.

## Running it

```bash
python -m pip install openpyxl
cd migration
python migrate.py
```

Reads `source.xlsx`, writes to `output/`. Safe to re-run — it overwrites the
output and never touches the workbook.

## What comes out

| File | Rows | What it is |
|---|---|---|
| `orders.csv` | 2,176 | Every order, deduped and normalized |
| `appointments.csv` | 179 | Every appointment |
| `items.csv` | 1,474 | Distinct item names for the autocomplete |
| `review_needed.csv` | 530 | Rows worth a human look — **also present in the files above** |
| `report.txt` | — | Per-sheet counts, flag breakdown, value check |

Nothing is dropped. Problem rows are imported *and* flagged in
`migration_flag`, so a bad phone number never blocks the import.

## The three column layouts

The workbook's columns changed shape three times. Each generation gets its own
index map in `migrate.py`:

| Layout | Sheets | Notable |
|---|---|---|
| `LAYOUT_FORM_2026` | Shop Order Ledger, 2026 Q1/Q2, Sheet26 | Raw Google Form headers; adds Order + Pickup Location |
| `LAYOUT_2025_Q4` | 2025 Q4 | Has Location and Shop Order Date |
| `LAYOUT_2025_Q3` | 2025 Q3 | No Location column |
| `LAYOUT_2025_H1` | 2025 Q1/Q2 | No Location **and no Shop Order Date** |
| `LAYOUT_ALL_ORDERS_TOP` | All Orders rows 2–40 | Dec 2025, its own shape |

**2025 Q1/Q2 have no Shop Order Date column at all.** Since a NULL there means
"not ordered yet," importing those ~500 rows as-is would park a year of
completed history permanently at the top of the orders page. The script falls
back to Order Date and flags each one.

**`All Orders` is two sheets stacked.** The lower portion was pasted from the
2026 form export, which shifts every field two columns right — customer names
land in Phone Number, ball names in Item Description. `looks_like_form_row()`
detects this per row using two independent signals (an email or `---` in
column B, or columns E and F *both* reading as locations). Detecting it by the
`---` placeholder alone misses ~30 rows that carry a real timestamp and email.

## Deduplication

Sheet26 duplicates 2026 Q2 almost entirely (186 of 197 rows) and the lower half
of `All Orders` duplicates 2026 Q1 (353 of 401). Rows are matched on business
facts — customer, item, date, price, supplier order # — rather than on any ID
column, since the ID columns are inconsistent or empty. Sheets are processed in
priority order and the first to claim a row wins. **588 duplicates dropped.**

## Normalization

- **Locations** → `Valley` | `South Side` | `Both`. Folds in `Valley Lanes`,
  `Southside`, `Scranton`, `Idle Hours South`. Junk (`x`, `-`) becomes NULL.
- **Booleans** — `Y`/`y`/`yes`/`Yes`/`paid` → true; `na`/`n`/blank → false.
- **Phones** → `570-555-1234`. Floats (`5709779123.0`) are fixed. Anything not
  a usable number (`messenger`, a person's name) moves into `notes` and flags.
- **Order/Invoice #** → the `.0` float artifact is stripped.
- **Prices** → numeric; `$` and `,` tolerated.

## Sheets not migrated

| Sheet | Why |
|---|---|
| `DashboardData` | Derived view of All Orders, no unique data |
| `Service Tracker` | Out of scope for v1 |
| `Sheet28` | Read separately as the autocomplete source |
| `Sheet29`, `DONT TOUCH…` | Empty |
| `Time` | Shop hours — not an order or appointment |

## Then

1. Run `schema.sql` in the Supabase SQL editor.
2. Import the three CSVs (see the note at the bottom of `schema.sql`).
3. Work through `review_needed.csv` whenever convenient — it's not a blocker.

## Later changes

These came after the import. Run them in order, in the Supabase SQL editor.
Each is idempotent — running one twice does nothing the second time.

| File | Adds | Needed by |
|---|---|---|
| `add_drilled.sql` | `orders.drilled`, `drilled_at` | Drilling page |
| `add_no_drill_needed.sql` | `orders.no_drill_needed` | Drilling page |
| `add_staff_and_tickets.sql` | `staff` and `tickets` tables | Tickets pages |
| `add_board_fields.sql` | `appointments.staff_member`, `appointments.paid`, `orders.due_date` | Day board |
| `add_hours.sql` | `hours` table, seeded with the fourteen rows | Weekly hours confirmation, and the public website |

`add_staff_and_tickets.sql` seeds the roster from names already recorded in
`orders.staff_member`, so the assign dropdowns are not empty on day one. Edit
the list afterwards from **Tickets → Manage staff**, not in SQL.
