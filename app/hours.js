// Weekly hours confirmation.
//
// Every Sunday the shop confirms next week's opening hours. This puts last
// week's hours on next week's dates in front of whoever opens the app, so the
// normal week is one click and only the exceptions need typing.
//
// Hours live in the `hours` table -- fourteen rows, one per location per day,
// updated in place. See migration/add_hours.sql. The public website reads the
// same table with the same publishable key, so confirming here is all it takes
// for the website to show the new week.

// TEST_MODE opens the dialog on every visit to the orders page, whatever the
// day, and ignores "already confirmed". Set it to false to go live: Sundays
// only, once per week. The Hours button in the toolbar works either way.
const HOURS_TEST_MODE = true;

const HOURS_DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

// The two cards, matched on a fragment of the location name rather than the
// whole string -- the same way staff names are matched elsewhere. Renaming
// "Valley Bowling Lanes" in the table does not have to mean editing this.
const HOURS_LOCATIONS = [
  { key: "idle",   title: "Idle Hours South", match: "idle"   },
  { key: "valley", title: "Valley Lanes",     match: "valley" },
];

const HOURS_FIELDS = ["open1", "close1", "note1", "open2", "close2", "note2"];

const DONE_KEY = "proshop.hoursConfirmedWeek";
const SKIP_KEY = "proshop.hoursDismissedWeek";

let hoursWeek = null;      // { idle: [row…], valley: [row…] } once loaded
let hoursSaved = false;    // this week's rows are in the database


/* ---------- dates ---------- */

// The week runs Monday to Sunday, the order the cards are drawn in. On Sunday
// you are confirming the week that starts tomorrow, so the target is always
// the next Monday -- which also means the stored key changes exactly once a
// week, on Sunday, and that is what makes "not again until next Sunday" work.
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }

function mondayOf(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));   // Sun=0 back 6, Mon=1 back 0
  return m;
}

function weekMonday() { return addDays(mondayOf(new Date()), 7); }

function md(d)  { return `${d.getMonth() + 1}/${d.getDate()}`; }

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function longDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function dateForDay(day) {
  const i = HOURS_DAYS.indexOf(day);
  return addDays(weekMonday(), i < 0 ? 0 : i);
}

// A date column comes back as "2026-09-07". Parsing that with new Date() would
// read it as UTC midnight and show the day before to anyone west of Greenwich,
// so build it from the parts instead.
function dateFromIso(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return (y && m && d) ? new Date(y, m - 1, d) : null;
}


/* ---------- loading ---------- */

async function loadHours() {
  const rows = await db.select("hours", "select=*&order=day_index.asc");

  const out = {};
  HOURS_LOCATIONS.forEach(l => { out[l.key] = []; });

  rows.forEach(row => {
    const where = HOURS_LOCATIONS.find(l => (row.location || "").toLowerCase().includes(l.match));
    if (!where || !HOURS_DAYS.includes(row.day)) return;
    out[where.key].push(row);
  });

  return out;
}


/* ---------- when to ask ---------- */

