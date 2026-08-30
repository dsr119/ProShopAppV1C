# ProShop App

Replaces the Perfexxxxion Pro Shop order-book spreadsheet with a web app.

- **Hosting** — GitHub Pages (static)
- **Database** — Supabase
- **Intake** — the existing Google Form via an Apps Script trigger, plus an
  order page embedded in the Google Sites website

## Layout

| Path | What |
|---|---|
| `migration/` | One-time import of the Excel workbook into Supabase |
| `app/` | The site itself (orders page, appointments calendar, order form) |
| `apps-script/` | Google Form → Supabase trigger, and the weekly Drive backup |

Start with [migration/README.md](migration/README.md).
