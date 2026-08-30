// Appointments calendar.
//
// Dates here are plain calendar days, never instants. `new Date("2026-08-30")`
// parses as UTC midnight, which in any negative-offset timezone renders as the
// 29th -- so every appointment would sit one cell to the left. Nothing in this
// file passes a date string to the Date constructor; days are carried as
// {y, m, d} integers and formatted by hand.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];

const $ = (id) => document.getElementById(id);

let view = { y: 0, m: 0 };   // month on screen (m is 0-based)
let APPTS = [];              // appointments covering the visible grid
let editing = null;          // the appointment open in the dialog, if any

// ---------------------------------------------------------------------------
// Date helpers -- all local, all string-based
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

function todayParts() {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
}

function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();   // day 0 of next month
}

function firstWeekday(y, m) {
  return new Date(y, m, 1).getDay();        // 0 = Sunday
}

// Six rows of seven, starting on the Sunday on or before the 1st. Always 42
// cells so the grid does not change height month to month.
function gridDays(y, m) {
  const out = [];
  const lead = firstWeekday(y, m);
  const prevLen = daysInMonth(y, m === 0 ? 11 : m - 1);

  for (let i = lead - 1; i >= 0; i--) {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    out.push({ y: py, m: pm, d: prevLen - i, outside: true });
  }
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    out.push({ y, m, d, outside: false });
  }
  let n = 1;
  while (out.length < 42) {
    const nm = m === 11 ? 0 : m + 1;
    const ny = m === 11 ? y + 1 : y;
    out.push({ y: ny, m: nm, d: n++, outside: true });
  }
  return out;
}

function prettyTime(t) {
  if (!t) return "";
  const [hStr, min] = t.split(":");
  let h = Number(hStr);
  const ampm = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return min === "00" ? `${h}${ampm}` : `${h}:${min}${ampm}`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function load() {
  $("error").classList.add("hidden");
  const days = gridDays(view.y, view.m);
  const from = iso(days[0].y, days[0].m, days[0].d);
  const to = iso(days[41].y, days[41].m, days[41].d);

  try {
    APPTS = await db.selectAll(
      "appointments",
      `select=*&deleted_at=is.null` +
        `&appt_date=gte.${from}&appt_date=lte.${to}` +
        `&order=appt_date.asc,appt_time.asc.nullsfirst`
    );
    render();
  } catch (err) {
    $("error").textContent = String(err.message || err);
    $("error").classList.remove("hidden");
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  $("monthlabel").textContent = `${MONTHS[view.m]} ${view.y}`;

  const loc = $("location").value;
  const shown = loc ? APPTS.filter((a) => a.location === loc) : APPTS;

  const byDay = new Map();
  for (const a of shown) {
    if (!byDay.has(a.appt_date)) byDay.set(a.appt_date, []);
    byDay.get(a.appt_date).push(a);
  }

  const grid = $("grid");
  grid.innerHTML = "";
  for (const label of DOW) {
    const h = document.createElement("div");
    h.className = "dow";
    h.textContent = label;
    grid.appendChild(h);
  }

  const t = todayParts();
  let inMonth = 0;

  for (const day of gridDays(view.y, view.m)) {
    const key = iso(day.y, day.m, day.d);
    const list = byDay.get(key) || [];
    if (!day.outside) inMonth += list.length;

    const cell = document.createElement("div");
    cell.className = "day";
    if (day.outside) cell.classList.add("outside");
    if (!list.length) cell.classList.add("empty-day");
    if (day.y === t.y && day.m === t.m && day.d === t.d) cell.classList.add("today");
    cell.dataset.date = key;

    // Two labels: the grid supplies the weekday from its column, the phone
    // agenda has no columns and needs the weekday spelled out. CSS picks one.
    const num = document.createElement("div");
    num.className = "daynum";
    const short = document.createElement("span");
    short.className = "dnum";
    short.textContent = day.d;
    const full = document.createElement("span");
    full.className = "dfull";
    full.textContent = `${DOW[new Date(day.y, day.m, day.d).getDay()]} ${day.m + 1}/${day.d}`;
    num.append(short, full);
    cell.appendChild(num);

    const wrap = document.createElement("div");
    wrap.className = "appts";
    for (const a of list) wrap.appendChild(apptChip(a));
    cell.appendChild(wrap);

    cell.addEventListener("click", (e) => {
      if (e.target.closest(".appt")) return;   // chip handles its own click
      openDialog(null, key);
    });

    grid.appendChild(cell);
  }

  $("count").textContent = inMonth
    ? `${inMonth} appointment${inMonth === 1 ? "" : "s"} this month`
    : "No appointments this month";
}

function apptChip(a) {
  const el = document.createElement("div");
  el.className = "appt";
  if (a.location === "Valley") el.classList.add("valley");
  else if (a.location === "South Side") el.classList.add("south");
  if (a.completed) el.classList.add("done");

  const time = prettyTime(a.appt_time);
  el.innerHTML =
    (time ? `<span class="t">${time}</span> ` : "") +
    `<span class="n"></span>`;
  el.querySelector(".n").textContent = a.customer_name;
  el.title = [a.customer_name, time, a.location, a.service]
    .filter(Boolean).join(" · ");

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    openDialog(a, a.appt_date);
  });
  return el;
}

