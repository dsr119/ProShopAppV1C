// Day board -- the Raspberry Pi wall screen.
//
// Read-only by design. It polls, it draws, it never writes: a screen bolted to
// a wall with no keyboard cannot be allowed to change the order book, and a
// stray click from a wireless mouse someone left on the counter should do
// nothing at all.
//
// Two rules shape the rest of this file:
//
//   1. Never blank the screen. A failed poll keeps the last good list up and
//      raises a banner. An empty board reads as "nothing to do today", which
//      is a far worse lie than a list that is ten minutes old.
//   2. Dates are plain calendar days, never instants. As in appointments.js,
//      new Date("2026-08-30") is UTC midnight and renders as the 29th in any
//      negative-offset timezone -- which would put today's work under
//      "yesterday" every single day. Days are strings, compared as strings.

const $ = (id) => document.getElementById(id);

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];

// ---------------------------------------------------------------------------
// Settings, from the query string -- see the comment in board.html
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);

const num = (key, fallback, min, max) => {
  const v = Number(params.get(key));
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
};

const CFG = {
  days:     num("days", 7, 1, 60),
  refresh:  num("refresh", 60, 15, 3600) * 1000,
  location: params.get("location") || "",
  // Long enough to read a screenful without hurrying, short enough that the
  // last page is never more than a minute away on a busy day.
  page:     num("page", 12, 4, 120) * 1000,
  rotate:   params.get("rotate") !== "0" && params.get("scroll") !== "0",
  // How far back to keep showing work whose date has passed. Without a floor
  // the board slowly fills with a ball someone gave up on in 2024.
  lookback: num("lookback", 30, 1, 365),
};

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

