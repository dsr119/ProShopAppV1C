# Shop voice bot

A spare laptop in the shop that takes work orders by voice, with no Amazon
account, skill name or lead-in words:

> "Hey Jarvis" *(beep)* "work order for Doug Smith to plug his 14 pound ball"
> → "Work order added for Doug Smith: Plug 14 lb ball."

> "Hey Jarvis" *(beep)* "create a work order" → "Who's it for, and what are we doing?"
> *(beep)* "Doug Smith" → "What are we doing for Doug Smith?" *(beep)* "resurface his ball"
> → "Work order added for Doug Smith: Resurface ball."

Say "never mind" at any point to stop without adding anything.

## How it works

```
laptop mic → wake word + speech-to-text (on the laptop)
           → alexa-work-order function (Supabase) → customer lookup, Claude, tickets table
           → reply spoken by the laptop
```

Listening never leaves the laptop: the wake word ([openWakeWord](https://github.com/dscripka/openWakeWord))
and speech-to-text ([faster-whisper](https://github.com/SYSTRAN/faster-whisper))
run on it. Only the typed-out words of a work order go to the same function the
Alexa skill uses, so the phone lookup, Claude and the ticket come out the same.
The laptop holds only the work order password, not a database key.

## Setup (Windows)

1. Install Python 3.12 from <https://www.python.org/downloads/>. On the first
   installer screen, tick **Add python.exe to PATH**.
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it,
   for example to `Documents\ProShopAppV1C`.
3. In the `voice` folder, copy `config.example.json` to `config.json` and open
   it in Notepad. Fill in `password` (the `ALEXA_SHARED_SECRET` from Supabase)
   and set `location` to `Valley` or `South Side`. Save.
4. Open **Command Prompt** in the `voice` folder (in File Explorer, type `cmd`
   in the address bar and press Enter) and run:
   ```
   py -m pip install -r requirements.txt
   py shop_voice.py --test
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

## Settings (`config.json`)

| Setting | What it does |
|---|---|
| `password` | The `ALEXA_SHARED_SECRET` from Supabase. |
| `location` | `Valley` or `South Side`; used unless the other one is said. |
| `wake_word` | `hey_jarvis` (default), `hey_mycroft` or `hey_rhasspy`. A custom one like "Hey Pro Shop" can be trained later. |
| `wake_threshold` | 0 to 1. Raise it (0.6, 0.7) if it wakes up on its own; lower it (0.4) if it misses you. |
| `whisper_model` | `base.en` (default). `small.en` hears better but is slower; `tiny.en` for a very old laptop. |
| `mic` | Leave `null` for the default mic. `py shop_voice.py --list-mics` lists them; put the number here. |
| `silence_seconds` | How long a pause ends your sentence. Raise to 1.5 if it cuts you off. |
| `max_seconds` | Longest single answer. |

The window prints what it heard (`Heard: ...`) and what it said, which is the
first place to look when a ticket comes out wrong.

**Noise:** a laptop's own mic works in a quiet room. Near the drill press, a
USB speakerphone (Jabra Speak, eMeet and the like) hears much better; plug it in
and pick it with `mic`.