// ---------------------------------------------------------------------------
// Add / edit dialog
// ---------------------------------------------------------------------------

function openDialog(appt, dateStr) {
  editing = appt;
  $("dlgtitle").textContent = appt ? "Edit appointment" : "New appointment";
  $("f_delete").classList.toggle("hidden", !appt);

  $("f_name").value = appt ? appt.customer_name : "";
  $("f_date").value = appt ? appt.appt_date : dateStr;
  $("f_time").value = appt && appt.appt_time ? appt.appt_time.slice(0, 5) : "";
  $("f_location").value = appt ? appt.location || "" : "";
  $("f_service").value = appt ? appt.service : "";
  $("f_phone").value = appt ? appt.phone || "" : "";
  $("f_completed").checked = appt ? appt.completed : false;

  $("dlg").showModal();
  $("f_name").focus();
}

async function save(e) {
  e.preventDefault();
  const row = {
    customer_name: $("f_name").value.trim(),
    appt_date: $("f_date").value,
    appt_time: $("f_time").value || null,
    location: $("f_location").value || null,
    service: $("f_service").value.trim(),
    phone: $("f_phone").value.trim() || null,
    completed: $("f_completed").checked,
  };
  if (!row.customer_name || !row.appt_date || !row.service) return;

  const btn = $("f_save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    if (editing) await db.update("appointments", `id=eq.${editing.id}`, row);
    else await db.insert("appointments", row);
    $("dlg").close();
    await load();
  } catch (err) {
    $("error").textContent = String(err.message || err);
    $("error").classList.remove("hidden");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function remove() {
  if (!editing) return;
  if (!confirm(`Delete this appointment?\n\n${editing.customer_name} — ${editing.service}\n\nIt is hidden, not erased.`)) return;
  try {
    await db.softDelete("appointments", editing.id);
    $("dlg").close();
    await load();
  } catch (err) {
    $("error").textContent = String(err.message || err);
    $("error").classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function step(delta) {
  let m = view.m + delta;
  let y = view.y;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  view = { y, m };
  load();
}

$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("today").addEventListener("click", () => {
  const t = todayParts();
  view = { y: t.y, m: t.m };
  load();
});
$("location").addEventListener("change", render);
$("add").addEventListener("click", () => {
  const t = todayParts();
  openDialog(null, iso(t.y, t.m, t.d));
});
$("apptform").addEventListener("submit", save);
$("f_cancel").addEventListener("click", () => $("dlg").close());
$("f_delete").addEventListener("click", remove);

document.addEventListener("keydown", (e) => {
  if ($("dlg").open) return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

(function init() {
  const t = todayParts();
  view = { y: t.y, m: t.m };
  load();
})();
