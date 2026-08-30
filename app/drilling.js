// Drilling queue.
//
// Customer orders waiting to be drilled: shop stock excluded, and only rows
// that carry a customer name. Scoped to the current quarter plus anything not
// ordered yet, because a ball from 2025 is not work anyone is still waiting
// on -- the quarter picker is there for the days right after a quarter rolls
// over, when the balls still on the bench were ordered under the old one.

const $ = (id) => document.getElementById(id);

let ROWS = [];

const COLUMNS =
  "id,customer_name,is_stock,phone,item,pickup_location,order_location," +
  "shop_order_date,submitted_at,drilled,drilled_at,no_drill_needed," +
  "out_the_door,paid,notes,quarter";

// Names that mean "no customer", so the row is shop stock by another route.
const NOT_A_CUSTOMER = new Set(["", "stock", "unknown", "shop", "shop stock"]);

function showError(err) {
  $("error").textContent = String(err && err.message ? err.message : err);
  $("error").classList.remove("hidden");
  console.error(err);
}

function currentQuarterLabel() {
  const n = new Date();
  return `${n.getFullYear()} Q${Math.floor(n.getMonth() / 3) + 1}`;
}

function quarterRank(label) {
  const m = /^(\d+)\s*Q([1-4])$/.exec(label || "");
  return m ? Number(m[1]) * 10 + Number(m[2]) : -1;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function loadQuarters() {
  const rows = await db.selectAll(
    "orders",
    "select=quarter&deleted_at=is.null&quarter=not.is.null&is_stock=is.false"
  );
  const seen = [...new Set(rows.map((r) => r.quarter))]
    .filter((q) => quarterRank(q) >= 20200)
    .sort((a, b) => quarterRank(b) - quarterRank(a));

  const sel = $("quarter");
  sel.innerHTML = "";
  for (const q of seen) {
    const o = document.createElement("option");
    o.value = o.textContent = q;
    sel.appendChild(o);
  }
  const current = currentQuarterLabel();
  sel.value = seen.includes(current) ? current : (seen[0] || "");
}

async function load() {
  $("error").classList.add("hidden");
  const quarter = $("quarter").value;
  try {
    // Not-yet-ordered rows have no quarter, so they need their own request --
    // they are exactly the "new items" this page is supposed to surface.
    const [pending, thisQuarter] = await Promise.all([
      db.selectAll(
        "orders",
        `select=${COLUMNS}&deleted_at=is.null&is_stock=is.false` +
          `&shop_order_date=is.null`
      ),
      quarter
        ? db.selectAll(
            "orders",
            `select=${COLUMNS}&deleted_at=is.null&is_stock=is.false` +
              `&quarter=eq.${encodeURIComponent(quarter)}`
          )
        : Promise.resolve([]),
    ]);

    ROWS = [...pending, ...thisQuarter].filter(
      (r) => !NOT_A_CUSTOMER.has((r.customer_name || "").trim().toLowerCase())
    );
    render();
  } catch (err) {
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function statusOf(r) {
  if (r.out_the_door) return { key: "done", label: "Out the door" };
  if (r.drilled) return { key: "done", label: "Drilled" };
  if (r.no_drill_needed) return { key: "done", label: "No drill needed" };
  if (!r.shop_order_date) return { key: "pending", label: "Not ordered" };
  return { key: "ordered", label: "Waiting to drill" };
}

function finished(r) {
  return r.drilled || r.out_the_door || r.no_drill_needed;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function shortDate(v) {
  if (!v) return "";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

function daysSince(v) {
  if (!v) return null;
  const [y, m, d] = v.slice(0, 10).split("-").map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date();
  return Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
}

function visible() {
  const q = $("search").value.trim().toLowerCase();
  const loc = $("location").value;
  const showDone = $("showdone").checked;

  return ROWS.filter((r) => {
    if (!showDone && finished(r)) return false;
    if (loc && r.pickup_location !== loc) return false;
    if (q) {
      const hay = [r.customer_name, r.item, r.phone].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    // Longest wait first; things not ordered yet sink to the bottom, since
    // you cannot drill a ball that has not arrived.
    if (!a.shop_order_date && !b.shop_order_date) {
      return (a.submitted_at || "").localeCompare(b.submitted_at || "");
    }
    if (!a.shop_order_date) return 1;
    if (!b.shop_order_date) return -1;
    return a.shop_order_date.localeCompare(b.shop_order_date);
  });
}

function render() {
  const rows = visible();
  const body = $("rows");
  body.innerHTML = "";

  for (const r of rows) body.appendChild(row(r));

  $("empty").classList.toggle("hidden", rows.length > 0);
  const waiting = ROWS.filter((r) => !finished(r) && r.shop_order_date).length;
  const notOrdered = ROWS.filter((r) => !finished(r) && !r.shop_order_date).length;
  $("count").textContent =
    `${waiting} waiting to drill` + (notOrdered ? ` · ${notOrdered} not ordered yet` : "");
}

function row(r) {
  const tr = document.createElement("tr");
  const st = statusOf(r);
  if (st.key === "pending") tr.classList.add("pending");

  const td = (label, cls) => {
    const c = document.createElement("td");
    if (label) c.dataset.label = label;
    if (cls) c.className = cls;
    tr.appendChild(c);
    return c;
  };

  const badge = document.createElement("span");
  badge.className = "badge " + st.key;
  badge.textContent = st.label;
  td("Status").appendChild(badge);

  td("Name").textContent = r.customer_name;

  const item = td("Item", "col-item");
  item.textContent = r.item;
  if (r.notes) {
    const n = document.createElement("div");
    n.style.cssText = "color:var(--muted);font-size:12px";
    n.textContent = r.notes;
    item.appendChild(n);
  }

  // A phone number on a drilling sheet exists to be called, so make it dial.
  const ph = td("Phone", "nowrap");
  if (r.phone) {
    const a = document.createElement("a");
    a.href = "tel:" + r.phone.replace(/\D/g, "");
    a.textContent = r.phone;
    ph.appendChild(a);
  } else {
    ph.innerHTML = '<span style="color:#c3c8ce">—</span>';
  }

  td("Pickup").textContent = r.pickup_location || r.order_location || "";

  const when = td("Ordered", "nowrap");
  if (r.shop_order_date) {
    when.textContent = shortDate(r.shop_order_date);
    const age = daysSince(r.shop_order_date);
    if (age !== null && age > 0 && !finished(r)) {
      const d = document.createElement("div");
      d.style.cssText = "color:var(--muted);font-size:12px";
      d.textContent = `${age} day${age === 1 ? "" : "s"} ago`;
      when.appendChild(d);
    }
  } else {
    when.innerHTML = '<span style="color:#c3c8ce">not ordered</span>';
  }

  const act = td("");
  // Already collected -- the drill flag no longer means anything, and an
  // "Undo" here would clear it while the row still reads "Out the door".
  if (r.out_the_door) {
    act.innerHTML = '<span style="color:#c3c8ce">—</span>';
    return tr;
  }

  act.style.whiteSpace = "nowrap";

  // Already resolved one way or the other -- offer only the way back.
  if (r.drilled || r.no_drill_needed) {
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    undo.title = r.drilled
      ? (r.drilled_at ? "Drilled " + shortDate(r.drilled_at) : "Drilled")
      : "Marked as needing no drilling";
    undo.addEventListener("click", () =>
      setFlags(r, undo, { drilled: false, drilled_at: null, no_drill_needed: false })
    );
    act.appendChild(undo);
    return tr;
  }

  const drilled = document.createElement("button");
  drilled.textContent = "Drilled";
  drilled.className = "primary";
  drilled.addEventListener("click", () =>
    setFlags(r, drilled, { drilled: true, drilled_at: new Date().toISOString() })
  );

  // Bags, shoes, totes and tape all arrive for a named customer, so they land
  // here too. Marking them "drilled" would put a false record on the order.
  const nodrill = document.createElement("button");
  nodrill.textContent = "No drill";
  nodrill.title = "Remove from this list without recording a drill";
  nodrill.style.marginLeft = "5px";
  nodrill.addEventListener("click", () =>
    setFlags(r, nodrill, { no_drill_needed: true })
  );

  const sched = document.createElement("button");
  sched.textContent = "Schedule";
  sched.title = "Book a drilling appointment for this customer";
  sched.style.marginLeft = "5px";
  sched.addEventListener("click", () => openScheduler(r));

  // Nothing to drill or book until the shop has actually placed the order.
  if (!r.shop_order_date) {
    for (const b of [drilled, sched]) {
      b.disabled = true;
      b.title = "Not ordered from the distributor yet";
    }
  }

  act.append(drilled, nodrill, sched);
  return tr;
}

async function setFlags(r, btn, patch) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await db.update("orders", `id=eq.${r.id}`, patch);
    Object.assign(r, patch);
    render();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
//
// A one-week strip rather than a month grid: booking a drilling appointment is
// a "what does the next few days look like" question, and a week leaves room
// to show who is already on the books for the day being considered.
//
// As in appointments.js, days are {y, m, d} integers and never go through the
// Date constructor as a string -- new Date("2026-08-30") is UTC midnight and
// renders as the 29th here.
// ---------------------------------------------------------------------------

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let sched = { order: null, weekStart: null, picked: null, appts: [] };

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());   // back to Sunday
  return d;
}

function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
  );
}

function prettyTime(t) {
  if (!t) return "";
  const [hs, mm] = t.split(":");
  let h = Number(hs);
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return mm === "00" ? `${h}${ap}` : `${h}:${mm}${ap}`;
}

function openScheduler(order) {
  const today = new Date();
  sched.order = order;
  sched.weekStart = startOfWeek(today);
  sched.picked = isoOf(today);

  $("s_who").textContent = order.customer_name + (order.phone ? ` · ${order.phone}` : "");
  $("s_what").textContent = order.item;
  $("s_service").value = `Drill ${order.item}`;
  $("s_location").value = order.pickup_location === "Both"
    ? ""
    : (order.pickup_location || order.order_location || "");
  $("s_time").value = "";

  $("dlg").showModal();
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

    cell.addEventListener("click", () => {
      sched.picked = key;
      renderWeek();
    });
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

    const t = document.createElement("span");
    t.className = "t";
    t.textContent = prettyTime(a.appt_time) || "—";

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = a.customer_name;

    const svc = document.createElement("span");
    svc.className = "svc";
    svc.textContent = a.service || "";

    row.append(t, who, svc);
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
  // Keep the selection on the same weekday in the new week, so paging
  // forward from "Thursday" lands on the next Thursday.
  const [y, m, d] = sched.picked.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();

  const s = sched.weekStart;
  sched.weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() + delta * 7);
  sched.picked = isoOf(weekDays(sched.weekStart)[dow]);
  loadWeek();
}

async function bookAppointment(e) {
  e.preventDefault();
  const o = sched.order;
  const row = {
    customer_name: o.customer_name,
    phone: o.phone || null,
    service: $("s_service").value.trim(),
    location: $("s_location").value || null,
    appt_date: sched.picked,
    appt_time: $("s_time").value || null,
    completed: false,
  };
  if (!row.service) return;

  const btn = $("s_save");
  btn.disabled = true;
  btn.textContent = "Booking…";
  try {
    await db.insert("appointments", row);
    $("dlg").close();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Book it";
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let t;
$("search").addEventListener("input", () => {
  clearTimeout(t);
  t = setTimeout(render, 150);
});
$("quarter").addEventListener("change", load);
$("location").addEventListener("change", render);
$("showdone").addEventListener("change", render);

$("s_prev").addEventListener("click", () => stepWeek(-1));
$("s_next").addEventListener("click", () => stepWeek(1));
$("s_thisweek").addEventListener("click", () => {
  const now = new Date();
  sched.weekStart = startOfWeek(now);
  sched.picked = isoOf(now);
  loadWeek();
});
$("schedform").addEventListener("submit", bookAppointment);
$("s_cancel").addEventListener("click", () => $("dlg").close());

(async function init() {
  try {
    await loadQuarters();
    await load();
  } catch (err) {
    showError(err);
  }
})();
