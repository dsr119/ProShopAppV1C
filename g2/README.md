# Pro Shop on the Even G2

The day board and EDITH (the shop's voice assistant, Jarvis on the shop
laptop) on your glasses.

- **Dashboard** (the main screen): the time and date, today's appointments
  and the next one coming, and open tickets with the urgent and overdue ones
  first. Below that: **All appointments**, **All tickets**, **Talk to EDITH**.
  Swipe to move, press to open. Double press here exits the app.
- **All appointments** lists every booking from today out two weeks;
  **All tickets** lists every open ticket. Press one for its details. Double
  press goes back.
- **Talk to EDITH from any screen.** Hold, talk, release. The glasses show
  what they heard: press to send, hold to say it again, double press to drop it.
  EDITH can:
  - check, book and change appointments
  - check, **add, change and delete orders**
  - add, change and **delete work orders**
  - make, **find, change and delete Square invoices** (drafts are deleted,
    sent unpaid ones are cancelled, paid ones are left alone)

  Every delete is read back to you first and needs a "yes". Deleted orders and
  work orders are only hidden (`deleted_at`), so they can be brought back.
- **Spec sheets.** Hold and say "pull up the spec sheet for Joe Sutton" (or
  "show me Joe Sutton's specs", or menu → **Spec sheet** and just say the
  name). The app finds the bowler in ProshopSpeccy; if more than one matches,
  pick from the list. The sheet shows in three parts:
  1. **Fingers:** reverse, lateral and forward pitch for each finger on the
     outside, grip size (with grip number), hole size, grip brand and inserts
     in the middle, grips and bridge underneath. Middle finger on the left,
     ring on the right, like the paper sheet.
  2. **Span:** middle and ring. **Swipe** to switch between **F**ull, **C**ut
     to cut and **CTO** (cut to outer); only the ones measured are offered,
     and it opens on the one the sheet shows.
  3. **Thumb:** forward, reverse, left and right pitch around the slug and
     hole size, with the insert type.

  **Press** for the next part, **double press** to go back to the dashboard.
  No-thumb sheets only have the fingers. Sheets are read-only here. They're
  looked up directly, not by EDITH, so they don't use Claude at all.
- **Hands-free** (menu → Start hands-free): the mic stays open while the app
  is open. Say "Hey EDITH, make a work order for…". The words show with a 3
  second countdown, then send. Double press stops it, and press sends it right
  away. When EDITH asks you something, just answer within 30 seconds; you don't
  need the wake word. Each phrase is only sent for transcription when someone
  is actually talking, which costs about 25¢ an hour of real speech and uses
  more glasses battery.
- **Menu** (tap, then long press): Talk to EDITH, Spec sheet, Start/Stop hands-free,
  Refresh, Switch house (Valley, South Side, Both).
- **Phone screen:** the EDITH password (the `ALEXA_SHARED_SECRET`) and the house. Fill them in once.

## How it fits together

```
G2 mic → phone (this app) → alexa-work-order (Supabase): Deepgram turns the audio into words
       → you confirm on the glasses → alexa-work-order again: Claude does it, says what it did
Home list ← Supabase REST, read-only, with the web app's publishable key
Spec sheets ← ProshopSpeccy's Supabase REST, read-only, with its publishable key
```

Spec sheets only load while the Pro Shop in ProshopSpeccy is in open-link
mode (`shops.open_access`), the same setting that lets its web app work
without signing in. Turn that off and the glasses get "Couldn't reach the
spec sheets".

The app holds no secret of its own: the Jarvis password is typed on the phone
and kept in the Even app's storage for this app. The Deepgram, Anthropic and
Square keys stay in Supabase.

## One-time setup in Supabase

1. **Edge Functions → Secrets:** add `DEEPGRAM_API_KEY` (from
   console.deepgram.com).
2. **Edge Functions → alexa-work-order → Code:** paste the whole of
   `supabase/functions/alexa-work-order/index.ts`, then **Deploy**. This
   version lets the glasses call it, accepts audio, and adds orders. The shop
   laptop keeps working as before.

## Run it

Needs Node 20+ and, once: `npm install -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator`.

```bash
cd g2
npm install
npm run dev                      # dev server on port 5173
evenhub-simulator "http://localhost:5173/?demo"   # made-up data, no network needed
```

`?demo` fills the list with sample rows and fakes Jarvis, so the screens and
gestures can be tried anywhere. Add `&heard=spec+sheet+for+sample` and hold
to talk to try the spec sheet with two made-up bowlers. Without it the app reads the real shop data.

**On the glasses** (phone and computer on the same Wi-Fi):

```bash
evenhub qr --url "http://<your computer's LAN IP>:5173"
```

Scan it from the Even app's Even Hub tab (Developer Mode: sign in at
hub.evenrealities.com once, then force-quit and reopen the app). On Windows,
allow inbound TCP 5173 on the Private profile if the phone can't connect.

**Install it for real** (stays on the glasses menu, no computer needed):

```bash
evenhub login
npm run pack                     # builds proshop.ehpk
evenhub create proshop.ehpk --name "Pro Shop" --tagline "Jarvis on your glasses"   # first time
evenhub upload proshop.ehpk -m "What changed"                                       # after that
```

Then promote the build to Beta and add yourself as a tester (see the Even Hub
docs, Beta Testing). It never has to be submitted to the public store.

## Tests

```bash
npm test             # list building, times, audio encoding
```

The Jarvis side is tested with the rest of the repo: `node --test tests/*.test.cjs`.
