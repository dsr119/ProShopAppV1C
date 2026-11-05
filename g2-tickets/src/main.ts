// Work Tickets on the Even G2: your IU19 helpdesk tickets as a to-do list.
//
//   Home     your open tickets (newest activity first, waiting-on-them last),
//            then new unassigned ones from the last 3 days. Press one to open it.
//            Double press exits.
//   Ticket   who, state and the newest note. Below: Check off, Reply.
//            Hold anywhere on it to reply by voice. Double press goes back.
//   Reply    talk, then press (or release, if holding). The words show:
//            press to send, hold to say it again, double press to drop it.
//            The reply goes to the helpdesk email, so it lands on the ticket.
//   Menu     (tap, then long press) Refresh, Undo check-off.
//
// The phone screen holds the password and the Connect Outlook button.
import {
  AudioInputSource,
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { checkOff, connectCheck, connectStart, loadMail, sendReply, transcribe } from "./api";
import { isDemo } from "./demo";
import { buildTodo, clip, detailText, fitPage, openTodo, parseTicketEmail, rowLabel, toBase64, type Ticket } from "./tickets";

const W = 576, H = 288;
const MAX_AUDIO_BYTES = 30 * 32000;
const MAX_ROWS = 20;               // the firmware's list limit
const REFRESH_MS = 2 * 60000;

type Page = "home" | "ticket" | "voice";
type VoiceStep = "listening" | "hearing" | "confirm" | "sending" | "sent" | "error";

const app = {
  bridge: null as EvenAppBridge | null,
  page: "home" as Page,
  password: "",
  me: "",
  tickets: [] as Ticket[],
  mine: [] as Ticket[],
  queue: [] as Ticket[],
  rows: [] as (Ticket | null)[],   // what each home list row opens
  open: null as Ticket | null,     // the ticket on screen
  lastChecked: null as Ticket | null,
  status: "Loading…",
  // voice
  step: "listening" as VoiceStep,
  recording: false,
  holdToTalk: true,
  chunks: [] as Uint8Array[],
  bytes: 0,
  heard: "",
  message: "",
};

const hasPassword = () => !!app.password || isDemo();

const menu = () => ({ menuItems: [{ itemName: "Refresh", itemID: 1 }, { itemName: "Undo check-off", itemID: 2 }] });

function text(id: number, name: string, y: number, h: number, content: string, capture = 0, extra = {}) {
  return { xPosition: 0, yPosition: y, width: W, height: h, containerID: id, containerName: name, content, isEventCapture: capture, paddingLength: 4, ...extra };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function homeRows(): { labels: string[]; rows: (Ticket | null)[] } {
  const labels: string[] = [];
  const rows: (Ticket | null)[] = [];
  for (const t of app.mine) { labels.push(rowLabel(t)); rows.push(t); }
  if (app.queue.length) {
    labels.push(clip(`— New, unassigned (${app.queue.length}) —`));
    rows.push(null);
    for (const t of app.queue) { labels.push(rowLabel(t)); rows.push(t); }
  }
  if (!labels.length) { labels.push(hasPassword() ? "Nothing open. Nice." : "Set the password on your phone"); rows.push(null); }
  return { labels: labels.slice(0, MAX_ROWS), rows: rows.slice(0, MAX_ROWS) };
}

function homePage() {
  const { labels, rows } = homeRows();
  app.rows = rows;
  const title = `MY TICKETS · ${app.mine.length}   ${app.status}`;
  return {
    containerTotalNum: 2,
    textObject: [text(1, "title", 0, 32, title, 0, { textColor: 3 })],
    listObject: [{
      xPosition: 0, yPosition: 32, width: W, height: H - 32,
      containerID: 2, containerName: "list", isEventCapture: 1,
      itemContainer: { itemCount: labels.length, itemName: labels, isItemSelectBorderEn: 1 },
    }],
    menuObject: menu(),
  };
}

// Two actions, so the note keeps most of the screen. Double press goes back.
const ACTIONS = ["Check off", "Reply (or hold to talk)"];

function ticketPage() {
  const t = app.open!;
  return {
    containerTotalNum: 2,
    textObject: [text(3, "detail", 0, 200, detailText(t))],
    listObject: [{
      xPosition: 0, yPosition: 202, width: W, height: H - 202,
      containerID: 4, containerName: "actions", isEventCapture: 1,
      itemContainer: { itemCount: ACTIONS.length, itemName: ACTIONS, isItemSelectBorderEn: 1 },
    }],
    menuObject: menu(),
  };
}

function voiceText(): string {
  const t = app.open!;
  const head = `Reply to #${t.id} ${t.title}\n\n`;
  const body = {
    listening: app.holdToTalk ? "● Listening… release when done" : "● Listening… press when done",
    hearing: "Hearing that…",
    confirm: `"${app.heard}"\n\nPress: send · Hold: say again · Double: drop it`,
    sending: `"${app.heard}"\n\nSending…`,
    sent: `"${app.heard}"\n\nSent. Press to go back.`,
    error: `${app.message}\n\nPress: back · Hold: try again`,
  }[app.step];
  return fitPage(head + body);
}

function voicePage() {
  return { containerTotalNum: 1, textObject: [text(5, "voice", 0, H, voiceText(), 1)], menuObject: menu() };
}

async function show(page: Page) {
  if (!app.bridge) return;
  app.page = page;
  const layout = page === "home" ? homePage() : page === "ticket" ? ticketPage() : voicePage();
  await app.bridge.rebuildPageContainer(layout as never);
}

async function refreshVoice() {
  if (!app.bridge) return;
  if (app.page !== "voice") return show("voice");
  await app.bridge.textContainerUpgrade({ containerID: 5, containerName: "voice", content: voiceText() } as never);
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
// Voice reply
// ---------------------------------------------------------------------------

async function startRecording(holdToTalk: boolean) {
  if (!app.bridge || app.recording || !app.open) return;
  app.recording = true;
  app.holdToTalk = holdToTalk;
  app.chunks = [];
  app.bytes = 0;
  app.step = "listening";
  await refreshVoice();
  await app.bridge.audioControl(true, AudioInputSource.Glasses);
}

async function stopRecording() {
  if (!app.bridge || !app.recording) return;
  app.recording = false;
  await app.bridge.audioControl(false);
  if (app.bytes < 8000 && !isDemo()) return show("ticket");   // a slip, not speech
  app.step = "hearing";
  await refreshVoice();
  try {
    app.heard = await transcribe(app.password, toBase64(app.chunks));
    if (app.heard) app.step = "confirm";
    else { app.step = "error"; app.message = "I didn't catch that."; }
  } catch (err) {
    app.step = "error";
    app.message = `Couldn't hear that: ${(err as Error).message}`;
  }
  app.chunks = [];
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

function onAudio(pcm: Uint8Array) {
  if (!app.recording) return;
  app.chunks.push(pcm);
  app.bytes += pcm.length;
  if (app.bytes >= MAX_AUDIO_BYTES) stopRecording();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

type Gesture = "press" | "double" | "hold" | "release" | null;

function gestureOf(ev: EvenHubEvent): Gesture {
  const inner = ev.listEvent || ev.textEvent;
  const type = inner ? inner.eventType : ev.sysEvent?.eventType;
  if (type === OsEventTypeList.LONG_PRESS_EVENT) return "hold";
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return "release";
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return "double";
  // A press often arrives with no type at all (0 dropped in transit).
  if (type === OsEventTypeList.CLICK_EVENT) return "press";
  if (type === undefined && (inner || (ev.sysEvent && !ev.sysEvent.imuData))) return "press";
  return null;
}

async function onEvent(ev: EvenHubEvent) {
  if (ev.audioEvent) return onAudio(ev.audioEvent.audioPcm);
  if (ev.menuItemClickEvent?.itemID === 1) return loadData();
  if (ev.menuItemClickEvent?.itemID === 2) return undoCheck();
  const g = gestureOf(ev);
  if (!g) return;

  if (app.page === "home") {
    if (g === "double") return app.bridge?.shutDownPageContainer(1);
    if (g !== "press") return;
    const t = app.rows[ev.listEvent?.currentSelectItemIndex ?? 0];
    if (t) { app.open = t; return show("ticket"); }
    return;
  }

  if (app.page === "ticket") {
    if (g === "hold") { await show("voice"); return startRecording(true); }
    if (g === "double") return show("home");
    if (g !== "press") return;
    const i = ev.listEvent?.currentSelectItemIndex ?? 0;
    if (i === 0) return checkOffOpen();
    await show("voice");
    return startRecording(false);
  }

  // Voice page.
  if (g === "release") return app.holdToTalk ? stopRecording() : undefined;
  if (app.recording) return g === "press" ? stopRecording() : undefined;
  if (app.step === "hearing" || app.step === "sending") return;
  if (g === "hold") return startRecording(true);
  if (app.step === "confirm") {
    if (g === "press") return send();
    if (g === "double") return show("ticket");
    return;
  }
  if (g === "press" || g === "double") return show("ticket");
}

// ---------------------------------------------------------------------------
// Phone screen: password and Outlook sign-in
// ---------------------------------------------------------------------------

function setPhoneNote(msg: string) {
  const note = document.querySelector<HTMLElement>("#note");
  if (note) note.textContent = msg;
}

function wirePhone() {
  const pw = document.querySelector<HTMLInputElement>("#password");
  document.querySelector<HTMLFormElement>("#settings")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    app.password = (pw?.value || "").trim();
    await app.bridge?.setLocalStorage("password", app.password);
    setPhoneNote("Saved. Loading your tickets…");
    await loadData();
    if (app.status !== "Offline") setPhoneNote("Saved. The glasses are updated.");
  });
  document.querySelector<HTMLButtonElement>("#connect")?.addEventListener("click", async () => {
    try {
      const out = await connectStart(app.password);
      const box = document.querySelector<HTMLElement>("#code");
      if (box) box.innerHTML = `Open <a href="${out.url}">${out.url}</a> and enter <b>${out.code}</b>, sign in with your work account, then tap Done.`;
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
  const bridge = await waitForEvenAppBridge();
  app.bridge = bridge;
  app.password = (await bridge.getLocalStorage("password")) || "";
  const pw = document.querySelector<HTMLInputElement>("#password");
  if (pw) pw.value = app.password;
  await bridge.createStartUpPageContainer(homePage() as never);
  bridge.onEvenHubEvent((ev) => { onEvent(ev).catch((err) => console.error(err)); });
  await loadData();
  setInterval(() => { if (app.page === "home") loadData(); }, REFRESH_MS);
}

main().catch((err) => console.error("Work Tickets failed to start:", err));
