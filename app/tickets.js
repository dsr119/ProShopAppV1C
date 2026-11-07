// Ticket queue.
//
// Staff (and the voice bot) send tickets from ticket.html; this page is where
// they get worked. Every open ticket sits in one queue -- there is no separate
// review step -- sorted overdue, then urgent, then longest wait.
//
// Assignment is a name, not an id. See migration/add_staff_and_tickets.sql --
// the roster supplies the spelling, it does not own the history.

const $ = (id) => document.getElementById(id);

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_LABEL = {
  new: "New",
  assigned: "Assigned",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

let TICKETS = [];
let view = "queue";
// Linked appointments by ticket id, soonest first. Empty until the
// add_ticket_plug_and_schedule.sql migration has been run.
let TICKET_APPTS = {};

// Plug work moves through three states, one button press each.
const PLUG_STEPS = [
  { key: "prepped",   label: "Prepped" },
  { key: "at_keiths", label: "At Keiths" },
  { key: "plugged",   label: "Plugged in shop" },
];
const PLUG_LABEL = Object.fromEntries(PLUG_STEPS.map((p) => [p.key, p.label]));

// "Plug thumb", "plug and redrill", "plugged" -- any ticket that mentions it.
function isPlugWork(t) {
  return !!t.plug_state || /\bplug/i.test(`${t.title || ""}\n${t.details || ""}`);
}

function nextPlugStep(t) {
  const i = PLUG_STEPS.findIndex((p) => p.key === t.plug_state);
  return PLUG_STEPS[i + 1] || null;
}
let editing = null;

function showError(err) {
  $("error").textContent = String(err && err.message ? err.message : err);
  $("error").classList.remove("hidden");
  console.error(err);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function load() {
  $("error").classList.add("hidden");
  try {
    TICKETS = await db.selectAll(
      "tickets",
      "select=*&deleted_at=is.null&order=submitted_at.desc"
    );
    await loadTicketAppts();
    render();
  } catch (err) {
    showError(err);
  }
}

async function loadTicketAppts() {
  const map = {};
  try {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const rows = await db.selectAll(
      "appointments",
      `select=id,ticket_id,appt_date,appt_time,location&deleted_at=is.null` +
        `&ticket_id=not.is.null&appt_date=gte.${iso}&order=appt_date.asc,appt_time.asc.nullsfirst`
    );
    for (const a of rows) (map[a.ticket_id] ||= []).push(a);
  } catch (err) {
    // Before the migration there is no ticket_id column. Tickets still work;
    // they just cannot show "Scheduled".
    console.warn("Ticket appointments unavailable:", err);
  }
  TICKET_APPTS = map;
}

async function loadAssignees() {
  try {
    const sel = $("assignee");
    for (const name of await staff.names()) {
      const o = document.createElement("option");
      o.value = o.textContent = name;
      sel.appendChild(o);
    }
  } catch (err) {
    console.error("Could not load the staff roster:", err);
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function inView(t, which) {
  if (which === "queue") return t.status !== "done";
  if (which === "done") return t.status === "done";
  return true;
}

function visible() {
  const q = $("search").value.trim().toLowerCase();
  const who = $("assignee").value;
  const pri = $("priority").value;

  return TICKETS.filter((t) => {
    if (!inView(t, view)) return false;
    if (pri && t.priority !== pri) return false;
    if (who === "__none__" && t.assigned_to) return false;
    if (who && who !== "__none__" && t.assigned_to !== who) return false;
    if (q) {
      const hay = [t.title, t.details, t.submitted_by, t.assigned_to,
                   t.category, t.resolution].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort(byUrgency);
}

// Overdue beats urgent beats old. A ticket whose promised date has passed is
// the shop's most immediate problem regardless of what it was filed as.
function byUrgency(a, b) {
  const ao = overdueDays(a), bo = overdueDays(b);
  if ((ao > 0) !== (bo > 0)) return ao > 0 ? -1 : 1;

  const ar = PRIORITY_RANK[a.priority] ?? 2;
  const br = PRIORITY_RANK[b.priority] ?? 2;
  if (ar !== br) return ar - br;

  // Done work reads newest first -- nobody scrolls a finished list for the
  // oldest thing. Everything else reads oldest first: longest wait on top.
  if (view === "done") return (b.submitted_at || "").localeCompare(a.submitted_at || "");
  return (a.submitted_at || "").localeCompare(b.submitted_at || "");
}

// ---------------------------------------------------------------------------
// Dates -- plain calendar days, never instants. As in appointments.js, a due
// date must not go through the Date constructor as a string.
// ---------------------------------------------------------------------------

function shortDate(v) {
  if (!v) return "";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

function overdueDays(t) {
  if (!t.due_date || t.status === "done") return -1;
  const [y, m, d] = t.due_date.split("-").map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - new Date(y, m - 1, d)) / 86400000);
}

// How long ago, in the coarsest unit that is still true.
function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return shortDate(iso);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const rows = visible();
  const list = $("list");
  list.innerHTML = "";
  for (const t of rows) list.appendChild(card(t));

  $("empty").classList.toggle("hidden", rows.length > 0);
  $("empty").textContent = {
    queue: "Nothing in the queue.",
    done: "Nothing finished yet.",
    all: "No tickets.",
  }[view];

  // Tab counts are of the whole queue, not the filtered view -- the point of
  // the number is to be true when you are looking at another tab.
  $("n_queue").textContent = TICKETS.filter((t) => inView(t, "queue")).length;

  const late = TICKETS.filter((t) => overdueDays(t) > 0).length;
  $("count").textContent =
    `${rows.length} shown` + (late ? ` · ${late} overdue` : "");
}

function card(t) {
  const el = document.createElement("article");
  el.className = "ticket st-" + t.status;
  const late = overdueDays(t);
  if (late > 0) el.classList.add("late");
  if (t.priority === "urgent" && t.status !== "done") el.classList.add("urgent");

  // --- top line: priority, title, status -------------------------------
  const head = document.createElement("div");
  head.className = "thead";

  const pri = document.createElement("span");
  pri.className = "badge pri-" + t.priority;
  pri.textContent = t.priority;

  const title = document.createElement("span");
  title.className = "ttitle";
  title.textContent = t.title;

  const status = document.createElement("span");
  status.className = "badge stat-" + t.status;
  status.textContent = STATUS_LABEL[t.status] || t.status;

  head.append(pri, title);
  if (t.plug_state) {
    const plug = document.createElement("span");
    plug.className = "badge plug plug-" + t.plug_state;
    plug.textContent = PLUG_LABEL[t.plug_state];
    head.appendChild(plug);
  }
  head.appendChild(status);
  el.appendChild(head);

  // --- details, if any --------------------------------------------------
  if (t.details) {
    const d = document.createElement("p");
    d.className = "tdetails";
    d.textContent = t.details;
    el.appendChild(d);
  }

  // --- meta line ---------------------------------------------------------
  const meta = document.createElement("div");
  meta.className = "tmeta";
  const bits = [
    `${t.submitted_by} · ${ago(t.submitted_at)}`,
    t.category,
    t.location,
  ].filter(Boolean);
  for (const b of bits) {
    const s = document.createElement("span");
    s.textContent = b;
    meta.appendChild(s);
  }
  if (t.due_date) {
    const due = document.createElement("span");
    due.className = late > 0 ? "due late" : (late === 0 ? "due today" : "due");
    due.textContent =
      late > 0 ? `due ${shortDate(t.due_date)} — ${late}d late`
      : late === 0 ? "due today"
      : `due ${shortDate(t.due_date)}`;
    meta.appendChild(due);
  }
  const booked = (TICKET_APPTS[t.id] || [])[0];
  if (booked) {
    const s = document.createElement("span");
    s.className = "booked";
    s.textContent = `Scheduled ${apptWhen(booked)}`;
    meta.appendChild(s);
  }
  el.appendChild(meta);

  // --- assign, inline. Reviewing a queue means assigning without opening
  // every ticket, so the dropdown lives on the card. -------------------
  const foot = document.createElement("div");
  foot.className = "tfoot";

  const assign = document.createElement("select");
  assign.className = "assign";
  staff.fillSelect(assign, t.assigned_to).catch(showError);
  assign.addEventListener("change", () => assignTo(t, assign));
  foot.appendChild(assign);

  // Plug work: one press moves it to the next state.
  if (isPlugWork(t) && t.status !== "done") {
    const step = nextPlugStep(t);
    if (step) {
      const plug = document.createElement("button");
      plug.className = "plugbtn";
      plug.textContent = step.label;
      plug.title = t.plug_state
        ? `Now: ${PLUG_LABEL[t.plug_state]}. Press when it is ${step.label.toLowerCase()}.`
        : "Press when the ball is prepped for the plug.";
      plug.addEventListener("click", () => patch(t, plug, { plug_state: step.key }));
      foot.appendChild(plug);
    }
  }

  if (t.status !== "done") {
    const sch = document.createElement("button");
    sch.textContent = "Schedule";
    sch.addEventListener("click", () => openScheduler(t));
    foot.appendChild(sch);
  }

  if (t.status !== "done") {
    const done = document.createElement("button");
    done.textContent = "Mark done";
    done.addEventListener("click", () => patch(t, done, {
      status: "done",
      completed_at: new Date().toISOString(),
    }));
    foot.appendChild(done);
  } else {
    const reopen = document.createElement("button");
    reopen.textContent = "Reopen";
    reopen.addEventListener("click", () => patch(t, reopen, {
      status: t.assigned_to ? "assigned" : "new",
      completed_at: null,
    }));
    foot.appendChild(reopen);
  }

  const open = document.createElement("button");
  open.textContent = "Edit";
  open.addEventListener("click", () => openDialog(t));
  foot.appendChild(open);

  el.appendChild(foot);
  return el;
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

async function patch(t, btn, changes) {
  const label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    await db.update("tickets", `id=eq.${t.id}`, changes);
    Object.assign(t, changes);
    render();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    showError(migrationHint(err));
  }
}

// The one error worth translating: the plug column does not exist until the
// migration has been run.
function migrationHint(err) {
  return /plug_state|ticket_id/i.test(String(err && err.message ? err.message : err))
    ? new Error("The database needs migration/add_ticket_plug_and_schedule.sql run in Supabase first.")
    : err;
}

// Assigning is also a review decision: a ticket that has been handed to
// someone is no longer sitting in the "to review" queue, so the status moves
// with it. Unassigning a ticket nobody has started puts it back.
async function assignTo(t, sel) {
  const name = sel.value || null;
  const before = { assigned_to: t.assigned_to, status: t.status, assigned_at: t.assigned_at };

  const changes = { assigned_to: name, assigned_at: name ? new Date().toISOString() : null };
  if (name && t.status === "new") changes.status = "assigned";
  if (!name && t.status === "assigned") changes.status = "new";

  sel.disabled = true;
  try {
    await db.update("tickets", `id=eq.${t.id}`, changes);
    Object.assign(t, changes);
    render();
  } catch (err) {
    Object.assign(t, before);
    sel.value = before.assigned_to || "";
    showError(err);
  } finally {
    sel.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

// Tickets keep the customer at the top of the details as "Customer: ..." and
// "Phone: ..." lines (the form and the voice bot both write it that way).
// The edit dialog shows those as their own fields and the rest as details.
function splitDetails(details) {
  let rest = details || "";
  const name = (/^Customer:[ \t]*(.*)$/m.exec(rest) || [])[1] || "";
  const phone = (/^Phone:[ \t]*(.*)$/m.exec(rest) || [])[1] || "";
  rest = rest.replace(/^Customer:.*(\r?\n|$)/m, "").replace(/^Phone:.*(\r?\n|$)/m, "");
  return { name: name.trim(), phone: phone.trim(), rest: rest.trim() };
}

function joinDetails(name, phone, rest) {
  const contact = name
    ? `Customer: ${name}${phone ? `\nPhone: ${phone}` : ""}`
    : phone ? `Phone: ${phone}` : "";
  return [contact, rest].filter(Boolean).join("\n\n") || null;
}

// A value the dropdown does not list (an old or voice-made ticket) still has
// to show, or saving would quietly blank it.
function setSelect(sel, value) {
  value = value || "";
  if (value && ![...sel.options].some((o) => o.value === value)) {
    const o = document.createElement("option");
    o.value = o.textContent = value;
    sel.appendChild(o);
  }
  sel.value = value;
}

function openDialog(t) {
  editing = t;
  $("t_meta").textContent =
    [`from ${t.submitted_by}`, ago(t.submitted_at)].filter(Boolean).join(" · ");

  const parts = splitDetails(t.details);
  editing.parts = parts;
  $("t_title").value = t.title || "";
  $("t_customer").value = parts.name;
  $("t_phone").value = parts.phone;
  $("t_details").value = parts.rest;
  setSelect($("t_location"), t.location);
  setSelect($("t_category"), t.category);

  $("t_status").value = t.status;
  $("t_priority").value = t.priority;
  $("t_due").value = t.due_date || "";
  $("t_resolution").value = t.resolution || "";
  $("t_plug").value = t.plug_state || "";
  $("t_plugwrap").classList.toggle("hidden", !isPlugWork(t));

  staff.fillSelect($("t_staff"), t.assigned_to)
    .catch((err) => console.error("Could not load the staff roster:", err));

  $("dlg").showModal();
}

async function saveDialog(e) {
  e.preventDefault();
  if (!editing) return;

  const name = $("t_staff").value || null;
  const status = $("t_status").value;

  const title = $("t_title").value.trim();
  if (!title) {
    $("t_title").focus();
    return showError(new Error("A ticket needs a one-line summary."));
  }

  const changes = {
    title,
    location: $("t_location").value || null,
    category: $("t_category").value || null,
    assigned_to: name,
    status,
    priority: $("t_priority").value,
    due_date: $("t_due").value || null,
    resolution: $("t_resolution").value.trim() || null,
    // Stamp the first assignment; do not keep re-stamping an existing one.
    assigned_at: name ? (editing.assigned_at || new Date().toISOString()) : null,
    completed_at: status === "done"
      ? (editing.completed_at || new Date().toISOString())
      : null,
  };

  // Rewrite the details only if something in them changed, so an untouched
  // ticket keeps exactly what was typed.
  const cust = $("t_customer").value.trim();
  const phone = $("t_phone").value.trim();
  const rest = $("t_details").value.trim();
  const p = editing.parts || splitDetails(editing.details);
  if (cust !== p.name || phone !== p.phone || rest !== p.rest) {
    changes.details = joinDetails(cust, phone, rest);
  }

  // Only send plug_state when it changed, so saving a ticket still works
  // before the migration has been run.
  const plug = $("t_plug").value || null;
  if (plug !== (editing.plug_state || null)) changes.plug_state = plug;

  const btn = $("t_save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await db.update("tickets", `id=eq.${editing.id}`, changes);
    Object.assign(editing, changes);
    delete editing.parts;
    customers.invalidate();
    $("dlg").close();
    render();
  } catch (err) {
    showError(migrationHint(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function removeTicket() {
  if (!editing) return;
  if (!confirm(`Delete this ticket?\n\n${editing.title}\n\nIt is hidden, not erased.`)) return;
  try {
    await db.softDelete("tickets", editing.id);
    TICKETS = TICKETS.filter((t) => t.id !== editing.id);
    $("dlg").close();
    render();
  } catch (err) {
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Scheduler -- the same one-week strip as the Drilling page.
//
// Days are {y, m, d} integers and never go through the Date constructor as a
// string -- new Date("2026-08-30") is UTC midnight and renders as the 29th.
// ---------------------------------------------------------------------------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let sched = { ticket: null, weekStart: null, picked: null, appts: [] };

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function prettyTime(t) {
  if (!t) return "";
  const [hs, mm] = t.split(":");
  let h = Number(hs);
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return mm === "00" ? `${h}${ap}` : `${h}:${mm}${ap}`;
}

function apptWhen(a) {
  const [y, m, d] = a.appt_date.split("-").map(Number);
  const day = DOW[new Date(y, m - 1, d).getDay()];
  return `${day} ${m}/${d}` + (a.appt_time ? ` ${prettyTime(a.appt_time)}` : "");
}

// Who the ticket is for. Tickets keep the customer in the details as
// "Customer: ..." and "Phone: ..." lines (the form and the voice bot both
// write it that way); voice tickets also title themselves "Name - job".
function ticketCustomer(t) {
  const d = t.details || "";
  const name = (/^Customer:[ \t]*(.+)$/m.exec(d) || [])[1];
  const phone = (/^Phone:[ \t]*(.+)$/m.exec(d) || [])[1];
  const dash = (t.title || "").split(" - ");
  return {
    name: (name || (dash.length > 1 ? dash[0] : "")).trim(),
    phone: (phone || "").trim(),
    job: (dash.length > 1 && name ? dash.slice(1).join(" - ") : t.title || "").trim(),
  };
}

function openScheduler(t) {
  const today = new Date();
  const c = ticketCustomer(t);
  sched.ticket = t;
  sched.weekStart = startOfWeek(today);
  sched.picked = isoOf(today);

  $("s_name").value = c.name;
  $("s_phone").value = c.phone;
  $("s_service").value = c.job;
  $("s_location").value = t.location === "Both" ? "" : (t.location || "");
  $("s_time").value = "";

  $("scheddlg").showModal();
  loadWeek();
}

async function loadWeek() {
  const days = weekDays(sched.weekStart);
  const from = isoOf(days[0]);
  const to = isoOf(days[6]);
  $("s_weeklabel").textContent =
    `${MON[days[0].getMonth()]} ${days[0].getDate()} – ${MON[days[6].getMonth()]} ${days[6].getDate()}`;
  try {
    sched.appts = await db.selectAll(
      "appointments",
      `select=customer_name,service,location,appt_date,appt_time&deleted_at=is.null` +
        `&appt_date=gte.${from}&appt_date=lte.${to}` +
        `&order=appt_time.asc.nullsfirst`
    );
  } catch (err) {
    sched.appts = [];
    showError(err);
  }
  renderWeek();
}

function renderWeek() {
  const strip = $("s_strip");
  strip.innerHTML = "";
  const todayIso = isoOf(new Date());
  const counts = {};
  for (const a of sched.appts) counts[a.appt_date] = (counts[a.appt_date] || 0) + 1;

  for (const d of weekDays(sched.weekStart)) {
    const key = isoOf(d);
    const n = counts[key] || 0;
    const cell = document.createElement("div");
    cell.className = "wday";
    if (key === todayIso) cell.classList.add("today");
    if (key === sched.picked) cell.classList.add("selected");
    if (n >= 4) cell.classList.add("busy");
    cell.innerHTML =
      `<div class="wd-dow">${DOW[d.getDay()]}</div>` +
      `<div class="wd-num">${d.getDate()}</div>` +
      `<div class="wd-count">${n ? n : ""}</div>`;
    cell.title = n ? `${n} appointment${n === 1 ? "" : "s"}` : "Nothing booked";
    cell.addEventListener("click", () => { sched.picked = key; renderWeek(); });
    strip.appendChild(cell);
  }
  renderDayList();
}

function renderDayList() {
  const list = $("s_dayappts");
  list.innerHTML = "";
  const onDay = sched.appts.filter((a) => a.appt_date === sched.picked);
  const [y, m, d] = sched.picked.split("-").map(Number);
  const when = new Date(y, m - 1, d);
  $("s_picked").textContent = `${DOW[when.getDay()]} ${m}/${d}` +
    (onDay.length ? ` · ${onDay.length} booked` : " · nothing booked");

  if (!onDay.length) {
    list.innerHTML = '<div class="none">Nothing booked this day.</div>';
    return;
  }
  for (const a of onDay) {
    const row = document.createElement("div");
    row.className = "dayrow";
    const tm = document.createElement("span");
    tm.className = "t";
    tm.textContent = prettyTime(a.appt_time) || "—";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = a.customer_name;
    const svc = document.createElement("span");
    svc.className = "svc";
    svc.textContent = a.service || "";
    row.append(tm, who, svc);
    if (a.location) {
      const loc = document.createElement("span");
      loc.className = "loc" + (a.location === "South Side" ? " south" : "");
      loc.textContent = a.location;
      row.appendChild(loc);
    }
    list.appendChild(row);
  }
}

function stepWeek(delta) {
  const [y, m, d] = sched.picked.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const s = sched.weekStart;
  sched.weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() + delta * 7);
  sched.picked = isoOf(weekDays(sched.weekStart)[dow]);
  loadWeek();
}

async function bookAppointment(e) {
  e.preventDefault();
  const t = sched.ticket;
  const row = {
    ticket_id: t.id,
    customer_name: $("s_name").value.trim(),
    phone: $("s_phone").value.trim() || null,
    service: $("s_service").value.trim(),
    location: $("s_location").value || null,
    appt_date: sched.picked,
    appt_time: $("s_time").value || null,
    completed: false,
    staff_member: t.assigned_to || null,
    paid: false,
  };
  if (!row.customer_name || !row.service) return;

  const btn = $("s_save");
  btn.disabled = true;
  btn.textContent = "Booking…";
  try {
    try {
      await db.insert("appointments", row);
    } catch (err) {
      // Before the migration there is no ticket_id column: book it anyway,
      // just without the link back to the ticket.
      if (!/ticket_id/i.test(String(err && err.message ? err.message : err))) throw err;
      delete row.ticket_id;
      await db.insert("appointments", row);
    }
    $("scheddlg").close();
    await loadTicketAppts();
    render();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Book it";
  }
}

$("s_prev").addEventListener("click", () => stepWeek(-1));
$("s_next").addEventListener("click", () => stepWeek(1));
$("s_thisweek").addEventListener("click", () => {
  sched.weekStart = startOfWeek(new Date());
  sched.picked = isoOf(new Date());
  loadWeek();
});
$("s_cancel").addEventListener("click", () => $("scheddlg").close());
$("schedform").addEventListener("submit", bookAppointment);
customers.attach("s_name", "s_phone");
customers.attach("t_customer", "t_phone");

// ---------------------------------------------------------------------------
// Staff roster editor
//
// Removal is deactivation, never a delete: a name that vanished would take
// with it the record of who did last winter's work.
// ---------------------------------------------------------------------------

async function renderStaff() {
  const list = $("stafflist");
  list.innerHTML = "";

  let rows;
  try {
    rows = await staff.list(true);
  } catch (err) {
    return showError(err);
  }

  if (!rows.length) {
    list.innerHTML = '<div class="none">Nobody on the roster yet.</div>';
    return;
  }

  rows.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "staffrow" + (s.active ? "" : " off");

    const name = document.createElement("input");
    name.type = "text";
    name.value = s.name;
    name.addEventListener("change", async () => {
      const next = name.value.trim();
      if (!next || next === s.name) return (name.value = s.name);
      try {
        await staff.rename(s.id, next);
        s.name = next;
      } catch (err) {
        name.value = s.name;
        // The unique index is on live names only, so this is the one error
        // worth translating -- "409" tells nobody anything.
        showError(/23505|duplicate/i.test(String(err))
          ? new Error(`There is already someone called “${next}” on the roster.`)
          : err);
      }
    });

    // Order matters because the assign dropdowns use it: whoever picks up
    // most of the work should be the first name in every list, not whoever
    // happens to come first in the alphabet.
    const up = document.createElement("button");
    up.type = "button";
    up.className = "ord";
    up.textContent = "↑";
    up.title = "Move up the assign lists";
    up.disabled = i === 0;
    up.addEventListener("click", () => move(rows, i, -1, up));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "ord";
    down.textContent = "↓";
    down.title = "Move down the assign lists";
    down.disabled = i === rows.length - 1;
    down.addEventListener("click", () => move(rows, i, 1, down));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = s.active ? "Remove" : "Bring back";
    toggle.title = s.active
      ? "Takes the name out of the assign lists. Past work keeps it."
      : "Puts the name back in the assign lists.";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await staff.setActive(s.id, !s.active);
        await renderStaff();
      } catch (err) {
        toggle.disabled = false;
        showError(err);
      }
    });

    row.append(name, up, down, toggle);
    list.appendChild(row);
  });
}

// Swapping two neighbours is not enough on its own: the seed left every
// sort_order NULL, so there is nothing to swap. Renumbering the whole list
// from its current on-screen order makes the first move work like the
// hundredth, with no separate "initialise the ordering" step to forget.
async function move(rows, index, delta, btn) {
  const next = index + delta;
  if (next < 0 || next >= rows.length) return;

  const reordered = rows.slice();
  [reordered[index], reordered[next]] = [reordered[next], reordered[index]];

  btn.disabled = true;
  try {
    await Promise.all(reordered.map((s, i) =>
      s.sort_order === i ? null : staff.setOrder(s.id, i)
    ));
    await renderStaff();
  } catch (err) {
    btn.disabled = false;
    showError(err);
  }
}

async function addStaff() {
  const name = $("s_new").value.trim();
  if (!name) return;
  const btn = $("s_add");
  btn.disabled = true;
  try {
    await staff.add(name);
    $("s_new").value = "";
    await renderStaff();
  } catch (err) {
    showError(/23505|duplicate/i.test(String(err))
      ? new Error(`“${name}” is already on the roster.`)
      : err);
  } finally {
    btn.disabled = false;
    $("s_new").focus();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 150);
});
$("assignee").addEventListener("change", render);
$("priority").addEventListener("change", render);

$("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  view = tab.dataset.view;
  for (const b of $("tabs").querySelectorAll(".tab")) b.classList.toggle("on", b === tab);
  render();
});

$("ticketform").addEventListener("submit", saveDialog);
$("t_cancel").addEventListener("click", () => $("dlg").close());
$("t_delete").addEventListener("click", removeTicket);

$("managestaff").addEventListener("click", async () => {
  await renderStaff();
  $("staffdlg").showModal();
});
$("s_add").addEventListener("click", addStaff);
$("s_new").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addStaff(); }
});
$("s_close").addEventListener("click", () => {
  $("staffdlg").close();
  // A renamed or retired person changes every dropdown on the page.
  render();
});

(async function init() {
  loadAssignees();
  await load();
})();
