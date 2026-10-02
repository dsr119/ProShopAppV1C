# Ball catalog and backups

Scheduled jobs that run on GitHub Actions. They replace the Apps Script that
lived on the **Proshop Ball Sheet** and the weekly Drive backup script.

| Workflow | When | What |
|---|---|---|
| [Ball scraper](../.github/workflows/ball-scraper.yml) | Daily, 11:00 UTC | bowling.com + Bowwwl + manufacturer sites → `balls` table |
| [Weekly backup](../.github/workflows/weekly-backup.yml) | Sundays, 07:00 UTC | Every table → encrypted CSV bundle, kept 90 days |

Both can also be started by hand: **Actions → pick the workflow → Run workflow**.
The scraper has a *dry run* box that scrapes and reports without saving.

## One-time setup

Repository **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Where it comes from |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → the **secret** (service_role) key |
| `BACKUP_PASSPHRASE` | Make one up and keep it somewhere safe. Without it the backups cannot be opened |

The service-role key can write to every table, so it only ever goes in
Actions secrets — never in a page, the app's `config.js`, or a commit.

## The ball scraper

[`ball-scraper.mjs`](ball-scraper.mjs) runs the same pipeline as the sheet's
**Refresh all bowling data**:

1. Reads the first two pages of the Bowwwl database (15 lb, US releases) for
   specs bowling.com leaves out, and for release months.
2. Walks bowling.com brand by brand, page by page, reading each product page.
   New balls are added; existing ones are updated. The highest price ever
   seen is kept, and a stored release month is never overwritten.
   *Almost New*, *X-Out*, *Blemished* and *Drilled* listings are skipped.
3. Checks each manufacturer's "current" page. A ball that is not listed is
   **Discontinued: Yes**. Columbia 300 has no usable official list, so its
   balls stay **Unknown**.
4. Marks the 20 newest reactive balls `is_recent_release` — that is the
   website's *New Releases* strip.

[`rules.mjs`](rules.mjs) is the Apps Script's parsing and matching code,
copied unchanged so the catalog comes out the same as the sheet's. When a
site changes its markup, that is the file to fix.

Safeguards:

- If no brand on bowling.com yields any products, the run fails and saves nothing.
- If a manufacturer page fails, the scrape is still saved but every
  Discontinued value is left as it was, and the run is marked failed.
- It refuses to save if the catalog would shrink by more than 20%.

A failed run shows red on the Actions tab, and GitHub emails the repo owner.

Test it without the network: `node --test tests/ball-scraper.test.mjs`.

### Staff picks

`staff_bags` has one row per staff member: their name, the order they appear
on the page (`sort_order`), and `balls`, a list of ball names exactly as they
appear in the catalog. Edit it in Supabase → Table Editor. The scraper never
touches it.

### Where the data came from

The sheet's *Bowling Balls* and *staffMembersBag* tabs were imported once on
2026-10-02 with [`export-sheet.py`](export-sheet.py) and
[`import-sheet.mjs`](import-sheet.mjs). The imported rows are in
[`seed/`](seed/).

## Backups

Each Sunday's backup is an artifact on that run's page (Actions → Weekly
backup → the run → *Artifacts*). To open one:

```bash
unzip proshop-backup-2026-10-04.zip
openssl enc -d -aes-256-cbc -pbkdf2 -in proshop-backup-2026-10-04.tar.gz.enc -out backup.tar.gz
# asks for BACKUP_PASSPHRASE
tar xzf backup.tar.gz   # backup/orders.csv, backup/appointments.csv, ...
```

The workflow also re-enables both schedules each week. GitHub switches off
scheduled workflows in a repository that has had no commits for 60 days, and
these jobs never commit.
