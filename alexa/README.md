# Alexa work orders

Say this to the shop Echo:

> "Alexa, tell Pro Shop to create a work order for the ball return on lane 3 is jammed."

and a ticket appears in the **To review** tab of `tickets.html`, submitted by
**Alexa**, status New, priority Normal. Alexa reads back what she heard, so a
mishearing can be fixed on the Tickets page. Saying "Valley" or "South Side"
in the sentence sets the location.

Amazon only runs a custom skill when you say its name, so the "tell Pro Shop
to" part can't be dropped. If you open it without a request ("Alexa, open Pro
Shop"), she asks "What's the work order for?" Answer starting with "it's
for...", e.g. "it's for the drill press needs a new bit".

## How it fits together

```
Echo  ->  Pro Shop skill (alexa/skill.js, hosted free by Amazon)
      ->  alexa-work-order function (supabase/functions/alexa-work-order, on Supabase)
      ->  tickets table
```

The skill only knows a password. The Supabase function checks it and is the
only part that holds a database key, and all it can do is add a ticket.

## Setup (about 20 minutes, all free)

### 1. Supabase function

1. In the Supabase dashboard for the ProShop project, open **Edge Functions**
   and choose **Deploy a new function → Via Editor**.
2. Name it exactly `alexa-work-order`, replace the sample code with the whole of
   `supabase/functions/alexa-work-order/index.ts`, and click **Deploy**.
3. Open the function's **Details** (settings) and turn **off** "Enforce JWT
   verification" (Alexa has no Supabase login, the password is the check). Save.
4. Go to **Edge Functions → Secrets**, add a secret named
   `ALEXA_SHARED_SECRET`, and set it to a long random password (30+ letters
   and numbers). Keep it handy for step 2.4.

### 2. Alexa skill

1. Go to <https://developer.amazon.com/alexa/console/ask> and sign in with the
   **same Amazon account the shop Echo is registered to**. Accept the free
   developer agreement if asked.
2. **Create Skill**: name `Pro Shop`, language English (US), type **Custom**
   (sometimes shown as "Other" → Custom), hosting **Alexa-hosted (Node.js)**,
   template **Start from Scratch**. It takes a minute to set up.
3. **Build** tab → **Interaction Model → JSON Editor**. Replace everything with
   `alexa/interaction-model.json`, click **Save**, then **Build skill**.
4. **Code** tab → open `lambda/index.js`, replace everything with
   `alexa/skill.js`. At the top, paste the password from step 1.4 into
   `SHARED_SECRET`, and set `DEFAULT_LOCATION` to the Echo's building
   (`"Valley"` or `"South Side"`). Click **Save**, then **Deploy**.
5. **Test** tab → set "Skill testing is enabled in" to **Development**. Type
   `tell pro shop to create a work order for test from the computer`. You
   should hear "Done" and see the ticket on the Tickets page.

The skill stays in Development and is never published: it works on every Echo
signed in to that Amazon account and nobody else's. No certification needed.

### 3. Optional: a shorter phrase

In the Alexa phone app: **More → Routines → +**. Set "When this happens" to
**Voice** with `new work order`, add the action **Skills → Your Skills → Pro
Shop**, and save. Then "Alexa, new work order" opens the skill and she asks
what it's for.

## If it doesn't work

- Alexa says "Sorry, I couldn't add that work order": the password doesn't
  match, or JWT verification is still on. The skill's **Code → CloudWatch
  Logs** shows the exact reply from Supabase.
- Alexa says she doesn't know that skill: check the Echo uses the same Amazon
  account as the developer console, and the Test tab says Development.
