// Pro Shop on the Even G2.
//
//   Home      today's appointments, what's coming up, and open tickets.
//             Swipe to move, press to open one, double press to exit.
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
import { fitPage, homeRows, shopToday, longDate, toBase64, type Place, type Row } from "./shop";

const W = 576, H = 288;
const MAX_AUDIO_BYTES = 30 * 32000;   // 30 seconds of 16 kHz 16-bit mono
const COUNTDOWN = 3;                  // seconds before a hands-free command is sent
const WAKE_WAIT_MS = 8000;            // after a bare "Hey EDITH", how long to wait for the rest
const ANSWER_WAIT_MS = 30000;         // after EDITH asks something, how long an answer needs no wake word
const BACK_HOME_MS = 20000;           // hands-free: an answer stays up this long, then home

const PLACES: Place[] = ["Valley", "South Side", "Both"];

type Page = "home" | "detail" | "voice";
type VoiceStep = "listening" | "hearing" | "waiting" | "confirm" | "thinking" | "answer" | "error";

const app = {
  bridge: null as EvenAppBridge | null,
  page: "home" as Page,
  detail: "",
  rows: [] as Row[],
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

function footer(): string {
  if (!hasPassword()) return "Set the EDITH password on your phone";
  return `${app.updated} · ${app.handsFree ? 'Say "Hey EDITH"' : "Hold to talk to EDITH"}`;
}

function homePage() {
  const head = `PRO SHOP · ${app.place} · ${longDate(shopToday())}`;
  const items = app.rows.length ? app.rows.map((r) => r.label) : [app.updated];
  return {
    containerTotalNum: 3,
    textObject: [
      text(1, "head", 0, 36, head, 0, { textColor: 3 }),
      text(3, "foot", 252, 36, footer(), 0, { textColor: 2 }),
    ],
    listObject: [{
      xPosition: 0, yPosition: 36, width: W, height: 216,
      containerID: 2, containerName: "home", isEventCapture: 1,
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
      : (app.handsFree ? 'Press: back to today · "Hey EDITH" for more' : "Press: back to today · Hold: something else"),
    error: "Press: back to today · Hold: try again",
  }[app.step];
  return fitPage(convo ? `${convo}\n\n${prompt}` : prompt);
}

function voicePage() {
  return { containerTotalNum: 1, textObject: [text(5, "voice", 0, H, voiceText(), 1)], menuObject: menu() };
}

async function show(page: Page) {
  if (!app.bridge) return;
  if (page !== "voice") clearHomeTimer();
  app.page = page;
  const layout = page === "home" ? homePage() : page === "detail" ? detailPage() : voicePage();
  await app.bridge.rebuildPageContainer(layout as never);
}

// Voice page updates in place: no flicker while the conversation moves on.
async function refreshVoice() {
  if (!app.bridge) return;
  if (app.page !== "voice") return show("voice");
  await app.bridge.textContainerUpgrade({ containerID: 5, containerName: "voice", content: voiceText() } as never);
}

async function refreshFooter() {
  if (app.bridge && app.page === "home") {
    await app.bridge.textContainerUpgrade({ containerID: 3, containerName: "foot", content: footer() } as never);
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadHome(redraw = true) {
  const today = shopToday();
  try {
    const [appts, tickets] = await Promise.all([loadAppointments(today), loadTickets()]);
    app.rows = homeRows(appts, tickets, app.place, today);
    app.updated = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch (err) {
    app.updated = `Couldn't load: ${(err as Error).message}`;
  }
  if (redraw && app.page === "home") await show("home");
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
    return app.log.length ? refreshVoice() : show("home");
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
    if (app.done) loadHome(false);
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
    if (app.page === "voice" && app.step === "answer" && app.done) show("home");
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
  if (id === 2) {
    app.updated = "Refreshing…";
    await refreshFooter();
    return loadHome();
  }
  if (id === 3) {
    app.place = PLACES[(PLACES.indexOf(app.place) + 1) % PLACES.length];
    await app.bridge?.setLocalStorage("place", app.place);
    syncPhone();
    return loadHome(app.page === "home");
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

  if (app.page === "home") {
    if (g === "double") return app.bridge?.shutDownPageContainer(1);   // the system's exit dialog
    const i = ev.listEvent?.currentSelectItemIndex ?? -1;
    const row = app.rows[i];
    if (g === "press" && row?.detail) { app.detail = row.detail; return show("detail"); }
    return;
  }
  if (app.page === "detail") return show("home");

  // Voice page.
  if (app.step === "confirm") {
    if (g === "press") return sendHeard();
    if (g === "double") {
      stopCountdown();
      app.heard = "";
      app.step = "answer";
      return app.log.length ? refreshVoice() : show("home");
    }
    return;
  }
  if (app.step === "waiting") {
    if (g === "double" || g === "press") { app.awaitUntil = 0; app.step = "answer"; return app.log.length ? refreshVoice() : show("home"); }
    return;
  }
  if (app.step === "thinking" || app.step === "hearing") return;
  if (g === "press" && (app.done || app.step === "error")) return show("home");
  if (g === "double") { app.awaitUntil = 0; return show("home"); }   // the conversation waits; holding again carries on
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
    await loadHome();
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

  await bridge.createStartUpPageContainer(homePage() as never);
  bridge.onEvenHubEvent((ev) => { onEvent(ev).catch((err) => console.error(err)); });
  // The glasses mic can only open once the startup page exists.
  if (app.handsFree) await bridge.audioControl(true, AudioInputSource.Glasses);
  await loadHome();
  // Keep the list fresh while the app is open, the way the wall board does.
  setInterval(() => { if (app.page === "home" && !app.recording) loadHome(); }, 60000);
}

main().catch((err) => console.error("Pro Shop failed to start:", err));
