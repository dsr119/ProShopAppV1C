# Work Tickets on the Even G2

Your IU19 helpdesk (Lansweeper) tickets as a to-do list on the glasses, built
from the helpdesk emails in your work Outlook.

- **Home:** your open tickets, newest activity first, with the ones waiting on
  the other person at the bottom. Below them, new unassigned tickets from the
  last 3 days. Each row is `number title · requester · state`. Press one to
  open it. Double press exits.
- **A ticket:** who it's for, its state, and the newest note. Below it:
  **Check off** and **Reply**. Hold anywhere on it to reply by voice. Double
  press goes back.
- **Reply:** talk, then release (or press, if you picked Reply from the list).
  The glasses show what they heard: press to send, hold to say it again,
  double press to drop it. The reply goes to the helpdesk email, and Lansweeper
  adds it to the ticket.
- **Menu** (tap, then long press): Refresh, Undo check-off.

The list cleans itself up. A ticket leaves the list when Lansweeper emails that
it was closed, or when you check it off. If someone writes on a checked-off
ticket afterwards, it comes back.

## How it reads the emails

Every Lansweeper email has the ticket number in the subject (`[[TIC #1478]]`)
and one line saying what happened:

| Email says | On the list |
|---|---|
| `X opened ticket N under the type IT Support` (to the whole team) | Queue, for 3 days |
| `X updated ticket N. The state is currently set to In Progress` (to you, or you're cc'd) | Mine |
| `... set to Awaiting Reply` | Mine, at the bottom, marked "waiting" |
| `The state of ticket N was set to Closed` | Off the list |
| `Automatic reply: ...` | Ignored |

Unassigned tickets drop out of the queue after 3 days because the team gets no
email when a teammate picks one up.

Tested against 354 real helpdesk emails from Sep to Nov 2026: every one of the
348 ticket emails parsed, and the 6 out-of-office replies were skipped. Those
emails aren't in this repo (it's public); the tests use made-up ones in the same
format (`src/demo.ts`).

## How it fits together

```
glasses → phone (this app) → work-tickets (Supabase function) → Microsoft Graph: your helpdesk emails
                           ← trimmed emails; the app builds the list (src/tickets.ts)
reply: hold to talk → work-tickets: Deepgram turns it into words → you confirm → Graph replies to the email
```

The function stores only the Microsoft sign-in token and which tickets you
checked off (table `work_tickets_kv`). Email is never stored.

## One-time setup

### 1. Register the app with Microsoft (about 10 minutes)

At [entra.microsoft.com](https://entra.microsoft.com) with your work account:

1. **App registrations → New registration.** Name it `G2 Work Tickets`,
   "Accounts in this organizational directory only", no redirect URI. Register.
2. On its **Overview**, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
3. **Authentication → Advanced settings → Allow public client flows: Yes.** Save.
4. **API permissions → Add a permission → Microsoft Graph → Delegated:**
   `Mail.Read`, `Mail.Send`, `User.Read`, `offline_access`. If your tenant
   doesn't let users consent to apps themselves, click **Grant admin consent**
   (or ask whoever can).

The permissions are *delegated*: the app can only reach your own mailbox, and
only while your sign-in is valid.

### 2. Supabase

1. **SQL Editor:** run `migration/add_work_tickets.sql`.
2. **Edge Functions → Secrets:** add `TICKETS_SECRET` (make up a password),
   `MS_CLIENT_ID` and `MS_TENANT_ID` (from step 1). `DEEPGRAM_API_KEY` is
   already there for EDITH.
3. **Edge Functions → Deploy a new function** named `work-tickets`: paste the
   whole of `supabase/functions/work-tickets/index.ts`. In its settings, turn
   **off** "Enforce JWT verification" (the password header is the check, like
   EDITH's function).

### 3. On the phone

Open the app, type the `TICKETS_SECRET`, **Save**, then **Connect Outlook**.
It shows a code: open the link, enter the code, sign in with your work
account, then tap **Done**.

## Run it

```bash
cd g2-tickets
npm install
npm run dev
evenhub-simulator "http://localhost:5173/?demo"   # made-up tickets, no network needed
```

Install on the glasses the same way as Pro Shop (see `g2/README.md`):

```bash
npm run pack                     # builds tickets.ehpk
evenhub create tickets.ehpk --name "Work Tickets" --tagline "Helpdesk to-do"   # first time
evenhub upload tickets.ehpk -m "What changed"                                   # after that
```

## Tests

```bash
npm test                                   # parsing, the list, glasses text
cd .. && node --test tests/work-tickets.test.cjs   # the Supabase function
```
