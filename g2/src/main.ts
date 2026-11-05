// Pro Shop on the Even G2.
//
//   Home      today's appointments, what's coming up, and open tickets.
//             Swipe to move, press to open one, double press to exit.
//   Hold      talk to Jarvis (the shop's voice assistant). Release, and the
//             glasses show what was heard: press to send it, hold to say it
//             again, double press to drop it. Nothing is sent unheard.
//   Menu      (tap, then long press) Talk to Jarvis, Refresh, Switch house.
//
// The phone screen holds the settings: the Jarvis password and the house.
import {
  AudioInputSource,
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { ask, loadAppointments, loadTickets, transcribe } from "./api";
import { isDemo } from "./demo";
import { fitPage, homeRows, shopToday, longDate, toBase64, type Place, type Row } from "./shop";

const W = 576, H = 288;
const MAX_AUDIO_BYTES = 30 * 32000;   // 30 seconds of 16 kHz 16-bit mono

const MENU = {
  menuItems: [
    { itemName: "Talk to Jarvis", itemID: 1 },
    { itemName: "Refresh", itemID: 2 },
    { itemName: "Switch house", itemID: 3 },
  ],
};
const PLACES: Place[] = ["Valley", "South Side", "Both"];

type Page = "home" | "detail" | "voice";
type VoiceStep = "listening" | "hearing" | "confirm" | "thinking" | "answer" | "error";

const app = {
  bridge: null as EvenAppBridge | null,
  page: "home" as Page,
  rows: [] as Row[],
  status: "Loading…",
  password: "",
  place: "Valley" as Place,
  // voice
  step: "answer" as VoiceStep,
  recording: false,
  holdToTalk: true,         // false when started from the menu: press stops it
  chunks: [] as Uint8Array[],
  bytes: 0,
  heard: "",
  state: "",                // Jarvis's conversation state, carried between turns
  done: true,
  log: [] as string[],      // this conversation, newest last, for the voice page
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function text(id: number, name: string, y: number, h: number, content: string, capture = 0, extra = {}) {
  return { xPosition: 0, yPosition: y, width: W, height: h, containerID: id, containerName: name, content, isEventCapture: capture, paddingLength: 4, ...extra };
}

function homePage() {
  const today = shopToday();
  const head = `PRO SHOP · ${app.place} · ${longDate(today)}`;
  const items = app.rows.length ? app.rows.map((r) => r.label) : [app.status];
  return {
    containerTotalNum: 3,
    textObject: [
      text(1, "head", 0, 36, head, 0, { textColor: 3 }),
      text(3, "foot", 252, 36, app.password ? app.status : "Set the Jarvis password on your phone", 0, { textColor: 2 }),
    ],
    listObject: [{
      xPosition: 0, yPosition: 36, width: W, height: 216,
      containerID: 2, containerName: "home", isEventCapture: 1,
      itemContainer: { itemCount: items.length, itemName: items, isItemSelectBorderEn: 1 },
    }],
    menuObject: MENU,
  };
}

function detailPage(body: string) {
  return { containerTotalNum: 1, textObject: [text(4, "detail", 0, 0 + H, fitPage(`${body}\n\n(press to go back)`), 1)], menuObject: MENU };
}

function voiceText(): string {
  const convo = app.log.slice(-4).join("\n\n");
  const prompt = {
    listening: app.holdToTalk ? "● Listening… release to send" : "● Listening… press when done",
    hearing: "Hearing that…",
    confirm: `"${app.heard}"\n\nPress: send · Hold: say again · Double: drop it`,
    thinking: `"${app.heard}"\n\nJarvis is on it…`,
    answer: app.done ? "Press: back to today · Hold: something else" : "Hold to answer",
    error: "Press: back to today · Hold: try again",
  }[app.step];
  return fitPage(convo ? `${convo}\n\n${prompt}` : prompt);
}

function voicePage() {
  return { containerTotalNum: 1, textObject: [text(5, "voice", 0, H, voiceText(), 1)], menuObject: MENU };
}

async function show(page: Page, detail = "") {
  if (!app.bridge) return;
  app.page = page;
  const layout = page === "home" ? homePage() : page === "detail" ? detailPage(detail) : voicePage();
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
    await app.bridge.textContainerUpgrade({ containerID: 3, containerName: "foot", content: app.status } as never);
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
    const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    app.status = `Updated ${t} · Hold to talk to Jarvis`;
  } catch (err) {
    app.status = `Couldn't load: ${(err as Error).message}`;
  }
  if (redraw && app.page === "home") await show("home");
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

async function startRecording(holdToTalk: boolean) {
  if (!app.bridge || app.recording) return;
  if (!app.password && !isDemo()) {
    app.step = "error";
    app.log = ["Set the Jarvis password on your phone first."];
    return refreshVoice();
  }
  if (app.done) { app.state = ""; app.log = []; }
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
  if (app.bytes < 8000 && !isDemo()) {   // under a quarter second: a slip, not speech
    app.step = "answer";
    return app.log.length ? refreshVoice() : show("home");
  }
  app.step = "hearing";
  await refreshVoice();
  try {
    const out = await transcribe(app.password, toBase64(app.chunks));
    app.heard = out.heard || "";
    if (!app.heard) {
      app.step = "error";
      app.log.push(out.say || "I didn't catch that.");
    } else {
      app.step = "confirm";
    }
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't reach Jarvis: ${(err as Error).message}`);
  }
  app.chunks = [];
  await refreshVoice();
}

async function sendHeard() {
  app.step = "thinking";
  await refreshVoice();
  try {
    const out = await ask(app.password, app.heard, app.state, app.place);
    app.log.push(`You: ${app.heard}`, `Jarvis: ${out.say || "…"}`);
    app.state = out.state || "";
    app.done = out.done !== false;
    app.step = "answer";
    // Whatever was booked or added shows on the home list when we go back.
    if (app.done) loadHome(false);
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't reach Jarvis: ${(err as Error).message}`);
  }
  app.heard = "";
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
    app.status = "Refreshing…";
    await refreshFooter();
    return loadHome();
  }
  if (id === 3) {
    app.place = PLACES[(PLACES.indexOf(app.place) + 1) % PLACES.length];
    await app.bridge?.setLocalStorage("place", app.place);
    syncPhone();
    return loadHome(app.page === "home");
  }
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
    if (g === "press" && row?.detail) return show("detail", row.detail);
    return;
  }
  if (app.page === "detail") return show("home");

  // Voice page.
  if (app.step === "confirm") {
    if (g === "press") return sendHeard();
    if (g === "double") { app.heard = ""; app.step = "answer"; return app.log.length ? refreshVoice() : show("home"); }
    return;
  }
  if (app.step === "thinking" || app.step === "hearing") return;
  if (g === "press" && (app.done || app.step === "error")) return show("home");
  if (g === "double") return show("home");   // the conversation waits; holding again carries on
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
  syncPhone();

  await bridge.createStartUpPageContainer(homePage() as never);
  bridge.onEvenHubEvent((ev) => { onEvent(ev).catch((err) => console.error(err)); });
  await loadHome();
  // Keep the list fresh while the app is open, the way the wall board does.
  setInterval(() => { if (app.page === "home" && !app.recording) loadHome(); }, 60000);
}

main().catch((err) => console.error("Pro Shop failed to start:", err));
