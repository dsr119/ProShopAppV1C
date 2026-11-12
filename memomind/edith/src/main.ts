// EDITH (Pro Shop) on MemoMind glasses. The same app as the G2 one in g2/,
// with the same data and voice assistant; only the screen and the controls
// are MemoMind's.
//
//   Dashboard   the time, today's appointments, open tickets, and a menu:
//               All appointments, All tickets, Talk to EDITH, Spec sheet,
//               Switch house, Refresh. Look up / down to move, tap to open.
//   Lists       look up / down to move (turn left / right jumps a page),
//               tap for details, double tap goes back.
//   Hold        talk to EDITH (Jarvis, the alexa-work-order function). The
//               glasses button has no "let go" event, so: hold to start,
//               tap when done. The glasses show what was heard: tap to send,
//               hold to say it again, double tap to drop it.
//   Spec sheet  "Pull up the spec sheet for Joe Sutton" shows the sheet in
//               three parts: fingers, span, thumb. Tap for the next part. On
//               the span, turn your head left / right for Full, Cut to Cut
//               and Cut to Outer. Double tap goes back.
//
// The phone screen holds the settings: the EDITH password, the house, and
// demo mode (made-up data, for trying it in Studio).
import { ask, findBowlers, loadAppointments, loadSpecSheet, loadTickets, transcribe, type SpecBowler } from "../../../g2/src/api";
import { isDemo } from "../../../g2/src/demo";
import { wakeSplit } from "../../../g2/src/listen";
import { appointmentRows, dashAppointments, dashTickets, longDate, shopToday, ticketRows,
  type Appointment, type Place, type Row, type Ticket } from "../../../g2/src/shop";
import { fingerHole, fingerMiddle, fingerPitch, firstSpanMode, nameQueries, nextSpanMode, pickLabel, spanBox, spanSelector,
  specParts, specRequest, specTitle, thumbHole, thumbInsert, thumbPitch, titleCase,
  type SpanMode, type SpecPart, type SpecSheet } from "../../../g2/src/spec";
import { Glasses, H, W, type Box, type Input } from "../../common/glasses";
import { clipLine, charsIn, fitBox, linesIn, listText, step } from "../../common/screen";
import { Mic } from "../../common/voice";

const PLACES: Place[] = ["Valley", "South Side", "Both"];

type Page = "dash" | "appts" | "tickets" | "detail" | "voice" | "spec" | "pick";
type VoiceStep = "listening" | "hearing" | "confirm" | "thinking" | "answer" | "error";

const glasses = new Glasses();
const mic = new Mic(glasses);

const app = {
  page: "dash" as Page,
  back: "dash" as Page,     // where details and EDITH go back to
  detail: "",
  appts: [] as Appointment[],
  tickets: [] as Ticket[],
  rows: [] as Row[],        // the list on screen
  sel: 0,                   // its cursor
  nav: 0,                   // the dashboard menu's cursor
  updated: "Loading…",
  password: "",
  place: "Valley" as Place,
  started: false,
  // voice
  step: "answer" as VoiceStep,
  heard: "",
  state: "",                // the assistant's conversation state, carried between turns
  done: true,
  log: [] as string[],      // this conversation, newest last
  // spec sheets
  wantSpecName: false,      // the next words are a bowler's name
  bowlers: [] as SpecBowler[],
  spec: null as SpecSheet | null,
  specPart: 0,
  spanMode: null as SpanMode | null,
};

const hasPassword = () => !!app.password || isDemo();

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const HEAD_H = 30;
const NAV_Y = 214;

function navItems(): string[] {
  return ["All appointments", "All tickets", "Talk to EDITH", "Spec sheet", `Switch house (now ${app.place})`, "Refresh"];
}

function headLine(): string {
  const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const hint = !hasPassword() ? "Set password on phone" : "Hold: EDITH";
  return clipLine(`${now} · ${longDate(shopToday())} · ${app.place} · ${hint}`, charsIn(W));
}

const loading = () => app.updated === "Loading…";

function dashBoxes(): Box[] {
  const today = shopToday();
  const h = NAV_Y - HEAD_H - 6;
  return [
    { id: 1, x: 0, y: 0, width: W, height: HEAD_H, text: headLine() },
    { id: 2, x: 0, y: HEAD_H + 2, width: 296, height: h, border: 1, radius: 6,
      text: loading() ? "Loading…" : fitBox(dashAppointments(app.appts, app.place, today), 296, h) },
    { id: 3, x: 304, y: HEAD_H + 2, width: 296, height: h, border: 1, radius: 6,
      text: loading() ? " " : fitBox(dashTickets(app.tickets, app.place, today), 296, h) },
    { id: 4, x: 0, y: NAV_Y, width: W, height: H - NAV_Y, text: listText(navItems(), app.nav, W, H - NAV_Y) },
  ];
}

