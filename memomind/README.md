# EDITH and Work Tickets on MemoMind glasses

The two G2 glasses apps, rebuilt for MemoMind glasses with the MemoMind SDK
("Plugin Open Platform"):

| App | Folder | Same as on the G2 | Built package (`npm run pack`) |
| --- | --- | --- | --- |
| EDITH Pro Shop: dashboard, appointments, tickets, talk to EDITH, spec sheets | `edith/` | `g2/` | `release/edith-0.1.0.mmpkg` |
| Work Tickets: IU19 helpdesk tickets as a to-do list, voice replies | `tickets/` | `g2-tickets/` | `release/work-tickets-0.1.0.mmpkg` |

Each is a MemoMind **Web plugin**: a small web page that runs inside the
MemoMind phone app and draws on the glasses through the app. Nothing has to
be installed on the glasses themselves beyond MemoMind's standard Web Bridge
glasses plugin (`com.gm.example.web-bridge`, in the SDK under
`GlassSDK/build-host/.build/web_bridge/`).

## What's shared and what's new

The data and voice code are the G2 apps' own files, imported straight from
`g2/src` and `g2-tickets/src`: Supabase reads, Jarvis (`alexa-work-order`),
the spec sheet lookups (ProshopSpeccy), the ticket email parser and the
`work-tickets` function. No server changes are needed.

New for MemoMind (`common/`):

- `glasses.ts`: the MemoMind bridge: text boxes on the 600×350 screen, button
  and head-gesture input, storage.
- `screen.ts`: fitting text and cursor lists to the boxes (MemoMind has no
  list widget like the G2's, so lists are drawn with a ▶ cursor).
- `voice.ts`: the glasses mic. MemoMind records Opus; it's decoded to the
  16 kHz PCM the transcriber already takes, on the phone.

## Controls

| | G2 | MemoMind |
| --- | --- | --- |
| Move in a list | swipe | look up / down (turn left / right jumps a page) |
| Open | press | tap the glasses button |
| Back | double press | double tap |
| Talk | hold, release when done | hold to start, **tap** when done (the button has no "let go" event) |
| Spec sheet span type | swipe | turn your head left / right |
| Menu | tap then long press | items at the bottom of the dashboard / ticket list |

Hands-free "Hey EDITH" isn't ported yet.

## Build

The MemoMind SDK files aren't kept in this repo (they come with the SDK under
MemoMind's terms). With the SDK next to this repo (as on the desktop:
`Desktop/plugin-open-platform-main`), or `MEMOMIND_SDK` set to its folder:

```sh
node memomind/get-sdk.mjs          # once: copies the SDK's web SDK and Opus decoder in
cd memomind/edith && npm install && npm run pack
cd ../tickets && npm install && npm run pack
cd .. && node --test --experimental-strip-types tests/*.test.ts
```

The packages land in `memomind/release/`.

## Try it

1. **Desktop Studio** (`Studio/windows/gm-plugin-studio-desktop.exe` in the
   SDK): import the `.mmpkg`, pair it with the Web Bridge glasses plugin, and
   use the on-screen glasses button and head-gesture controls. Turn on **Demo
   mode** in the app's phone page to see made-up data (Studio has no glasses
   mic; demo mode fakes what was heard).
2. **On the glasses**: Studio shows a QR code for the MemoMind phone app's
   developer install. The MemoMind app only installs your own plugins in its
   **Debug / developer build**; ordinary release builds don't sideload yet.
3. In the app's phone page, enter the EDITH password (the
   `ALEXA_SHARED_SECRET`) or the Work Tickets password (`TICKETS_SECRET`) and
   Save.

Things only the real glasses can confirm: text size (Studio guesses 17px
text; adjust `LINE` / `CHAR` in `common/screen.ts`), how reliable head gestures
are for scrolling, and the mic.