function todayIso() {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

// Days from an ISO day to another, both plain calendar days.
function dayOffset(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d + days);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function daysBetween(fromIso, toIso) {
  const [ay, am, ad] = fromIso.split("-").map(Number);
  const [by, bm, bd] = toIso.split("-").map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

function prettyTime(t) {
  if (!t) return "";
  const [hs, mm] = t.split(":");
  let h = Number(hs);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return mm === "00" ? `${h}${ap}` : `${h}:${mm}${ap}`;
}

// "Thu 9/4", or "Tomorrow" -- a relative word is faster to read than a date
// for the two days people actually care about.
function prettyDay(iso, today) {
  const off = daysBetween(today, iso);
  if (off === 0) return "Today";
  if (off === 1) return "Tomorrow";
  const [y, m, d] = iso.split("-").map(Number);
  return `${DOW[new Date(y, m - 1, d).getDay()].slice(0, 3)} ${m}/${d}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let DATA = { appts: [], orders: [], tickets: [] };
let lastGood = 0;        // epoch ms of the last successful poll
let attempted = false;   // has a poll finished, successfully or not
let currentDay = todayIso();

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const APPT_COLS =
  "id,customer_name,phone,service,location,appt_date,appt_time,completed,paid,staff_member";
const ORDER_COLS =
  "id,customer_name,phone,item,due_date,paid,staff_member,pickup_location," +
  "order_location,drilled,no_drill_needed,out_the_door,is_stock";
// Every field the ticket column actually draws or sorts on, and nothing more.
// Keeping this in step with the renderer is not optional: it once carried no
// submitted_by while the column drew one, which put "undefined" on the wall.
const TICKET_COLS =
  "id,title,priority,status,assigned_to,due_date,submitted_at,resolution,location";

async function poll() {
  const today = todayIso();
  const to = dayOffset(today, CFG.days);
  // Two different windows on purpose. Orders reach back, because an overdue
  // one is still real work; appointments start at today, because a past one is
  // over either way and the board no longer looks at them.
  const ordersFrom = dayOffset(today, -CFG.lookback);

  try {
    const [appts, orders, tickets] = await Promise.all([
      db.selectAll(
        "appointments",
        `select=${APPT_COLS}&deleted_at=is.null` +
          `&appt_date=gte.${today}&appt_date=lte.${to}` +
          `&order=appt_date.asc,appt_time.asc.nullsfirst`
      ),
      db.selectAll(
        "orders",
        `select=${ORDER_COLS}&deleted_at=is.null&is_stock=is.false` +
          `&out_the_door=is.false&due_date=not.is.null` +
          `&due_date=gte.${ordersFrom}&due_date=lte.${to}` +
          `&order=due_date.asc`
      ),
      db.selectAll(
        "tickets",
        `select=${TICKET_COLS}&deleted_at=is.null&status=neq.done` +
          `&order=due_date.asc.nullslast`
      ),
    ]);

    DATA = { appts, orders, tickets };
    lastGood = Date.now();
    $("banner").classList.add("hidden");
  } catch (err) {
    // Deliberately no rethrow and no clearing of DATA -- rule 1.
    console.error("Board poll failed:", err);
    $("banner").textContent =
      "Can't reach the database — showing the last list that loaded.";
    $("banner").classList.remove("hidden");
  } finally {
    attempted = true;
  }

  render();
}

// ---------------------------------------------------------------------------
// Shaping
//
// Appointments and orders are different rows in different tables, but on a
// wall they are the same thing: a named person, a phone number, a job, a day
// it is wanted, whether it is paid, and who owns it. Both become one shape and
// the renderer stops caring which table they came from.
// ---------------------------------------------------------------------------

function fromAppointment(a) {
  return {
    key: "a" + a.id,
    day: a.appt_date,
    time: a.appt_time ? a.appt_time.slice(0, 5) : null,
    who: a.customer_name,
    phone: a.phone,
    what: a.service,
    staff: a.staff_member,
    paid: !!a.paid,
    location: a.location,
    done: !!a.completed,
    kind: "appointment",
  };
}

function fromOrder(o) {
  return {
    key: "o" + o.id,
    day: o.due_date,
    time: null,
    who: o.customer_name,
    phone: o.phone,
    // The board should say what is left to do, not just what was bought.
    what: (o.drilled || o.no_drill_needed ? "Ready — " : "Drill ") + o.item,
    staff: o.staff_member,
    paid: !!o.paid,
    location: o.pickup_location || o.order_location,
    done: !!o.out_the_door,
    kind: "order",
  };
}

function allItems() {
  const items = [
    ...DATA.appts.map(fromAppointment),
    ...DATA.orders.map(fromOrder),
  ];
  return items.filter((i) => here(i.location));
}

// Does this belong on the screen in front of you? One rule for appointments,
// orders and tickets alike: a board hung in the Valley has no business showing
// a ticket about the South Side building. Anything without a location, and
// anything marked "Both", belongs to whichever house is on screen -- an
// unlabelled row is far more likely to be an oversight than a deliberate
// statement that it happened somewhere else.
function here(location) {
  if (!CFG.location) return true;
  return !location || location === CFG.location || location === "Both";
}

// Within a day: timed work in clock order, untimed work after it.
function byTime(a, b) {
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time) return -1;
  if (b.time) return 1;
  return a.who.localeCompare(b.who);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const today = todayIso();
  const items = allItems();

  const todays = items.filter((i) => i.day === today).sort(byTime);

  // Overdue first, then the next few days. Something that was due Tuesday and
  // is still open is more urgent than anything scheduled for Friday, so it
  // goes at the top of the list rather than quietly off the bottom of it.
  //
  // Orders only. A passed due date on an order means a ball really is still
  // sitting on the bench; a passed appointment is an event that is over --
  // the customer came or they did not. Treating an un-ticked "completed" box
  // as outstanding work would fill this column with every appointment anyone
  // forgot to tick, which is most of the reason it would ever be wrong.
  const late = items
    .filter((i) => i.kind === "order" && !i.done && i.day < today)
    .sort((a, b) => b.day.localeCompare(a.day));

  const ahead = items
    .filter((i) => i.day > today && !i.done)
    .sort((a, b) => (a.day === b.day ? byTime(a, b) : a.day.localeCompare(b.day)));

  const upcoming = [...late, ...ahead];
  drawSchedule(today, todays, upcoming);
  drawTickets(today);

  const open = todays.filter((i) => !i.done).length;
  $("n_sched").textContent = open + upcoming.length;

  drawHeader();
}

// The left column is two blocks. Today is pinned to the top and never pages;
// what is coming rotates underneath it. Today is the reason anyone looks up at
// this screen, so it is the one thing that must still be there when they do.
function drawSchedule(today, todays, upcoming) {
  const pin = $("pin_sched");
  const host = $("schedule");
  pin.innerHTML = "";
  host.innerHTML = "";

  const loaded = lastGood > 0;

  // The heading is earned even by an empty day: "nothing booked today" is a
  // fact worth stating on a wall, not an absence to hide.
  pin.appendChild(sectionRow("Today"));
  if (todays.length) {
    for (const i of todays) pin.appendChild(itemRow(i, today));
  } else {
    pin.appendChild(emptyRow(loaded ? "Nothing booked today." : "Waiting for the first update…"));
  }

  if (upcoming.length) {
    host.appendChild(sectionRow("Coming up"));
    for (const i of upcoming) host.appendChild(itemRow(i, today));
  } else if (loaded && todays.length) {
    host.appendChild(emptyRow(`Nothing else due in the next ${CFG.days} days.`));
  }

  fitPin($("pinbox_sched"), pin);
  startPager(host);
}

// The pinned block takes the height it needs, but never the whole column --
// something has to be left for what is coming. On the rare day that today
// alone overflows its share, the pin pages too: showing six of twelve bookings
// and hiding the rest for ever is worse than rotating them.
function fitPin(box, pin) {
  const empty = pin.children.length === 0;
  box.classList.toggle("hidden", empty);
  if (empty) return stopPager(pin);
  startPager(pin);
}

function sectionRow(label) {
  const el = document.createElement("div");
  el.className = "section";
  el.textContent = label;
  return el;
}

function emptyRow(text) {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  return el;
}

function itemRow(i, today) {
  const el = document.createElement("div");
  el.className = "item";

  const off = daysBetween(today, i.day);
  if (i.done) el.classList.add("done");
  else if (off < 0) el.classList.add("late");
  else if (off === 0) el.classList.add(isNow(i) ? "now" : "duetoday");

  // --- when -------------------------------------------------------------
  // A headline and an optional second line: the clock time for today, how
  // late it is for anything overdue, the weekday for the rest.
  const when = document.createElement("div");
  when.className = "when";

  let head, sub;
  if (off < 0) {
    head = shortDay(i.day);
    sub = `${-off} day${off === -1 ? "" : "s"} late`;
  } else if (i.day === today) {
    head = i.time ? prettyTime(i.time) : "Today";
    sub = i.time ? null : "any time";
  } else {
    head = prettyDay(i.day, today);
    sub = i.time ? prettyTime(i.time) : null;
  }

  when.textContent = head;
  if (!(i.day === today && i.time)) when.classList.add("dayonly");
  if (sub) {
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = sub;
    when.appendChild(s);
  }
  el.appendChild(when);

  // --- who and what -----------------------------------------------------
  const mid = document.createElement("div");

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = i.who;
  if (i.phone) {
    const ph = document.createElement("span");
    ph.className = "phone";
    ph.textContent = i.phone;
    who.appendChild(ph);
  }
  mid.appendChild(who);

  const what = document.createElement("div");
  what.className = "what";
  what.textContent = i.what || "";
  mid.appendChild(what);

  el.appendChild(mid);

  // --- owner, money, house ----------------------------------------------
  const side = document.createElement("div");
  side.className = "side";

  const staffTag = document.createElement("span");
  staffTag.className = "tag " + (i.staff ? "staff" : "nobody");
  staffTag.textContent = i.staff || "unassigned";
  side.appendChild(staffTag);

  // Only worth the ink while it is still owed. A finished, collected job
  // being marked paid is not news to anyone reading a wall.
  if (!i.done) {
    const paid = document.createElement("span");
    paid.className = "tag " + (i.paid ? "paid" : "unpaid");
    paid.textContent = i.paid ? "paid" : "not paid";
    side.appendChild(paid);
  }

  el.appendChild(side);
  return el;
}

function shortDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${DOW[new Date(y, m - 1, d).getDay()].slice(0, 3)} ${m}/${d}`;
}

// Happening around now: from fifteen minutes before the slot to an hour after
// it. That window is what someone glancing up mid-job wants highlighted.
function isNow(i) {
  if (!i.time || i.done) return false;
  const [h, m] = i.time.split(":").map(Number);
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
  return mins >= -15 && mins <= 60;
}

// ---------------------------------------------------------------------------
// Tickets column
//
// A whole column rather than the one-line strip this used to be, so a ticket
// carries the same weight on the wall as a booking does: what it is, who
// raised it, when it is wanted, and whose job it is.
// ---------------------------------------------------------------------------

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function drawTickets(today) {
  const pin = $("pin_tix");
  const host = $("tickets");
  pin.innerHTML = "";
  host.innerHTML = "";

  const open = DATA.tickets
    .filter((t) => t.status !== "done" && here(t.location))
    .sort((a, b) => {
      // Overdue beats urgent beats old, the same order the tickets page uses.
      const al = !!(a.due_date && a.due_date < today);
      const bl = !!(b.due_date && b.due_date < today);
      if (al !== bl) return al ? -1 : 1;

      const ar = PRIORITY_RANK[a.priority] ?? 2;
      const br = PRIORITY_RANK[b.priority] ?? 2;
      if (ar !== br) return ar - br;

      // Then a promised date, then longest wait.
      if (a.due_date && b.due_date && a.due_date !== b.due_date) {
        return a.due_date.localeCompare(b.due_date);
      }
      if (a.due_date && !b.due_date) return -1;
      if (!a.due_date && b.due_date) return 1;
      return (a.submitted_at || "").localeCompare(b.submitted_at || "");
    });

  $("n_tix").textContent = open.length;

  // "Today" on a ticket means three things, and all of them stay put: due
  // today, already past due, or filed as urgent -- the form's own wording for
  // that option is "Urgent — today".
  const now = open.filter((t) =>
    t.priority === "urgent" || (t.due_date && t.due_date <= today));
  const rest = open.filter((t) => !now.includes(t));

  if (now.length) {
    // Matches the left column's heading, so the pinned band reads the same way
    // across both. Accurate enough for an urgent ticket with no date: the
    // form's own label for that option is "Urgent — today".
    pin.appendChild(sectionRow("Today"));
    for (const t of now) pin.appendChild(ticketRow(t, today));
  }

  if (rest.length) {
    // Only worth a divider when there is something above it to divide from.
    if (now.length) host.appendChild(sectionRow("Other open"));
    for (const t of rest) host.appendChild(ticketRow(t, today));
  }

  if (!open.length) {
    host.appendChild(emptyRow(
      lastGood > 0 ? "No open tickets." : "Waiting for the first update…"
    ));
  }

  fitPin($("pinbox_tix"), pin);
  startPager(host);
}

function ticketRow(t, today) {
  const el = document.createElement("div");
  el.className = "item ticket";

  const off = t.due_date ? daysBetween(today, t.due_date) : null;
  if (off !== null && off < 0) el.classList.add("late");
  else if (off === 0) el.classList.add("duetoday");
  else if (t.priority === "urgent") el.classList.add("urgentrow");

  // --- when: the due date if it has one, the priority if it does not ----
  const when = document.createElement("div");
  when.className = "when";
  when.classList.add("dayonly");
  if (off === null) {
    when.textContent = t.priority === "urgent" ? "Urgent" : "—";
    when.classList.add("nodate");
  } else if (off < 0) {
    when.textContent = shortDay(t.due_date);
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `${-off} day${off === -1 ? "" : "s"} late`;
    when.appendChild(sub);
  } else {
    when.textContent = prettyDay(t.due_date, today);
  }
  el.appendChild(when);

  // --- what, and who raised it -----------------------------------------
  const mid = document.createElement("div");

  const title = document.createElement("div");
  title.className = "who";
  title.textContent = t.title;
  mid.appendChild(title);

  if (t.resolution) {
    const note = document.createElement("div");
    note.className = "what note";
    note.textContent = t.resolution;
    mid.appendChild(note);
  }

  el.appendChild(mid);

  // --- owner and priority ------------------------------------------------
  const side = document.createElement("div");
  side.className = "side";

  const who = document.createElement("span");
  who.className = "tag " + (t.assigned_to ? "staff" : "nobody");
  who.textContent = t.assigned_to || "unassigned";
  side.appendChild(who);

  // Normal is the default and says nothing; the other three are worth ink.
  if (t.priority !== "normal") {
    const pri = document.createElement("span");
    pri.className = "tag pri-" + t.priority;
    pri.textContent = t.priority;
    side.appendChild(pri);
  }

  el.appendChild(side);
  return el;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function drawHeader() {
  const n = new Date();
  $("day").textContent = DOW[n.getDay()];
  $("date").textContent = `${MONTHS[n.getMonth()]} ${n.getDate()}`;

  // Which house this screen belongs to. Two identical dark boards in two
  // buildings is how someone ends up working from the wrong one.
  const house = $("house");
  house.textContent = CFG.location || "Both houses";
  house.className = "house" +
    (CFG.location === "Valley" ? " valley"
     : CFG.location === "South Side" ? " south" : "");

  let h = n.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  $("clock").textContent = `${h}:${pad(n.getMinutes())} ${ap}`;

  // Silent while the data is fresh; amber once it is old enough to be wrong.
  const age = lastGood ? Math.round((Date.now() - lastGood) / 60000) : null;
  const stale = $("stale");
  if (age === null) {
    stale.textContent = attempted ? "" : "loading…";
    stale.classList.remove("warn");
  } else if (age >= 5) {
    stale.textContent = `updated ${age} min ago`;
    stale.classList.add("warn");
  } else {
    stale.textContent = "";
    stale.classList.remove("warn");
  }
}

// ---------------------------------------------------------------------------
// Paging
//
// A busy Saturday does not fit on one screen and there is nobody to scroll it.
// The obvious answer is to creep the list along continuously, and it is the
// wrong one: the line you are trying to read is always moving. So the column
// holds a screenful still long enough to read, then flips to the next.
//
// Pages break on item boundaries, never mid-row, and a section heading is
// never left stranded at the foot of a page with its first item overleaf.
// ---------------------------------------------------------------------------

const pagers = new Map();      // host -> { timer }
const pageAt = new Map();      // host -> which page it was on, across redraws

function stopPager(host) {
  const st = pagers.get(host);
  if (st) clearInterval(st.timer);
  pagers.delete(host);
  host.style.transform = "";
  host.parentElement.classList.remove("paged");
  const ind = document.getElementById(host.dataset.pager);
  if (ind) ind.textContent = "";
}

function startPager(host) {
  stopPager(host);
  if (!CFG.rotate) return;

  // Measured synchronously, not inside requestAnimationFrame. The rows were
  // just appended, so reading offsetTop forces the layout we need right here --
  // and rAF does not fire at all while the document is hidden, which on a Pi
  // means every redraw with the screen asleep would stop the paging and never
  // start it again. stopPager above has already cleared the transform, so
  // these offsets are read against an untransformed list.
  const pane = host.parentElement;
  const height = pane.clientHeight;
  if (!height || host.scrollHeight <= height + 4) return;   // it all fits

  const pages = pageOffsets(host, height);
  if (pages.length < 2) return;

  const ind = document.getElementById(host.dataset.pager);

  // Carry the page across a redraw. Without this the 60-second poll would
  // yank every column back to page one, and a third page would be seen only
  // by someone watching at the right moment.
  let i = Math.min(pageAt.get(host) || 0, pages.length - 1);

  const show = () => {
    host.style.transform = `translateY(${-pages[i]}px)`;
    pageAt.set(host, i);
    if (ind) ind.textContent = `${i + 1}/${pages.length}`;
  };
  show();

  pane.classList.add("paged");

  const timer = setInterval(() => {
    i = (i + 1) % pages.length;
    show();
  }, CFG.page);

  pagers.set(host, { timer });
}

// The y offset of the top of each page.
function pageOffsets(host, height) {
  const kids = [...host.children];
  const offsets = [0];
  let top = 0;

  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    const bottom = el.offsetTop + el.offsetHeight;

    // This row would hang off the bottom, so it starts the next page instead.
    if (bottom - top > height && el.offsetTop > top) {
      let start = i;
      // A heading whose first row went overleaf is worse than a shorter page.
      if (i > 0 && kids[i - 1].classList.contains("section")) start = i - 1;

      const nextTop = kids[start].offsetTop;
      if (nextTop <= top) continue;   // one row taller than the pane; let it ride
      top = nextTop;
      offsets.push(top);
    }
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

// The header ticks every second so the clock is a clock. Cheap: it touches
// three text nodes.
setInterval(drawHeader, 1000);

setInterval(poll, CFG.refresh);

// Midnight rollover. The board is left running for months, so "today" has to
// change without anyone touching it -- and the whole page is redrawn rather
// than just re-polled, because every relative label on screen ("Tomorrow",
// "2 days late") is now wrong.
setInterval(() => {
  const now = todayIso();
  if (now !== currentDay) {
    currentDay = now;
    poll();
  }
}, 30000);

// A browser left open for six months on a 1GB Pi will eventually misbehave in
// ways no amount of care in this file prevents. Reloading in the small hours
// is the cheap insurance, and also picks up any deploy since yesterday.
setInterval(() => {
  const n = new Date();
  if (n.getHours() === 3 && n.getMinutes() < 2) location.reload();
}, 60000);

// Coming back from a suspended display or a dropped network should refresh
// immediately rather than waiting out the poll interval.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
window.addEventListener("online", poll);

// A resized window changes how many rows fit, so the pages have to be rebuilt.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 250);
});

document.title = (CFG.location ? CFG.location + " — " : "") +
  "Day Board — Perfexxxxion Pro Shop";

drawHeader();
poll();