function listBoxes(title: string, rows: string[]): Box[] {
  return [
    { id: 1, x: 0, y: 0, width: W, height: HEAD_H, text: clipLine(title, charsIn(W)) },
    { id: 2, x: 0, y: HEAD_H, width: W, height: H - HEAD_H, text: listText(rows, app.sel, W, H - HEAD_H) },
  ];
}

function listPageBoxes(): Box[] {
  if (app.page === "pick") {
    return listBoxes("WHICH BOWLER? · tap to open · double tap: back",
      app.bowlers.map((b) => pickLabel(b.name, b.phone, b.has_specs ? b.last_spec_at : null)));
  }
  const title = app.page === "appts" ? `ALL APPOINTMENTS · ${app.place} · next 2 weeks` : `ALL OPEN TICKETS · ${app.place}`;
  return listBoxes(title, app.rows.map((r) => r.label));
}

function detailBoxes(): Box[] {
  return [{ id: 1, x: 0, y: 0, width: W, height: H, text: fitBox(`${app.detail}\n\n(tap to go back)`, W, H) }];
}

const PROMPT_H = 52;

function voicePrompt(): string {
  return {
    listening: (app.wantSpecName ? "Spec sheet: say the bowler's name. " : "") + "● Listening… tap when done",
    hearing: "Hearing that…",
    confirm: `"${app.heard}"\nTap: send · Hold: say again · Double tap: drop it`,
    thinking: `"${app.heard}"\nEDITH is on it…`,
    answer: !app.done ? "Hold to answer · double tap: back" : "Tap: back · Hold: something else",
    error: "Tap: back · Hold: try again",
  }[app.step];
}

function voiceBoxes(): Box[] {
  const convo = app.log.slice(-6).join("\n\n");
  return [
    { id: 5, x: 0, y: 0, width: W, height: H - PROMPT_H - 4, text: fitBox(convo || " ", W, H - PROMPT_H - 4, true) },
    { id: 6, x: 0, y: H - PROMPT_H, width: W, height: PROMPT_H, border: 1, radius: 6, text: fitBox(voicePrompt(), W, PROMPT_H, true) },
  ];
}

// ---------------------------------------------------------------------------
// Spec sheet pages, laid out like the paper sheet
// ---------------------------------------------------------------------------

const PART_NAMES: Record<SpecPart, string> = { fingers: "FINGERS", span: "SPAN", thumb: "THUMB" };

function currentPart(): SpecPart {
  const parts = specParts(app.spec!.snapshot);
  return parts[app.specPart % parts.length];
}

function specHead(): string {
  const parts = specParts(app.spec!.snapshot);
  return clipLine(`${PART_NAMES[currentPart()]} ${app.specPart % parts.length + 1}/${parts.length} · ${specTitle(app.spec!)}`, charsIn(W));
}

function specHint(): string {
  const parts = specParts(app.spec!.snapshot);
  const next = parts[(app.specPart + 1) % parts.length];
  return parts.length > 1 ? `Tap: ${next} ▶ · Double tap: back` : "Double tap: back";
}

function card(id: number, x: number, y: number, w: number, h: number, text: string, radius = 6): Box {
  return { id, x, y, width: w, height: h, border: 1, radius, text: fitBox(text, w, h) };
}

function specBoxes(): Box[] {
  const s = app.spec!.snapshot;
  const part = currentPart();
  const head: Box = { id: 1, x: 0, y: 0, width: W, height: HEAD_H, text: specHead() };
  const hint = (text: string, x = 0, y = H - 40, w = W, h = 40): Box => ({ id: 9, x, y, width: w, height: h, text: fitBox(text, w, h) });
  if (part === "fingers") {
    // Middle finger on the left, ring on the right; pitches outside, holes inside, the bridge between.
    return [head,
      card(2, 0, 36, 112, 260, fingerPitch(s, "middle")),
      card(3, 118, 36, 176, 176, fingerHole(s, "middle"), 12),
      card(4, 306, 36, 176, 176, fingerHole(s, "ring"), 12),
      card(5, 488, 36, 112, 260, fingerPitch(s, "ring")),
      card(6, 190, 220, 220, 76, fingerMiddle(s)),
      hint(specHint()),
    ];
  }
  if (part === "span") {
    return [head,
      { id: 2, x: 40, y: 44, width: 520, height: 32, text: spanSelector(s, app.spanMode) },
      card(3, 40, 86, 250, 150, spanBox(s, "middle", app.spanMode)),
      card(4, 310, 86, 250, 150, spanBox(s, "ring", app.spanMode)),
      hint(`Turn head: span type · ${specHint()}`),
    ];
  }
  const p = thumbPitch(s);
  return [head,
    card(2, 220, 36, 160, 64, p.forward),
    card(3, 30, 144, 170, 64, p.left),
    card(4, 220, 108, 160, 140, thumbHole(s), 12),
    card(5, 400, 144, 170, 64, p.right),
    card(6, 220, 256, 160, 64, p.reverse),
    { id: 7, x: 400, y: 36, width: 200, height: 100, text: fitBox(thumbInsert(s), 200, 100) },
    hint(specHint().replace(" · ", "\n"), 0, 240, 210, 90),
  ];
}

