// Work Tickets on MemoMind glasses: your IU19 helpdesk tickets as a to-do
// list. The same app as the G2 one in g2-tickets/, with the same
// work-tickets function behind it; only the screen and controls are MemoMind's.
//
//   Home     your open tickets (newest activity first, waiting-on-them last),
//            then new unassigned ones from the last 3 days, then Refresh and
//            Undo check-off. Look up / down to move (turn left / right jumps
//            a page), tap to open.
//   Ticket   who, state and the newest note. Below: Check off, Reply. Look
//            up / down to pick, tap to do it. Hold to reply by voice.
//            Double tap goes back.
//   Reply    talk, then tap when done. The words show: tap to send, hold to
//            say it again, double tap to drop it. The reply goes to the
//            helpdesk email, so it lands on the ticket.
//
// The phone screen holds the password and the Connect Outlook button.
import { checkOff, connectCheck, connectStart, loadMail, sendReply, transcribe } from "../../../g2-tickets/src/api";
import { isDemo } from "../../../g2-tickets/src/demo";
import { buildTodo, detailText, openTodo, parseTicketEmail, rowLabel, type Ticket } from "../../../g2-tickets/src/tickets";
import { Glasses, H, W, type Box, type Input } from "../../common/glasses";
import { charsIn, clipLine, fitBox, linesIn, listText, step } from "../../common/screen";
import { Mic } from "../../common/voice";

const REFRESH_MS = 2 * 60_000;
const HEAD_H = 30;

type Page = "home" | "ticket" | "voice";
type VoiceStep = "listening" | "hearing" | "confirm" | "sending" | "sent" | "error";
type HomeRow = { label: string; ticket?: Ticket; action?: "refresh" | "undo" };

const glasses = new Glasses();
const mic = new Mic(glasses);

const app = {
  page: "home" as Page,
  started: false,
  password: "",
  me: "",
  tickets: [] as Ticket[],
  mine: [] as Ticket[],
  queue: [] as Ticket[],
  rows: [] as HomeRow[],
  sel: 0,                          // home list cursor
  action: 0,                       // ticket page: 0 Check off, 1 Reply
  open: null as Ticket | null,
  lastChecked: null as Ticket | null,
  status: "Loading…",
  // voice
  step: "listening" as VoiceStep,
  heard: "",
  message: "",
};

const hasPassword = () => !!app.password || isDemo();

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function homeRows(): HomeRow[] {
  const rows: HomeRow[] = app.mine.map((t) => ({ label: rowLabel(t), ticket: t }));
  if (app.queue.length) {
    rows.push({ label: `— New, unassigned (${app.queue.length}) —` });
    for (const t of app.queue) rows.push({ label: rowLabel(t), ticket: t });
  }
  if (!rows.length) rows.push({ label: hasPassword() ? "Nothing open. Nice." : "Set the password on your phone" });
  rows.push({ label: "↻ Refresh", action: "refresh" });
  if (app.lastChecked) rows.push({ label: `↶ Undo check-off #${app.lastChecked.id}`, action: "undo" });
  return rows;
}

function homeBoxes(): Box[] {
  app.rows = homeRows();
  app.sel = Math.min(app.sel, app.rows.length - 1);
  return [
    { id: 1, x: 0, y: 0, width: W, height: HEAD_H, text: clipLine(`MY TICKETS · ${app.mine.length} · ${app.status}`, charsIn(W)) },
    { id: 2, x: 0, y: HEAD_H, width: W, height: H - HEAD_H, text: listText(app.rows.map((r) => r.label), app.sel, W, H - HEAD_H) },
  ];
}

const ACTIONS = ["Check off", "Reply (or hold to talk)"];
const ACTIONS_H = 58;

function ticketBoxes(): Box[] {
  const t = app.open!;
  const top = H - ACTIONS_H;
  return [
    { id: 3, x: 0, y: 0, width: W, height: top - 4, text: fitBox(detailText(t), W, top - 4) },
    { id: 4, x: 0, y: top, width: W, height: ACTIONS_H, border: 1, radius: 6, text: listText(ACTIONS, app.action, W, ACTIONS_H) },
  ];
}

function voiceText(): string {
  const t = app.open!;
  const head = `Reply to #${t.id} ${t.title}\n\n`;
  const body = {
    listening: "● Listening… tap when done",
    hearing: "Hearing that…",
    confirm: `"${app.heard}"\n\nTap: send · Hold: say again · Double tap: drop it`,
    sending: `"${app.heard}"\n\nSending…`,
    sent: `"${app.heard}"\n\nSent. Tap to go back.`,
    error: `${app.message}\n\nTap: back · Hold: try again`,
  }[app.step];
  return fitBox(head + body, W, H, true);
}

