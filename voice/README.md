# Shop voice bot

A spare laptop in the shop that takes work orders and makes draft Square
invoices by voice. Claude runs the conversation, so you talk to it like a
coworker rather than a menu:

> "Hey Jarvis" *(beep)* "work order for Doug Smith to plug his 14 pound ball"
> → "Work order added for Doug Smith: plug his 14 pound ball."

> "Hey Jarvis, create an invoice for Doug Smith" → "I found two Doug Smiths.
> What are the last four of the phone?" → "8 1 0" → "I only caught 8 1 0.
> What are all four digits?" → "8210" → "Got it. What's on the invoice?" →
> "an Exponent solid" → "I don't see an Exponent Solid. Did you mean the Game
> Breaker 5 Solid?"

Say "never mind" at any point to stop without adding anything.

**Changing work orders:** "change Joe DeGrazia's to a bake and resurface",
"mark the Special Effect done but not picked up", "put a note on John Doe's".
It finds the work order by customer or ball and changes only what you said
(title, customer and phone, status, due date, priority, a note). It can't
delete; do that in the app.

**Ball names:** every ball mentioned is checked against the ball catalog (the
`balls` table the website's scraper keeps current), so "fays 6" becomes
*Storm Phaze 6* and an unknown ball is noted for review. When the laptop
starts, it also fetches the newest ball names as listening hints for
speech-to-text.

**Follow-ups:** saying the wake word again within 5 minutes carries on the
same conversation, so "change that one" works right after adding it.

## How it works

```
laptop mic → wake word + speech-to-text (on the laptop)
           → alexa-work-order function (Supabase) → customer lookup, Claude, tickets table
           → reply spoken by the laptop
```

Listening never leaves the laptop: the wake word ([openWakeWord](https://github.com/dscripka/openWakeWord))
and speech-to-text ([faster-whisper](https://github.com/SYSTRAN/faster-whisper))
run on it. Only the typed-out words go to the Supabase function, which runs
the conversation and is the only part that holds the database and Square
keys: it reads customer names and phones, adds tickets and review notes, and
makes draft invoices, nothing else. The laptop holds only the work order
password.

The function is still called `alexa-work-order` and its password
`ALEXA_SHARED_SECRET` (it first served an Alexa skill); renaming them would
mean redeploying it and changing the laptop's settings for no gain.

**Claude** (Haiku, for speed) decides what to say and what to ask. It acts
only through a few tools the function gives it: look up a customer, search the
Square item library, make a draft invoice, add a work order, and note
something for review. It never makes up customers, phones, items or prices,
and it can't send an invoice. "For doug smith to plug his fourteen pound ball
before thursday league" becomes title *Plug 14 lb ball*, priority High, due
Thursday's date. Without an Anthropic key, or if Claude fails on the first
thing said, simple rules take the work order instead. A conversation costs
about a cent or less.

**Phone lookup:** the name is searched in the customer directory, orders,
appointments and Speccy's spec sheets, by pieces of the last name so a
misheard spelling still finds it: "Doug" finds "Douglas Smith", "Joe De
Grazia" finds "Joe DeGrazia", and "John Yablonsky" gets "Did you mean John
Jablonski?" If several customers match, it asks for the last four digits of
the phone. If nobody's close, a work order is made without a phone. An
invoice needs the phone to find the customer in Square, so a name found
nowhere gets "What's their phone number?" If Speccy can't be read (it has to
be in open-link mode, or see below), that's noted in the review list.

## Square invoices

> "Hey Jarvis, create an invoice for Doug Smith for a 14 pound Motiv Tag, a
> standard drill and a slug combo" → "Draft invoice in Square for Doug Smith:
> Motiv Tag 14 lb, Standard Drill, Slug Combo, $289.95."

> "Hey Jarvis, create Bill Jones as a new customer and an invoice for a Motiv
> Tag" → Bill's name and phone come from his latest Speccy spec sheet, he's
> added to Square, and the invoice is made.

- Invoices are always **drafts**: check and send them from Square (Invoices).
- The customer is found in Square by phone number (looked up from the customer
  list and Speccy). If they aren't in Square, it asks whether to add them as
  a new customer.
- Items: Square is searched for each word said, and Claude picks the item
  that's clearly what you meant ("IAMX Pearl" → *Storm I Am X Pearl*). When
  the closest one is something else it asks before using it. A ball's weight
  picks the variation; if you didn't say one, it asks.
- **Shop words:** the `voice_aliases` table maps what you say to the item's real
  name in Square, e.g. `standard drill` → `Fit & Drill New Ball Purchased at Perfexxxxion Pro Shop`. Run
  `migration/add_voice_aliases.sql` once in the SQL Editor, then
  `migration/voice_aliases_common_items.sql` (the shop's common items: drills,
  grips, Jopo and Turbo, slug combo), then add or edit rows in
  **Table Editor → voice_aliases**. "Pair of grips" on its own is the $5 grips
  with a drill of a ball bought here and the $10 grips with an outside drill.
- Speccy is read with its public key, which works while Speccy is in open-link
  mode. If Speccy is locked to signed-in staff, add secrets `SPECCY_URL` and
  `SPECCY_KEY` (Speccy's secret key) to this function.

### Connecting Square

1. Go to <https://developer.squareup.com/apps>, sign in with the shop's Square
   account, and click **Create an app** (name it "Shop voice").
2. Open the app, switch the toggle at the top to **Production**, go to
   **Credentials**, and copy the **Production Access token**. It gives full
   access to the Square account, so put it only into Supabase.
3. Supabase → **Edge Functions → Secrets**: add `SQUARE_ACCESS_TOKEN` with that
   token. Then open `alexa-work-order` and **Deploy** again.

## Appointments and orders

- "What does our Tuesday this week look like?" reads that day's shop hours and appointments.
- "Is there any availability this week for a conventional drill?" lists open times from the
  Shop Hours page minus booked appointments. Each appointment is counted as 30 minutes, since the
  app doesn't store how long one takes.
- "Make an appointment Monday at 6:30 for Joe Sutton, a drill" books it in the app (at this
  laptop's location unless you say the other one). If the time clashes with another booking, is
  outside shop hours, or the shop shows closed, it asks before booking anyway.
- "What's the status on Jim Curtis's shoes?" reads the order book: ordered, arrived, drilled,
  contacted, paid, picked up.

Customer names are looked up in both the app's customers and Speccy.

## Review list

Anything it didn't understand or had to guess is saved in **Table Editor →
voice_review**: Claude notes what it couldn't make out or had to guess, and
Square errors, AI failures and conversations that went nowhere are noted too. Each row
has what was heard and what it answered; tick `reviewed` when done. Recurring
item mix-ups are best fixed with a `voice_aliases` row. Run
`migration/add_voice_review.sql` once to create the table.

## The Supabase function (already set up)

To set it up again or change it:

1. Supabase dashboard → **Edge Functions** → `alexa-work-order` → **Code**:
   paste the whole of `supabase/functions/alexa-work-order/index.ts`, **Deploy**.
2. Function **Settings**: "Enforce JWT verification" stays **off**.
3. **Edge Functions → Secrets**: `ALEXA_SHARED_SECRET` (the password, letters
   and numbers only) and `ANTHROPIC_API_KEY` (from <https://console.anthropic.com>).
4. **Deploy again** after changing a secret, so the function picks it up.

## Setup (Windows)

1. Install Python **3.12** (the speech parts don't support newer versions
   yet): <https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe>.
   On the first installer screen, tick **Add python.exe to PATH**. Also install
   Microsoft's Visual C++ Redistributable (<https://aka.ms/vs/17/release/vc_redist.x64.exe>);
   without it the program stops with "DLL load failed".
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it,
   for example to `Documents\ProShopAppV1C`.
3. In the `voice` folder, copy `config.example.json` to `config.json` and open
   it in Notepad. Fill in `password` (the `ALEXA_SHARED_SECRET` from Supabase)
   and set `location` to `Valley` or `South Side`. Save.
4. Open **Command Prompt** in the `voice` folder (in File Explorer, type `cmd`
   in the address bar and press Enter) and run:
   ```
   py -3.12 -m pip install -r requirements.txt
   py -3.12 shop_voice.py --test
   ```
   `--test` should print **Connected.** It doesn't add a ticket.
5. Double-click `start-windows.bat`. The first start downloads the speech
   models (a few minutes); then it says **Ready**.

On a Mac it's the same, using **Terminal**, `python3 -m pip install -r requirements.txt`,
`python3 shop_voice.py --test`, and `start-mac.command` (Mac asks to allow the
microphone the first time).

**Keep it running:** set the laptop to never sleep when plugged in (Windows:
Settings → System → Power). To start it with Windows, press Win+R, type
`shell:startup`, and put a shortcut to `start-windows.bat` in that folder.
To run it with the lid closed (with an external mic), set Start → "Change
what closing the lid does" → Plugged in → **Do nothing**.

## Leaving it running

It's fine to leave it on for days.

- `start-windows.bat` starts it again by itself if it ever crashes. Ctrl+C quits.
- If the mic is unplugged or stops sending sound, it keeps trying until the mic is back.
- It fetches the newest ball names again once a day.
- In Windows, set the laptop to **never sleep while plugged in**: Settings > System >
  Power & sleep. A sleeping laptop can't hear the wake word.
- To start it when Windows starts, press Win+R, type `shell:startup`, and put a
  shortcut to `start-windows.bat` in that folder.

## Settings (`config.json`)

| Setting | What it does |
|---|---|
| `password` | The `ALEXA_SHARED_SECRET` from Supabase. |
| `location` | `Valley` or `South Side`; used unless the other one is said. |
| `wake_word` | `hey_jarvis` (default), `alexa`, `hey_mycroft` or `hey_rhasspy`. A custom one like "Hey Pro Shop" can be trained later. |
| `model` | The AI: `haiku` (default, quickest), `sonnet` (smarter, a few seconds slower), `opus` (smartest, slowest, costs about 5x Haiku). |
| `voice_engine` | `piper` (default): the voice below, quick and runs on the laptop. `edge`: Microsoft's free online voices, more human-sounding but a few seconds slower to start talking (the log's `Says (5.5s)`). If the online voice fails, it falls back to Piper. |
| `edge_voice` | `en-US-AndrewNeural` (default, male), `en-US-BrianNeural` (male), `en-US-AvaNeural` (female), `en-US-EmmaNeural` (female), `en-US-GuyNeural`, `en-US-JennyNeural`. |
| `voice` | The Piper (backup) voice: `en_US-lessac-medium` (default), `en_US-ryan-medium` (male), `en_US-amy-medium`; downloaded on first use. Add `-low` instead of `-medium` for a faster, rougher voice; `""` uses the computer's built-in voice. |
| `wake_threshold` | 0 to 1. Raise it (0.6, 0.7) if it wakes up on its own; lower it (0.4) if it misses you. |
| `whisper_model` | `base.en` (default). `small.en` hears better but is slower; `tiny.en` for a very old laptop. |
| `mic` | Leave `null` for the default mic. `py -3.12 shop_voice.py --list-mics` lists them; put the number here. |
| `silence_seconds` | How long a pause ends your sentence. Raise to 1.5 if it cuts you off. |
| `max_seconds` | Longest single answer. |

`py -3.12 shop_voice.py --mic-check` shows the mic level and the wake word
score for 20 seconds; speech should reach at least 120.

The window prints what it heard (`Heard: ...`) and what it said, which is the
first place to look when a ticket comes out wrong.

**Noise:** a laptop's own mic works in a quiet room. Near the drill press, a
USB speakerphone (Jabra Speak, eMeet and the like) hears much better; plug it in
and pick it with `mic`.