function storeGet(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
function storeSet(store, key, v) { try { window[store].setItem(key, v); } catch (e) {} }

// Someone at the other counter may have confirmed already. The table says so,
// and it says so more reliably than this browser's localStorage does.
function alreadyOnTargetWeek() {
  const monday = isoOf(weekMonday());
  return HOURS_LOCATIONS.some(l =>
    hoursWeek[l.key].some(r => r.day === "Monday" && String(r.date || "").slice(0, 10) === monday));
}

function shouldAsk() {
  if (!HOURS_LOCATIONS.some(l => hoursWeek[l.key].length)) return false;
  if (HOURS_TEST_MODE) return true;
  if (new Date().getDay() !== 0) return false;                        // Sundays
  if (storeGet("localStorage", DONE_KEY) === isoOf(weekMonday())) return false;
  if (storeGet("sessionStorage", SKIP_KEY) === isoOf(weekMonday())) return false;
  if (alreadyOnTargetWeek()) return false;
  return true;
}


/* ---------- the dialog ---------- */

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hoursDayRow(locKey, row) {
  const extra = !!(row.note1 || row.open2 || row.close2 || row.note2);
  const box = (name, placeholder) =>
    `<input type="text" placeholder="${placeholder}" value="${escHtml(row[name] || "")}"
            data-loc="${locKey}" data-day="${escHtml(row.day)}" data-field="${name}">`;

  return `
    <div class="hrow">
      <div class="hday">
        <span class="hd">${escHtml(row.day)}</span>
        <span class="hdate">${md(dateForDay(row.day))}</span>
      </div>
      <div class="hfields">
        <div class="htimes">
          ${box("open1", "Closed")}
          <span class="hdash">&ndash;</span>
          ${box("close1", "Close")}
          <button type="button" class="hmore" title="Note, and a second opening">${extra ? "&minus;" : "+"}</button>
        </div>
        <div class="hextra${extra ? " open" : ""}">
          ${box("note1", "Note, e.g. After League")}
          <div class="htimes">
            ${box("open2", "Second opening")}
            <span class="hdash">&ndash;</span>
            ${box("close2", "Close")}
          </div>
          ${box("note2", "Second note")}
        </div>
      </div>
    </div>`;
}

function openHours() {
  const monday = weekMonday();

  document.getElementById("hoursweek").textContent =
    `${longDate(monday)} – ${longDate(addDays(monday, 6))}`;

  document.getElementById("hoursgrid").innerHTML = HOURS_LOCATIONS.map(l => `
    <div class="hloc">
      <h4>${escHtml(l.title)}</h4>
      ${hoursWeek[l.key].map(r => hoursDayRow(l.key, r)).join("")}
    </div>`).join("");

  const status = document.getElementById("hoursstatus");
  status.className = "hstatus";
  status.textContent = "Leave a time empty to show the day as closed.";

  const save = document.getElementById("hourssave");
  save.textContent = "Confirm hours";
  save.disabled = false;
  hoursSaved = false;

  document.querySelectorAll("#hoursgrid .hmore").forEach(btn => {
    btn.addEventListener("click", () => {
      const extra = btn.closest(".hfields").querySelector(".hextra");
      btn.innerHTML = extra.classList.toggle("open") ? "&minus;" : "+";
    });
  });

  document.getElementById("hoursdlg").showModal();
}

// The X and Escape both mean "not now": nothing is written, and it stays shut
// for this sitting rather than reopening on the next page.
function dismissHours() {
  if (!hoursSaved) storeSet("sessionStorage", SKIP_KEY, isoOf(weekMonday()));
  document.getElementById("hoursdlg").close();
}

// The rows as the dialog has them, on the coming week's dates. Sent as an
// upsert keyed on (location, day), so the fourteen rows are matched by what
// they are rather than by an id the dialog would have to keep track of.
function collectHours() {
  const rows = [];
  HOURS_LOCATIONS.forEach(l => {
    hoursWeek[l.key].forEach(row => {
      const entry = { location: row.location, day: row.day, date: isoOf(dateForDay(row.day)) };
      HOURS_FIELDS.forEach(name => {
        const el = document.querySelector(
          `#hoursgrid [data-loc="${l.key}"][data-day="${row.day}"][data-field="${name}"]`);
        const v = el ? el.value.trim() : "";
        entry[name] = v === "" ? null : v;      // empty means closed, and null is how the column says it
      });
      rows.push(entry);
    });
  });
  return rows;
}

async function confirmHours() {
  const save = document.getElementById("hourssave");
  const status = document.getElementById("hoursstatus");

  if (hoursSaved) { document.getElementById("hoursdlg").close(); return; }

  save.disabled = true;
  save.textContent = "Saving…";
  status.className = "hstatus";
  status.textContent = "Writing the week…";

  try {
    const written = await db.upsert("hours", collectHours(), "location,day");

    // Take the rows the database actually stored rather than the ones we sent
    // -- if a default or a trigger changed anything, the dialog should be
    // showing what is really there.
    hoursWeek = regroup(written);
    hoursSaved = true;
    storeSet("localStorage", DONE_KEY, isoOf(weekMonday()));

    status.className = "hstatus ok";
    status.textContent = `Confirmed. ${written.length} rows saved — the website has the new week now.`;
    save.textContent = "Done";
    save.disabled = false;

  } catch (err) {
    status.className = "hstatus bad";
    status.textContent = `Could not save: ${err.message}. Nothing was changed — try again.`;
    save.disabled = false;
    save.textContent = "Confirm hours";
  }
}

function regroup(rows) {
  const out = {};
  HOURS_LOCATIONS.forEach(l => { out[l.key] = []; });
  rows.forEach(row => {
    const where = HOURS_LOCATIONS.find(l => (row.location || "").toLowerCase().includes(l.match));
    if (where) out[where.key].push(row);
  });
  HOURS_LOCATIONS.forEach(l =>
    out[l.key].sort((a, b) => HOURS_DAYS.indexOf(a.day) - HOURS_DAYS.indexOf(b.day)));
  return out;
}


/* ---------- wiring ---------- */

document.getElementById("hourssave").addEventListener("click", confirmHours);
document.getElementById("hoursx").addEventListener("click", dismissHours);
document.getElementById("hoursdlg").addEventListener("cancel", e => {
  e.preventDefault();          // Escape must go through dismissHours
  dismissHours();
});

const hoursBtn = document.getElementById("hoursbtn");

loadHours()
  .then(data => {
    hoursWeek = data;
    hoursBtn.disabled = false;
    if (shouldAsk()) openHours();
  })
  .catch(err => {
    // The orders page is not the hours page. Hours that will not load must not
    // take the order book down with them -- say so on the button and stop.
    console.error("Hours:", err);
    hoursBtn.disabled = true;
    hoursBtn.title = "Could not load hours: " + err.message;
  });

hoursBtn.addEventListener("click", () => { if (hoursWeek) openHours(); });
