# Voice work orders

A work order is three things: **who it's for**, their **phone number**
(looked up for you), and **what we're doing**. Say it all at once:

> "Hey Siri, work order" → "Who's it for, and what are we doing?" →
> "Doug Smith, plug his 14 pound ball" → "Work order added for Doug Smith: Plug 14 lb ball."

or one piece at a time:

> "Doug Smith" → "What are we doing for Doug Smith?" → "plug his 14 pound ball"
> → "Work order added for Doug Smith: Plug 14 lb ball."

The ticket lands in the **To review** tab of `tickets.html`, submitted by
**Alexa**, with the customer's name and phone at the top of the details (the
same format the ticket page uses), category Customer, and the exact words
spoken at the bottom as `Said: "..."`. Shop jobs work too: "the ball return
on lane 3 is jammed" needs no customer.

**Phone lookup:** the name is searched in the customer directory, orders and
appointments. "Doug" finds "Douglas Smith". If two different numbers match,
the phone is left blank and you're told to add it in the app.

**Claude (optional, recommended):** with an Anthropic API key, Claude reads
each answer, so "for doug smith to plug his fourteen pound ball before
thursday league" becomes title *Plug 14 lb ball*, priority High, due Thursday's
date. Without a key, simple rules do it ("for NAME to WORK", or the answer to
the question just asked) and the words become the title.

## How it fits together

```
Siri Shortcut  ─┐
                ├─> alexa-work-order function (Supabase) ─> customer lookup, Claude, tickets table
Alexa skill    ─┘
```

The function runs the conversation and is the only part that holds a database
key: it reads customer names and phones and adds tickets, nothing else. The
callers only know a password, and pass back a `state` value between turns.

## 1. Supabase function (needed for either voice route)

1. Supabase dashboard → **Edge Functions → Deploy a new function → Via Editor**
   (or open the existing `alexa-work-order` → **Code**).
2. Name it exactly `alexa-work-order`, paste the whole of
   `supabase/functions/alexa-work-order/index.ts`, and click **Deploy**.
3. Function **Settings**: turn **off** "Enforce JWT verification". Save.
4. **Edge Functions → Secrets**:
   - `ALEXA_SHARED_SECRET`: a password, letters and numbers only.
   - `ANTHROPIC_API_KEY` (optional): from <https://console.anthropic.com>
     (**API Keys**; add a few dollars under **Billing**). Each work order
     costs about 1 to 3 cents.
5. **Deploy again** after adding or changing a secret, so the running function
   picks it up.

If Claude is slow (over 5 seconds) or unavailable, the rules take over and the
work order is still added.

## 2a. Siri Shortcut (works on iPhone, iPad, HomePod; works with Alexa+)

In the **Shortcuts** app, tap **+**, name it **Work order**, and add:

1. **Text** (leave empty) → **Set Variable** `Said`
2. **Text** (leave empty) → **Set Variable** `State`
3. **Repeat** 5 times, and inside it:
   1. **Get Contents of URL**:
      `https://ngghyuvykqqklztvvmld.supabase.co/functions/v1/alexa-work-order`
      → Show More → Method **POST**; Headers: `x-alexa-secret` = your password;
      Request Body **JSON**: `text` = `Said`, `state` = `State`,
      `location` = `Valley` (or `South Side`)
   2. **Get Dictionary Value** `say` in *Contents of URL* → **Set Variable** `Say`
   3. **Get Dictionary Value** `state` in *Contents of URL* → **Set Variable** `State`
   4. **If** `State` *has any value*:
      - **Ask for Input** (Text), prompt = `Say` → **Set Variable** `Said` = *Provided Input*
   5. **Otherwise**:
      - **Speak Text** `Say`
      - **Stop This Shortcut**
   6. **End If**
4. (after the Repeat) **Speak Text** `Say`

"Hey Siri, work order" runs it. On a HomePod, turn on Personal Requests.
If something's wrong, run it by tapping it: the reply from step 3.1 shows the
error (for example `Wrong password (got 18 characters, expected 20)`).

## 2b. Alexa skill (Echo on the original Alexa only)

Alexa+ does not run unpublished skills (Amazon limits Alexa+ add-ons to select
partners), so this route needs an Echo that isn't on Alexa+.

> "Alexa, ask Shop Tickets to create a work order for Doug Smith to plug his 14 pound ball."
> "Alexa, ask Shop Tickets to create a work order for Doug Smith." → "What are we doing for Doug Smith?"

1. <https://developer.amazon.com/alexa/console/ask>, signed in with the Echo's
   Amazon account. **Create Skill**: name `Shop Tickets`, English (US),
   **Custom**, **Alexa-hosted (Node.js)**, **Start from Scratch**.
2. **Build → Interaction Model → JSON Editor**: paste
   `alexa/interaction-model.json`, **Save**, **Build skill**.
3. **Code** → `lambda/index.js`: paste `alexa/skill.js`, fill in
   `SHARED_SECRET` and `DEFAULT_LOCATION` (`"Valley"` or `"South Side"`),
   **Save**, **Deploy**.
4. **Test** tab → **Development**. The **Manual JSON** tab can call the skill
   directly when typed requests don't reach it.

When Alexa asks a follow-up, start the answer with "for" or "it's", e.g.
"for Doug Smith" or "it's plug his ball".
