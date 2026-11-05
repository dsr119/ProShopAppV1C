# Pro Shop on the Even G2

Jarvis and the day board, on your glasses.

- **Home** shows today's appointments, the next few days, and open tickets for
  your house, the same as the wall board. Swipe to move, press to open one,
  double press to leave the app.
- **Hold to talk to Jarvis.** Release, and the glasses show what they heard.
  Press to send it, hold to say it again, double press to drop it. Nothing
  reaches Jarvis until you've seen the words. Jarvis is the same assistant as the shop
  laptop, so anything it can do there works here: book or check appointments,
  check an order, **add an order**, add or change a work order, make a draft
  Square invoice.
- **Menu** (tap, then long press): Talk to Jarvis (press to stop instead of
  holding), Refresh, Switch house (Valley, South Side, Both).
- **Phone screen:** the Jarvis password and the house. Fill them in once.

## How it fits together

```
G2 mic → phone (this app) → alexa-work-order (Supabase): Deepgram turns the audio into words
       → you confirm on the glasses → alexa-work-order again: Claude does it, says what it did
Home list ← Supabase REST, read-only, with the web app's publishable key
```

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
gestures can be tried anywhere. Without it the app reads the real shop data.

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