function boxesFor(page: Page): Box[] {
  if (page === "dash") return dashBoxes();
  if (page === "appts" || page === "tickets" || page === "pick") return listPageBoxes();
  if (page === "detail") return detailBoxes();
  if (page === "spec") return specBoxes();
  return voiceBoxes();
}

async function show(page: Page) {
  if (page !== "voice") app.wantSpecName = false;
  // Details and EDITH go back to wherever they were opened from.
  if ((page === "voice" || page === "detail") && app.page !== "voice" && app.page !== "detail") app.back = app.page;
  if (page !== app.page && (page === "appts" || page === "tickets" || page === "pick")) app.sel = 0;
  app.page = page;
  if (page === "appts") app.rows = appointmentRows(app.appts, app.place, shopToday());
  if (page === "tickets") app.rows = ticketRows(app.tickets, app.place, shopToday());
  await glasses.page(boxesFor(page));
}

// The voice page and lists update in place: no flicker.
async function refreshVoice() {
  if (app.page !== "voice") return show("voice");
  for (const b of voiceBoxes()) await glasses.update(b);
}

async function refreshList() {
  const list = listPageBoxes()[1];
  await glasses.update(list);
}

async function refreshDash() {
  if (app.page !== "dash") return;
  for (const b of dashBoxes()) await glasses.update(b);
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
// Voice: hold to start, tap when done
// ---------------------------------------------------------------------------

function newConversationIfDone() {
  if (app.done) { app.state = ""; app.log = []; }
}

let fakeListening = false;   // demo mode in Studio, which has no glasses mic

const listeningNow = () => mic.on || fakeListening;

async function startListening() {
  if (listeningNow()) return;
  if (!hasPassword()) {
    app.step = "error";
    app.log = ["Set the EDITH password on your phone first."];
    return refreshVoice();
  }
  if (!glasses.audio && !isDemo()) {
    app.step = "error";
    app.log = ["The glasses mic isn't available. Check the glasses are connected and the app may use the mic."];
    return refreshVoice();
  }
  newConversationIfDone();
  app.step = "listening";
  await refreshVoice();
  try {
    if (glasses.audio) await mic.start(() => { void stopListening(); });
    else fakeListening = true;
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't open the mic: ${(err as Error).message}`);
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
    if (!audio) {
      app.step = "answer";
      return app.log.length ? refreshVoice() : show(app.back);
    }
    const out = await transcribe(app.password, audio);
    // People say the name too; it isn't part of the request.
    const words = out.heard || "";
    const w = wakeSplit(words);
    app.heard = w.woke ? w.rest : words;
    if (!app.heard) {
      app.step = "error";
      app.log.push(out.say || "I didn't catch that.");
    } else {
      app.step = "confirm";
    }
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't reach EDITH: ${(err as Error).message}`);
  }
  await refreshVoice();
}

async function sendHeard() {
  // Spec sheets are looked up right here, not by EDITH.
  const name = app.wantSpecName ? specRequest(`spec sheet ${app.heard}`) : specRequest(app.heard);
  if (name !== null) return openSpec(name);
  app.step = "thinking";
  await refreshVoice();
  try {
    const out = await ask(app.password, app.heard, app.state, app.place);
    app.log.push(`You: ${app.heard}`, `EDITH: ${out.say || "…"}`);
    app.state = out.state || "";
    app.done = out.done !== false;
    app.step = "answer";
    // Whatever was booked or added shows on the dashboard when we go back.
    if (app.done) void loadData(false);
  } catch (err) {
    app.step = "error";
    app.log.push(`Couldn't reach EDITH: ${(err as Error).message}`);
  }
  app.heard = "";
  await refreshVoice();
}

// ---------------------------------------------------------------------------
// Spec sheets: find the bowler, then show the sheet
// ---------------------------------------------------------------------------

async function openSpec(name: string) {
  const said = app.heard;
  app.heard = "";
  app.wantSpecName = false;
  if (!name) {
    app.wantSpecName = true;
    app.log.push(`You: ${said}`, "EDITH: Whose spec sheet? Hold and say the name.");
    app.done = false;
    app.step = "answer";
    return refreshVoice();
  }
  app.heard = `Spec sheet: ${titleCase(name)}`;
  app.step = "thinking";
  await refreshVoice();
  app.heard = "";
  try {
    // The whole name first; if Deepgram spelled it oddly, the last name, then the first.
    let found: SpecBowler[] = [];
    for (const q of nameQueries(name)) {
      found = await findBowlers(q);
      if (found.length) break;
    }
    const withSpecs = found.filter((b) => b.has_specs);
    app.done = true;
    if (!found.length) return specMessage(said, `I couldn't find a bowler named ${titleCase(name)}.`);
    if (!withSpecs.length) {
      return specMessage(said, found.length === 1
        ? `${found[0].name} has no digital spec sheet yet.`
        : `None of the ${found.length} bowlers called ${titleCase(name)} has a digital spec sheet yet.`);
    }
    if (withSpecs.length === 1) return showSheet(withSpecs[0], said);
    app.bowlers = withSpecs.slice(0, 50);
    return show("pick");
  } catch (err) {
    return specMessage(said, `Couldn't reach the spec sheets: ${(err as Error).message}`);
  }
}

async function specMessage(said: string, say: string) {
  app.log.push(`You: ${said}`, `EDITH: ${say}`);
  app.done = true;
  app.step = "answer";
  return refreshVoice();
}

async function showSheet(bowler: SpecBowler, said: string) {
  const sheet = await loadSpecSheet(bowler);
  if (!sheet) { if (app.page !== "voice") await show("voice"); return specMessage(said, `${bowler.name} has no digital spec sheet yet.`); }
  app.spec = sheet;
  app.specPart = 0;
  app.spanMode = firstSpanMode(sheet.snapshot);
  app.step = "answer";
  app.done = true;
  return show("spec");
}

async function onSpecInput(i: Input) {
  if (!app.spec || i === "double") return show("dash");
  if (i === "tap") {
    app.specPart = (app.specPart + 1) % specParts(app.spec.snapshot).length;
    if (currentPart() === "span") app.spanMode = firstSpanMode(app.spec.snapshot);
    return show("spec");
  }
  if (currentPart() === "span" && (i === "left" || i === "right" || i === "up" || i === "down")) {
    const next = nextSpanMode(app.spec.snapshot, app.spanMode, i === "right" || i === "down" ? 1 : -1);
    if (next === app.spanMode) return;
    app.spanMode = next;
    // Only the selector and the two numbers change.
    for (const b of specBoxes().filter((b) => b.id >= 2 && b.id <= 4)) await glasses.update(b);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

async function onNav(i: number) {
  if (i === 0) return show("appts");
  if (i === 1) return show("tickets");
  if (i === 2) { await show("voice"); return startListening(); }
  if (i === 3) {
    await show("voice");
    newConversationIfDone();
    app.wantSpecName = true;
    return startListening();
  }
  if (i === 4) {
    app.place = PLACES[(PLACES.indexOf(app.place) + 1) % PLACES.length];
    await glasses.set("place", app.place);
    syncPhone();
    await refreshDash();
    return loadData();
  }
  app.updated = "Loading…";
  await refreshDash();
  return loadData();
}

async function onInput(i: Input) {
  // Hold always talks to EDITH (or says it again).
  if (i === "hold") {
    if (listeningNow()) return;
    if (app.page !== "voice") await show("voice");
    return startListening();
  }
  if (listeningNow()) {
    if (i === "tap") return stopListening();
    if (i === "double") { mic.cancel(); fakeListening = false; app.step = "answer"; return app.log.length ? refreshVoice() : show(app.back); }
    return;
  }

  if (app.page === "dash") {
    const n = navItems().length;
    if (i === "up" || i === "down") { app.nav = step(app.nav, n, i === "down" ? 1 : -1); return refreshDash(); }
    if (i === "tap" || i === "nod") return onNav(app.nav);
    return;
  }
  if (app.page === "appts" || app.page === "tickets" || app.page === "pick") {
    const n = app.page === "pick" ? app.bowlers.length : app.rows.length;
    const pageRows = Math.max(1, linesIn(H - HEAD_H) - 2);
    if (i === "double" || i === "shake") return show("dash");
    if (i === "up" || i === "down") { app.sel = step(app.sel, n, i === "down" ? 1 : -1); return refreshList(); }
    if (i === "left" || i === "right") {
      app.sel = Math.min(n - 1, Math.max(0, app.sel + (i === "right" ? pageRows : -pageRows)));
      return refreshList();
    }
    if (i !== "tap" && i !== "nod") return;
    if (app.page === "pick") {
      const b = app.bowlers[app.sel];
      if (!b) return;
      try { return await showSheet(b, b.name); }
      catch (err) { await show("voice"); return specMessage(b.name, `Couldn't reach the spec sheets: ${(err as Error).message}`); }
    }
    const row = app.rows[app.sel];
    if (row?.detail) { app.detail = row.detail; return show("detail"); }
    return;
  }
  if (app.page === "detail") return i === "tap" || i === "double" ? show(app.back) : undefined;
  if (app.page === "spec") return onSpecInput(i);

  // The voice page.
  if (app.step === "confirm") {
    if (i === "tap" || i === "nod") return sendHeard();
    if (i === "double" || i === "shake") {
      app.heard = "";
      app.step = "answer";
      return app.log.length ? refreshVoice() : show(app.back);
    }
    return;
  }
  if (app.step === "thinking" || app.step === "hearing") return;
  if (i === "tap" && (app.done || app.step === "error")) return show(app.back);
  if (i === "double") return show(app.back);   // the conversation waits; holding again carries on
}

// Inputs are handled one at a time, in order: a quick tap after a hold must
// not overtake it.
let queue: Promise<unknown> = Promise.resolve();
function enqueue(i: Input) {
  queue = queue.then(() => onInput(i)).catch((err) => console.error(err));
}

// ---------------------------------------------------------------------------
// Phone screen: settings
// ---------------------------------------------------------------------------

function setDemo(on: boolean) {
  const url = new URL(location.href);
  if (on) url.searchParams.set("demo", "");
  else url.searchParams.delete("demo");
  history.replaceState(null, "", url.toString().replace("demo=", "demo"));
}

function syncPhone() {
  const pw = document.querySelector<HTMLInputElement>("#password");
  const place = document.querySelector<HTMLSelectElement>("#place");
  const demo = document.querySelector<HTMLInputElement>("#demo");
  if (pw && document.activeElement !== pw) pw.value = app.password;
  if (place) place.value = app.place;
  if (demo) demo.checked = isDemo();
}

function setStatus(text: string) {
  const el = document.querySelector<HTMLElement>("#status");
  if (el) el.textContent = text;
}

function wirePhone() {
  const form = document.querySelector<HTMLFormElement>("#settings");
  const note = document.querySelector<HTMLElement>("#saved");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    app.password = (document.querySelector<HTMLInputElement>("#password")?.value || "").trim();
    app.place = (document.querySelector<HTMLSelectElement>("#place")?.value || "Valley") as Place;
    const demo = !!document.querySelector<HTMLInputElement>("#demo")?.checked;
    setDemo(demo);
    await glasses.set("password", app.password);
    await glasses.set("place", app.place);
    await glasses.set("demo", demo ? "1" : "");
    if (note) note.textContent = "Saved. The glasses are updated.";
    if (!app.started) return;
    app.updated = "Loading…";
    await show(app.page === "voice" || app.page === "detail" ? app.back : app.page);
    await loadData();
  });
}

// ---------------------------------------------------------------------------

async function main() {
  wirePhone();
  setStatus("Connecting to the MemoMind app…");
  await glasses.start({
    onInput: enqueue,
    onRedraw: () => { void glasses.redraw().catch(() => {}); },
    onPause: () => { mic.cancel(); fakeListening = false; },
  });
  app.password = await glasses.get("password");
  const saved = (await glasses.get("place")) as Place;
  if (PLACES.includes(saved)) app.place = saved;
  if ((await glasses.get("demo")) === "1") setDemo(true);
  syncPhone();
  setStatus(glasses.audio ? "Connected. Glasses mic ready." : "Connected. No glasses mic here (Studio has none).");

  try { await glasses.gm.display.createPage(); } catch { /* some hosts create it on the first rebuild */ }
  await show("dash");
  app.started = true;
  await loadData();
  // The clock and the boxes stay fresh while the app is open, like the wall board.
  setInterval(() => { if (!listeningNow() && app.page === "dash") void loadData(); }, 60_000);
}

main().catch((err) => {
  console.error("EDITH failed to start:", err);
  setStatus(`Couldn't start: ${(err as Error).message}`);
});