function voiceBoxes(): Box[] {
  return [{ id: 5, x: 0, y: 0, width: W, height: H, text: voiceText() }];
}

async function show(page: Page) {
  if (page === "ticket" && app.page !== "ticket" && app.page !== "voice") app.action = 0;
  app.page = page;
  await glasses.page(page === "home" ? homeBoxes() : page === "ticket" ? ticketBoxes() : voiceBoxes());
}

async function refreshVoice() {
  if (app.page !== "voice") return show("voice");
  await glasses.update(voiceBoxes()[0]);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function rebuild(mails: Awaited<ReturnType<typeof loadMail>>) {
  app.me = mails.me;
  const events = mails.mails.map((m) => parseTicketEmail(m, app.me)).filter((e) => e !== null);
  app.tickets = buildTodo(events, mails.checked);
  ({ mine: app.mine, queue: app.queue } = openTodo(app.tickets, new Date()));
}

async function loadData(redraw = true) {
  if (!hasPassword()) { app.status = ""; if (redraw && app.page === "home") await show("home"); return; }
  try {
    rebuild(await loadMail(app.password));
    app.status = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (err) {
    app.status = "Offline";
    console.warn((err as Error).message);
    setPhoneNote((err as Error).message);
  }
  if (redraw && app.page === "home") await show("home");
}

async function checkOffOpen() {
  const t = app.open;
  if (!t) return;
  t.done = true;
  app.mine = app.mine.filter((x) => x !== t);
  app.queue = app.queue.filter((x) => x !== t);
  app.lastChecked = t;
  await show("home");
  try { await checkOff(app.password, t.id); } catch (err) { setPhoneNote(`Couldn't save the check-off: ${(err as Error).message}`); }
}

async function undoCheck() {
  const t = app.lastChecked;
  if (!t) return;
  app.lastChecked = null;
  try { await checkOff(app.password, t.id, true); } catch { /* the refresh shows the truth */ }
  await loadData();
}

// ---------------------------------------------------------------------------
// Voice reply: hold (or Reply) to start, tap when done
// ---------------------------------------------------------------------------

let fakeListening = false;   // demo mode in Studio, which has no glasses mic
const listeningNow = () => mic.on || fakeListening;

async function startListening() {
  if (listeningNow() || !app.open) return;
  if (!glasses.audio && !isDemo()) {
    app.step = "error";
    app.message = "The glasses mic isn't available. Check the glasses are connected and the app may use the mic.";
    return refreshVoice();
  }
  app.step = "listening";
  await refreshVoice();
  try {
    if (glasses.audio) await mic.start(() => { void stopListening(); });
    else fakeListening = true;
  } catch (err) {
    app.step = "error";
    app.message = `Couldn't open the mic: ${(err as Error).message}`;
    await refreshVoice();
  }
}

async function stopListening() {
  if (!listeningNow()) return;
  app.step = "hearing";
  await refreshVoice();
  try {
    let audio = "";
    if (fakeListening) { fakeListening = false; audio = "demo"; }
    else audio = await mic.stop();
    if (!audio) return show("ticket");   // a slip, not speech
    app.heard = await transcribe(app.password, audio);
    if (app.heard) app.step = "confirm";
    else { app.step = "error"; app.message = "I didn't catch that."; }
  } catch (err) {
    app.step = "error";
    app.message = `Couldn't hear that: ${(err as Error).message}`;
  }
  await refreshVoice();
}

async function send() {
  const t = app.open;
  if (!t?.replyTo) { app.step = "error"; app.message = "No email to reply to."; return refreshVoice(); }
  app.step = "sending";
  await refreshVoice();
  try {
    await sendReply(app.password, t.replyTo, app.heard);
    app.step = "sent";
  } catch (err) {
    app.step = "error";
    app.message = `Not sent: ${(err as Error).message}`;
  }
  await refreshVoice();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

async function onInput(i: Input) {
  if (listeningNow()) {
    if (i === "tap") return stopListening();
    if (i === "double") { mic.cancel(); fakeListening = false; return show("ticket"); }
    return;
  }

  if (app.page === "home") {
    const n = app.rows.length;
    const pageRows = Math.max(1, linesIn(H - HEAD_H) - 2);
    if (i === "up" || i === "down") { app.sel = step(app.sel, n, i === "down" ? 1 : -1); return glasses.update(homeBoxes()[1]); }
    if (i === "left" || i === "right") {
      app.sel = Math.min(n - 1, Math.max(0, app.sel + (i === "right" ? pageRows : -pageRows)));
      return glasses.update(homeBoxes()[1]);
    }
    if (i !== "tap" && i !== "nod") return;
    const row = app.rows[app.sel];
    if (row?.ticket) { app.open = row.ticket; return show("ticket"); }
    if (row?.action === "refresh") { app.status = "Loading…"; await glasses.update(homeBoxes()[0]); return loadData(); }
    if (row?.action === "undo") return undoCheck();
    return;
  }

  if (app.page === "ticket") {
    if (i === "hold") { await show("voice"); return startListening(); }
    if (i === "double" || i === "shake") return show("home");
    if (i === "up" || i === "down") { app.action = step(app.action, ACTIONS.length, i === "down" ? 1 : -1); return glasses.update(ticketBoxes()[1]); }
    if (i !== "tap" && i !== "nod") return;
    if (app.action === 0) return checkOffOpen();
    await show("voice");
    return startListening();
  }

  // The voice page.
  if (app.step === "hearing" || app.step === "sending") return;
  if (i === "hold") return startListening();
  if (app.step === "confirm") {
    if (i === "tap" || i === "nod") return send();
    if (i === "double" || i === "shake") return show("ticket");
    return;
  }
  if (i === "tap" || i === "double") return show("ticket");
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue(i: Input) {
  queue = queue.then(() => onInput(i)).catch((err) => console.error(err));
}

// ---------------------------------------------------------------------------
// Phone screen: password, Outlook sign-in, demo mode
// ---------------------------------------------------------------------------

function setPhoneNote(msg: string) {
  const note = document.querySelector<HTMLElement>("#note");
  if (note) note.textContent = msg;
}

function setDemo(on: boolean) {
  const url = new URL(location.href);
  if (on) url.searchParams.set("demo", "");
  else url.searchParams.delete("demo");
  history.replaceState(null, "", url.toString().replace("demo=", "demo"));
}

function wirePhone() {
  const pw = document.querySelector<HTMLInputElement>("#password");
  document.querySelector<HTMLFormElement>("#settings")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    app.password = (pw?.value || "").trim();
    const demo = !!document.querySelector<HTMLInputElement>("#demo")?.checked;
    setDemo(demo);
    await glasses.set("password", app.password);
    await glasses.set("demo", demo ? "1" : "");
    if (!app.started) { setPhoneNote("Saved."); return; }
    setPhoneNote("Saved. Loading your tickets…");
    await loadData();
    if (app.status !== "Offline") setPhoneNote("Saved. The glasses are updated.");
  });
  document.querySelector<HTMLButtonElement>("#connect")?.addEventListener("click", async () => {
    try {
      const out = await connectStart(app.password);
      const box = document.querySelector<HTMLElement>("#code");
      if (box) {
        box.textContent = "";
        const a = document.createElement("a");
        a.href = out.url; a.textContent = out.url; a.target = "_blank"; a.rel = "noopener";
        const b = document.createElement("b"); b.textContent = out.code;
        box.append("Open ", a, " and enter ", b, ", sign in with your work account, then tap Done.");
      }
      document.querySelector<HTMLElement>("#done")!.hidden = false;
    } catch (err) { setPhoneNote((err as Error).message); }
  });
  document.querySelector<HTMLButtonElement>("#done")?.addEventListener("click", async () => {
    try {
      const out = await connectCheck(app.password);
      setPhoneNote(out.say);
      if (out.connected) await loadData();
    } catch (err) { setPhoneNote((err as Error).message); }
  });
}

async function main() {
  wirePhone();
  setPhoneNote("Connecting to the MemoMind app…");
  await glasses.start({
    onInput: enqueue,
    onRedraw: () => { void glasses.redraw().catch(() => {}); },
    onPause: () => { mic.cancel(); fakeListening = false; },
  });
  app.password = await glasses.get("password");
  if ((await glasses.get("demo")) === "1") setDemo(true);
  const pw = document.querySelector<HTMLInputElement>("#password");
  if (pw) pw.value = app.password;
  const demo = document.querySelector<HTMLInputElement>("#demo");
  if (demo) demo.checked = isDemo();
  setPhoneNote(glasses.audio ? "Connected. Glasses mic ready." : "Connected. No glasses mic here (Studio has none).");
  try { await glasses.gm.display.createPage(); } catch { /* some hosts create it on the first rebuild */ }
  await show("home");
  app.started = true;
  await loadData();
  setInterval(() => { if (app.page === "home" && !listeningNow()) void loadData(); }, REFRESH_MS);
}

main().catch((err) => {
  console.error("Work Tickets failed to start:", err);
  setPhoneNote(`Couldn't start: ${(err as Error).message}`);
});
