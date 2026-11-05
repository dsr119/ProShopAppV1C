// Pro Shop on the Even G2.
//
//   Dashboard the time, today's appointments, open tickets. Below them:
//             All appointments, All tickets, Talk to EDITH. Double press exits.
//   Lists     every booking from today on / every open ticket. Press one
//             for its details; double press goes back.
//   Hold      talk to EDITH (the shop's voice assistant, Jarvis on the
//             laptop). Release, and the glasses show what was heard: press
//             to send it, hold to say it again, double press to drop it.
//   Hands-free  (menu) the mic stays open while the app is; "Hey EDITH,
//             make a work order" shows the words and sends them after a
//             3 second countdown unless you double press. When EDITH asks
//             something back, just answer: no wake word needed for 30 seconds.
//   Menu      (tap, then long press) Talk to EDITH, Refresh, Switch house,
//             Start / Stop hands-free.
//
// The phone screen holds the settings: the EDITH password and the house.
import {
  AudioInputSource,
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { ask, loadAppointments, loadTickets, transcribe } from "./api";
import { isDemo } from "./demo";
import { PhraseCatcher, wakeSplit } from "./listen";
import { appointmentRows, dashAppointments, dashTickets, fitPage, longDate, shopToday, ticketRows, toBase64,
  type Appointment, type Place, type Row, type Ticket } from "./shop";

const W = 576, H = 288;
const MAX_AUDIO_BYTES = 30 * 32000;   // 30 seconds of 16 kHz 16-bit mono
const COUNTDOWN = 3;                  // seconds before a hands-free command is sent
const WAKE_WAIT_MS = 8000;            // after a bare "Hey EDITH", how long to wait for the rest
const ANSWER_WAIT_MS = 30000;         // after EDITH asks something, how long an answer needs no wake word
const BACK_HOME_MS = 20000;           // hands-free: an answer stays up this long, then back

const PLACES: Place[] = ["Valley", "South Side", "Both"];

type Page = "dash" | "appts" | "tickets" | "detail" | "voice";
type ListPage = "appts" | "tickets";
type VoiceStep = "listening" | "hearing" | "waiting" | "confirm" | "thinking" | "answer" | "error";

const app = {
  bridge: null as EvenAppBridge | null,
  page: "dash" as Page,
  back: "dash" as Page,     // where press / double press returns from details or EDITH
  detail: "",
  appts: [] as Appointment[],
  tickets: [] as Ticket[],
  rows: [] as Row[],        // the list on screen, for picking the pressed one
  updated: "Loading…",
  password: "",
  place: "Valley" as Place,
  // voice
  step: "answer" as VoiceStep,
  recording: false,
  holdToTalk: true,         // false when started from the menu: press stops it
  chunks: [] as Uint8Array[],
  bytes: 0,
  heard: "",
  state: "",                // the assistant's conversation state, carried between turns
  done: true,
  log: [] as string[],      // this conversation, newest last, for the voice page
  // hands-free
  handsFree: false,
  catcher: new PhraseCatcher(),
  busy: false,              // a phrase is being transcribed
  awaitUntil: 0,            // until then, the next phrase needs no wake word
  countdown: 0,
  countdownTimer: 0 as ReturnType<typeof setInterval> | 0,
  homeTimer: 0 as ReturnType<typeof setTimeout> | 0,
};

const hasPassword = () => !!app.password || isDemo();

function menu() {
  return {
    menuItems: [
      { itemName: "Talk to EDITH", itemID: 1 },
      { itemName: app.handsFree ? "Stop hands-free" : "Start hands-free", itemID: 4 },
      { itemName: "Refresh", itemID: 2 },
      { itemName: "Switch house", itemID: 3 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function text(id: number, name: string, y: number, h: number, content: string, capture = 0, extra = {}) {
  return { xPosition: 0, yPosition: y, width: W, height: h, containerID: id, containerName: name, content, isEventCapture: capture, paddingLength: 4, ...extra };
}

const NAV = ["▶ All appointments", "▶ All tickets", "▶ Talk to EDITH"];

function headLine(): string {
  const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const hint = !hasPassword() ? "Set password on phone" : app.handsFree ? '● Say "Hey EDITH"' : "Hold: EDITH";
  return `${now} · ${longDate(shopToday())} · ${app.place}   ${hint}`;
}

function dashPage() {
  const today = shopToday();
  const box = (id: number, name: string, x: number, content: string) => ({
    xPosition: x, yPosition: 34, width: 286, height: 168, containerID: id, containerName: name, content,
    isEventCapture: 0, borderWidth: 1, borderColor: 6, borderRadius: 6, paddingLength: 6,
  });
  const loading = app.updated === "Loading…";
  return {
    containerTotalNum: 4,
    textObject: [
      text(1, "head", 0, 32, headLine(), 0, { textColor: 4 }),
      box(2, "appts", 0, loading ? "Loading…" : dashAppointments(app.appts, app.place, today)),
      box(3, "tickets", 290, loading ? "" : dashTickets(app.tickets, app.place, today)),
    ],
    listObject: [{
      xPosition: 0, yPosition: 206, width: W, height: 82,
      containerID: 4, containerName: "nav", isEventCapture: 1,
      itemContainer: { itemCount: NAV.length, itemName: NAV, isItemSelectBorderEn: 1 },
    }],
    menuObject: menu(),
  };
}

function listPage(which: ListPage) {
  const today = shopToday();
  app.rows = which === "appts" ? appointmentRows(app.appts, app.place, today) : ticketRows(app.tickets, app.place, today);
  const title = which === "appts" ? `ALL APPOINTMENTS · ${app.place} · next 2 weeks` : `ALL OPEN TICKETS · ${app.place}`;
  const items = app.rows.map((r) => r.label);
  return {
    containerTotalNum: 2,
    textObject: [text(1, "title", 0, 32, title, 0, { textColor: 3 })],
    listObject: [{
      xPosition: 0, yPosition: 32, width: W, height: H - 32,
      containerID: 2, containerName: "list", isEventCapture: 1,
      itemContainer: { itemCount: items.length, itemName: items, isItemSelectBorderEn: 1 },
    }],
    menuObject: menu(),
  };
}

function detailPage() {
  return { containerTotalNum: 1, textObject: [text(4, "detail", 0, H, fitPage(`${app.detail}\n\n(press to go back)`), 1)], menuObject: menu() };
}

function voiceText(): string {
  const convo = app.log.slice(-4).join("\n\n");
  const prompt = {
    listening: app.holdToTalk ? "● Listening… release to send" : "● Listening… press when done",
    hearing: "Hearing that…",
    waiting: "● EDITH is listening…",
    confirm: app.countdown > 0
      ? `"${app.heard}"\n\nSending in ${app.countdown}… · Press: send now · Double: stop`
      : `"${app.heard}"\n\nPress: send · Hold: say again · Double: drop it`,
    thinking: `"${app.heard}"\n\nEDITH is on it…`,
    answer: !app.done
      ? (app.handsFree ? "Just answer, or hold to talk" : "Hold to answer")
      : (app.handsFree ? 'Press: back · "Hey EDITH" for more' : "Press: back · Hold: something else"),
    error: "Press: back · Hold: try again",
  }[app.step];
  return fitPage(convo ? `${convo}\n\n${prompt}` : prompt);
}

function voicePage() {
  return { containerTotalNum: 1, textObject: [text(5, "voice", 0, H, voiceText(), 1)], menuObject: menu() };
}

async function show(page: Page) {
  if (!app.bridge) return;
  if (page !== "voice") clearHomeTimer();
  // Details and EDITH go back to wherever they were opened from.
  if ((page === "voice" || page === "detail") && app.page !== "voice" && app.page !== "detail") app.back = app.page;
  app.page = page;
  const layout = page === "dash" ? dashPage() : page === "appts" || page === "tickets" ? listPage(page)
    : page === "detail" ? detailPage() : voicePage();
  await app.bridge.rebuildPageContainer(layout as never);
}

// Voice page updates in place: no flicker while the conversation moves on.
async function refreshVoice() {
  if (!app.bridge) return;
  if (app.page !== "voice") return show("voice");
  await app.bridge.textContainerUpgrade({ containerID: 5, containerName: "voice", content: voiceText() } as never);
}

// The dashboard updates in place every minute: the clock and both boxes.
async function refreshDash() {
  if (!app.bridge || app.page !== "dash") return;
  const today = shopToday();
  const up = (id: number, name: string, content: string) =>
    app.bridge!.textContainerUpgrade({ containerID: id, containerName: name, content } as never);
  await up(1, "head", headLine());
  await up(2, "appts", dashAppointments(app.appts, app.place, today));
  await up(3, "tickets", dashTickets(app.tickets, app.place, today));
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadData(redraw = true) {
  const today = shopToday();
  try {
    [app.appts, app.tickets] = await Promise.all([loadAppointments(today, 14), loadTickets()]);
    app.updated = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch (err) {
    app.updated = `Couldn't load: ${(err as Error).message}`;
    console.warn(app.updated);
  }
  if (!redraw) return;
  if (app.page === "dash") await refreshDash();
  else if (app.page === "appts" || app.page === "tickets") await show(app.page);
}

// ---------------------------------------------------------------------------
// Voice: hold to talk
// ---------------------------------------------------------------------------

function newConversationIfDone() {
  if (app.done) { app.state = ""; app.log = []; }
}

async function startRecording(holdToTalk: boolean) {
  if (!app.bridge || app.recording) return;
  stopCountdown();
  clearHomeTimer();
  if (!hasPassword()) {
    app.step = "error";
    app.log = ["Set the EDITH password on your phone first."];
    return refreshVoice();
  }
  newConversationIfDone();
  app.recording = true;
  app.holdToTalk = holdToTalk;
  app.chunks = [];
  app.bytes = 0;
  app.step = "listening";
  await refreshVoice();
  // In hands-free the mic is already open; the same stream is used.
  if (!app.handsFree) await app.bridge.audioControl(true, AudioInputSource.Glasses);
}

async function stopRecording() {
  if (!app.bridge || !app.recording) return;
  app.recording = false;
  if (!app.handsFree) await app.bridge.audioControl(false);
  app.catcher.reset();
  if (app.bytes < 8000 && !isDemo()) {   // under a quarter second: a slip, not speech
    app.step = "answer";
    return app.log.length ? refreshVoice() : show(app.back);
  }
  app.step = "hearing";
  await refreshVoice();
  try {
    const out = await transcribe(app.password, toBase64(app.chunks));
    // People say the name while holding too; it isn't part of the request.
    const words = out.heard || "";
    const w = wakeSplit(words);
    app.heard = w.woke ? w.rest : words;
    if (!app.heard) {
      app.step = "error";
      app.log.push(out.say || "I didn't catch that.");
    } else {
      app.step = "confirm";
      app.countdown = 0;
    }
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't reach EDITH: ${(err as Error).message}`);
  }
  app.chunks = [];
  await refreshVoice();
}

async function sendHeard() {
  stopCountdown();
  app.step = "thinking";
  await refreshVoice();
  try {
    const out = await ask(app.password, app.heard, app.state, app.place);
    app.log.push(`You: ${app.heard}`, `EDITH: ${out.say || "…"}`);
    app.state = out.state || "";
    app.done = out.done !== false;
    app.step = "answer";
    // Whatever was booked or added shows on the home list when we go back.
    if (app.done) loadData(false);
    if (app.handsFree) {
      if (!app.done) app.awaitUntil = Date.now() + ANSWER_WAIT_MS;
      else armHomeTimer();
    }
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't reach EDITH: ${(err as Error).message}`);
  }
  app.heard = "";
  await refreshVoice();
}

// ---------------------------------------------------------------------------
// Voice: hands-free
// ---------------------------------------------------------------------------

function stopCountdown() {
  if (app.countdownTimer) clearInterval(app.countdownTimer);
  app.countdownTimer = 0;
  app.countdown = 0;
}

function clearHomeTimer() {
  if (app.homeTimer) clearTimeout(app.homeTimer);
  app.homeTimer = 0;
}

function armHomeTimer() {
  clearHomeTimer();
  app.homeTimer = setTimeout(() => {
    app.homeTimer = 0;
    if (app.page === "voice" && app.step === "answer" && app.done) show(app.back);
  }, BACK_HOME_MS);
}

// Show the words, count down, then send. Double press stops it.
async function confirmThenSend(words: string) {
  app.heard = words;
  app.step = "confirm";
  app.countdown = COUNTDOWN;
  await refreshVoice();
  app.countdownTimer = setInterval(() => {
    app.countdown -= 1;
    if (app.countdown <= 0) { sendHeard(); return; }
    refreshVoice();
  }, 1000);
}

// Busy screens don't listen: a phrase said over a countdown or while EDITH is
// working would only be noise.
const listening = () => app.handsFree && !app.recording && !app.busy
  && !["hearing", "confirm", "thinking"].includes(app.step);

async function onPhrase(chunks: Uint8Array[]) {
  app.busy = true;
  try {
    const out = await transcribe(app.password, toBase64(chunks));
    const words = out.heard || "";
    if (!words) return;
    const awaiting = Date.now() < app.awaitUntil;
    const w = wakeSplit(words);
    if (!w.woke && !awaiting) return;   // talk that isn't for EDITH
    const command = w.woke ? w.rest : words;
    clearHomeTimer();
    if (!command) {
      // Just "Hey EDITH": wait a moment for the rest.
      if (!awaiting) newConversationIfDone();
      app.awaitUntil = Date.now() + WAKE_WAIT_MS;
      app.step = "waiting";
      return refreshVoice();
    }
    if (!awaiting) newConversationIfDone();
    app.awaitUntil = 0;
    await confirmThenSend(command);
  } catch (err) {
    console.warn("Hands-free phrase not heard:", (err as Error).message);
  } finally {
    app.busy = false;
    app.catcher.reset();
  }
}

async function setHandsFree(on: boolean) {
  if (!app.bridge) return;
  if (on && !hasPassword()) {
    app.step = "error";
    app.log = ["Set the EDITH password on your phone first."];
    return refreshVoice();
  }
  app.handsFree = on;
  app.catcher.reset();
  app.awaitUntil = 0;
  await app.bridge.setLocalStorage("handsfree", on ? "1" : "");
  if (on) await app.bridge.audioControl(true, AudioInputSource.Glasses);
  else if (!app.recording) await app.bridge.audioControl(false);
  // Rebuild to swap the menu's Start / Stop label and the footer hint.
  await show(app.page);
}

function onAudio(pcm: Uint8Array) {
  if (app.recording) {
    app.chunks.push(pcm);
    app.bytes += pcm.length;
    if (app.bytes >= MAX_AUDIO_BYTES) stopRecording();
    return;
  }
  if (!listening()) return;
  const phrase = app.catcher.feed(pcm);
  if (phrase) onPhrase(phrase);
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
  // A press often comes with no type at all (0 dropped in transit): on a
  // list or text event, or as a bare system event naming only its source.
  if (type === OsEventTypeList.CLICK_EVENT) return "press";
  if (type === undefined && (inner || (ev.sysEvent && !ev.sysEvent.imuData))) return "press";
  return null;
}

async function onMenu(id: number) {
  if (id === 1) {
    await show("voice");
    return startRecording(false);
  }
  if (id === 2) return loadData();
  if (id === 3) {
    app.place = PLACES[(PLACES.indexOf(app.place) + 1) % PLACES.length];
    await app.bridge?.setLocalStorage("place", app.place);
    syncPhone();
    if (app.page === "dash") await refreshDash();
    return loadData();
  }
  if (id === 4) return setHandsFree(!app.handsFree);
}

async function onEvent(ev: EvenHubEvent) {
  if (ev.audioEvent) return onAudio(ev.audioEvent.audioPcm);
  if (ev.menuItemClickEvent?.itemID) return onMenu(ev.menuItemClickEvent.itemID);
  const g = gestureOf(ev);
  if (!g) return;

  if (g === "hold") {
    if (app.page !== "voice") await show("voice");
    return startRecording(true);
  }
  if (g === "release") return app.holdToTalk ? stopRecording() : undefined;
  if (app.recording) return g === "press" ? stopRecording() : undefined;

  if (app.page === "dash") {
    if (g === "double") return app.bridge?.shutDownPageContainer(1);   // the system's exit dialog
    if (g !== "press") return;
    const i = ev.listEvent?.currentSelectItemIndex ?? 0;
    if (i === 0) return show("appts");
    if (i === 1) return show("tickets");
    await show("voice");
    return startRecording(false);
  }
  if (app.page === "appts" || app.page === "tickets") {
    if (g === "double") return show("dash");
    const row = app.rows[ev.listEvent?.currentSelectItemIndex ?? -1];
    if (g === "press" && row?.detail) { app.detail = row.detail; return show("detail"); }
    return;
  }
  if (app.page === "detail") return show(app.back);

  // Voice page.
  if (app.step === "confirm") {
    if (g === "press") return sendHeard();
    if (g === "double") {
      stopCountdown();
      app.heard = "";
      app.step = "answer";
      return app.log.length ? refreshVoice() : show(app.back);
    }
    return;
  }
  if (app.step === "waiting") {
    if (g === "double" || g === "press") { app.awaitUntil = 0; app.step = "answer"; return app.log.length ? refreshVoice() : show(app.back); }
    return;
  }
  if (app.step === "thinking" || app.step === "hearing") return;
  if (g === "press" && (app.done || app.step === "error")) return show(app.back);
  if (g === "double") { app.awaitUntil = 0; return show(app.back); }   // the conversation waits; holding again carries on
}

// ---------------------------------------------------------------------------
// Phone screen: settings
// ---------------------------------------------------------------------------

function syncPhone() {
  const pw = document.querySelector<HTMLInputElement>("#password");
  const place = document.querySelector<HTMLSelectElement>("#place");
  if (pw && document.activeElement !== pw) pw.value = app.password;
  if (place) place.value = app.place;
}

function wirePhone() {
  const form = document.querySelector<HTMLFormElement>("#settings");
  const note = document.querySelector<HTMLElement>("#saved");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    app.password = (document.querySelector<HTMLInputElement>("#password")?.value || "").trim();
    app.place = (document.querySelector<HTMLSelectElement>("#place")?.value || "Valley") as Place;
    await app.bridge?.setLocalStorage("password", app.password);
    await app.bridge?.setLocalStorage("place", app.place);
    if (note) note.textContent = "Saved. The glasses are updated.";
    await show(app.page === "voice" || app.page === "detail" ? app.back : app.page);
    await loadData();
  });
}

// ---------------------------------------------------------------------------

async function main() {
  wirePhone();
  const bridge = await waitForEvenAppBridge();
  app.bridge = bridge;
  app.password = (await bridge.getLocalStorage("password")) || "";
  const saved = (await bridge.getLocalStorage("place")) as Place;
  if (PLACES.includes(saved)) app.place = saved;
  app.handsFree = (await bridge.getLocalStorage("handsfree")) === "1" && hasPassword();
  syncPhone();

  await bridge.createStartUpPageContainer(dashPage() as never);
  bridge.onEvenHubEvent((ev) => { onEvent(ev).catch((err) => console.error(err)); });
  // The glasses mic can only open once the startup page exists.
  if (app.handsFree) await bridge.audioControl(true, AudioInputSource.Glasses);
  await loadData();
  // The clock and the boxes stay fresh while the app is open, like the wall board.
  setInterval(() => { if (!app.recording) loadData(); }, 60000);
}

main().catch((err) => console.error("Pro Shop failed to start:", err));
