# ProShop App

Replaces the Perfexxxxion Pro Shop order-book spreadsheet with a web app.

- **Hosting** — GitHub Pages (static)
- **Database** — Supabase
- **Intake** — the existing Google Form via an Apps Script trigger, plus an
  order page embedded in the Google Sites website

## Layout

| Path | What |
|---|---|
| `migration/` | One-time import of the Excel workbook into Supabase, plus the later schema changes |
| `app/` | The site itself |
| `apps-script/` | Google Form → Supabase trigger, and the weekly Drive backup |

Start with [migration/README.md](migration/README.md).

## Pages

| Page | Who opens it | What it is for |
|---|---|---|
| `index.html` | Behind the counter | The order book. Every order, inline editable, bulk "mark as ordered" |
| `drilling.html` | The bench | Customer orders waiting to be drilled, with a due date and an owner |
| `appointments.html` | Behind the counter | Month calendar |
| `order.html` | Behind the counter | Taking an order at the counter |
| `tickets.html` | Keith | Reviewing staff tickets and handing them out |
| `ticket.html` | Any staff member | Sending a ticket in. Bookmark this one on phones |
| `board.html` | Nobody — it is read | The wall screen on the Raspberry Pi |

## Tickets

Staff open **`ticket.html`** — name, what is wrong, how urgent, send. That is
the whole page. It asks for nothing else because a person reporting a jammed
ball return should not be choosing who fixes it.

Keith opens **`tickets.html`**. It defaults to the *To review* tab, because the
failure mode of a ticket system is not a lost ticket, it is a ticket nobody has
looked at. Assigning a ticket from the dropdown on its card also moves it out
of that tab; un-assigning it puts it back.

**Staff names** live in one place — *Tickets → Manage staff*. That roster fills
every "assign to" dropdown in the app: tickets, the drilling queue, and the
appointment dialog. Renaming someone there changes the dropdowns everywhere.
Removing someone takes their name out of the dropdowns but leaves it on the
work they already did — nothing is erased, so last winter's record still says
who did it.

Names are matched as text rather than by a foreign key, on purpose:
`orders.staff_member` came out of the workbook as free text, and a foreign key
would have rejected ten years of history. The roster supplies the spelling; it
does not police what is already recorded.

## The day board

`board.html` is a read-only wall screen. **One board per house**, so each Pi
opens its own URL:

```
https://YOUR-GITHUB-PAGES-URL/app/board.html?location=Valley
https://YOUR-GITHUB-PAGES-URL/app/board.html?location=South%20Side
```

The house is named in the header and in the browser tab title — two
identical-looking dark screens in two buildings is exactly how someone ends up
working from the wrong one. Everything is filtered to that house: appointments,
orders and tickets alike. Anything marked "Both", or with no location set at
all, shows on both boards.

Left column is **Appointments** — today first, then what is coming. Right column
is **Open tickets**. Every line carries what someone glancing up needs: who it
is for, their phone number, what we are doing, when it is due, whether it is
paid, and whose job it is. On a ticket, Keith's note from the review page shows
underneath in blue — that is the line telling someone what to actually do.

It takes its data from the rest of the app. Nothing is entered on the board:

| What the board shows | Where it is set |
|---|---|
| Today's appointments | Appointments page |
| Who owns an appointment, and whether it is paid | Appointment dialog |
| Orders due, and how late they are | Drilling page — the Due and Assigned columns |
| Open tickets | Tickets page |

Options, all optional, on the URL:

| Query | Default | What it does |
|---|---|---|
| `?days=14` | 7 | How far ahead "coming up" reaches |
| `?location=Valley` | both | Limit to one house |
| `?refresh=30` | 60 | Seconds between polls |
| `?lookback=14` | 30 | How far back overdue work keeps showing |
| `?page=20` | 12 | Seconds a page is held before it flips |
| `?rotate=0` | on | Stop paging; show only the top of each column |

They combine: `board.html?location=South%20Side&days=14`.

### Today is pinned

Both columns are split. **Today sits at the top and never rotates** — it is the
reason anyone looks up at the screen, so it has to still be there when they do.
Only what is below it pages.

On the tickets side "today" means any of three things: due today, already past
due, or filed as urgent — which is what the submit form's own wording for that
option says ("Urgent — today").

The pinned band takes the height it needs and the rotating block gives up its
space first, so on a normal day nothing about today ever moves. On a day so
full that today alone will not fit even then, the pinned band pages too, with
its own small counter in the corner. Rotating today's rows is bad; hiding some
of them below a hard edge for ever is worse.

### When there is more than fits

The rotating part of each column pages. It holds a screenful still for twelve
seconds, then flips to the next and loops back round — the header shows `2/4`
so nobody has to wonder whether they are seeing everything. A column whose list
already fits does not page at all and shows no counter.

Pages break between rows, never through one, and a "Today" or "Coming up"
heading is never left stranded at the foot of a page with its first row
overleaf. The bottom edge fades so a part-visible row reads as "there is more"
rather than as something clipped.

It deliberately does **not** scroll continuously. A creeping list means the line
you are trying to read is always moving; holding a page still and then flipping
it lets someone read from across the room.

### Raspberry Pi setup

On Raspberry Pi OS with the desktop, install a kiosk browser and point it at
the deployed board:

```bash
sudo apt update && sudo apt install -y chromium-browser unclutter
```

Create `~/.config/autostart/proshop-board.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=ProShop Day Board
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito --check-for-update-interval=604800 "https://YOUR-GITHUB-PAGES-URL/app/board.html?location=Valley"
X-GNOME-Autostart-enabled=true
```

Replace the URL with the real one, and set `?location=` to whichever house
this Pi is in. The quotes matter — without them the shell eats the `?`. Then
stop the screen blanking:

```bash
sudo raspi-config nonint do_blanking 1
```

The board looks after itself from there. It polls every minute, keeps the last
good list on screen if the network drops (and says so), rolls over to the new
day at midnight without anyone touching it, and reloads itself at 3am to pick
up any deploy and to shake off a browser that has been open for six months.

## Deploying

GitHub Pages serves static assets with a long cache life, so **bump the `?v=`
query on every `<script>` and `<link>` when you change one of them**, or
browsers keep the old copy. They are all on the same number; the current one
is `v=17`.

## Local development

```bash
python3 -m http.server 8765 --directory app
```

Then open <http://localhost:8765>. There is no build step — the app is plain
HTML, CSS and JavaScript, and `app/db.js` talks to Supabase's REST API over
`fetch` with no SDK.
