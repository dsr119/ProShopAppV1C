// Opening hours -- this week and next.
//
// Every Sunday the shop confirms the coming week. The rest of the time it
// fixes a Thursday in the week it is actually working. Both are the same
// dialog: two tabs, one save.
//
// Hours live in the `hours` table, keyed on (location, date) -- a row is a
// specific day, not a slot, so both weeks exist at once. See
// migration/add_hours_two_weeks.sql. The public website reads the same table,
// asking for the current week by date range, so confirming here is all it
// takes for the website to be right.

// TEST_MODE opens the dialog on every visit, whatever the day, and ignores
// "already confirmed". Live, it opens by itself on Sundays only. The Hours
// button in the toolbar works either way.
const HOURS_TEST_MODE = false;

const HOURS_DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

// Matched on a fragment of the location name rather than the whole string --
// the same way staff names are matched elsewhere. Renaming "Valley Bowling
// Lanes" in the table does not have to mean editing this.
const HOURS_LOCATIONS = [
  { key: "idle",   title: "Idle Hours South", match: "idle"   },
  { key: "valley", title: "Valley Lanes",     match: "valley" },
];

const HOURS_FIELDS = ["open1", "close1", "note1", "open2", "close2", "note2"];

const DONE_KEY = "proshop.hoursConfirmedWeek";
const SKIP_KEY = "proshop.hoursDismissedWeek";

// { this: {monday, idle:[…], valley:[…]}, next: {…} }
let hoursWeeks = null;
let hoursTab = "this";
let hoursSaved = false;


/* ---------- dates ---------- */

function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }

function mondayOf(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));   // Sun=0 back 6, Mon=1 back 0
  return m;
}

function thisMonday() { return mondayOf(new Date()); }
function nextMonday() { return addDays(thisMonday(), 7); }

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function md(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }

function shortDay(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "2026-09-07" built from its parts. new Date() on a bare date string reads it
// as UTC midnight, which is the previous day everywhere west of Greenwich.
function dateFromIso(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}


/* ---------- loading ---------- */

async function loadHours() {
  const from = isoOf(thisMonday());
  const to   = isoOf(addDays(nextMonday(), 6));

  const rows = await db.select(
    "hours",
    `select=*&date=gte.${from}&date=lte.${to}&order=date.asc`
  );

  const weeks = {
    this: { monday: thisMonday() },
    next: { monday: nextMonday() },
  };
  const nextIso = isoOf(nextMonday());

  for (const which of ["this", "next"]) {
    HOURS_LOCATIONS.forEach(l => { weeks[which][l.key] = []; });
  }

  rows.forEach(row => {
    const where = HOURS_LOCATIONS.find(l => (row.location || "").toLowerCase().includes(l.match));
    if (!where) return;
    const which = String(row.date).slice(0, 10) >= nextIso ? "next" : "this";
    weeks[which][where.key].push(row);
  });

  for (const which of ["this", "next"]) {
    HOURS_LOCATIONS.forEach(l =>
      weeks[which][l.key].sort((a, b) => String(a.date).localeCompare(String(b.date))));
  }

  return weeks;
}

function weekHasRows(which) {
  return HOURS_LOCATIONS.some(l => hoursWeeks[which][l.key].length);
}


/* ---------- when to ask ---------- */

function storeGet(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
function storeSet(store, key, v) { try { window[store].setItem(key, v); } catch (e) {} }

function shouldAsk() {
  if (!hoursWeeks || !weekHasRows("this")) return false;
  if (HOURS_TEST_MODE) return true;
  if (new Date().getDay() !== 0) return false;                        // Sundays
  if (storeGet("localStorage", DONE_KEY) === isoOf(nextMonday())) return false;
  if (storeGet("sessionStorage", SKIP_KEY) === isoOf(nextMonday())) return false;
  return true;
}


/* ---------- the dialog ---------- */

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hoursDayRow(which, locKey, row) {
  const extra = !!(row.note1 || row.open2 || row.close2 || row.note2);
  const d = dateFromIso(row.date);
  const isToday = isoOf(d) === isoOf(new Date());

  const box = (name, placeholder) =>
    `<input type="text" placeholder="${placeholder}" value="${escHtml(row[name] || "")}"
            data-week="${which}" data-loc="${locKey}" data-date="${escHtml(String(row.date).slice(0,10))}"
            data-field="${name}">`;

  return `
    <div class="hrow${isToday ? " istoday" : ""}">
      <div class="hday">
        <span class="hd">${escHtml(row.day)}</span>
        <span class="hdate">${md(d)}${isToday ? " · today" : ""}</span>
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

function weekGrid(which) {
  const w = hoursWeeks[which];

  if (!weekHasRows(which)) {
    return `<div class="hempty" data-week="${which}">
              No hours saved for this week yet. Run migration/add_hours_two_weeks.sql,
              or add them in the Supabase table editor.
            </div>`;
  }

  return `<div class="hoursgrid" data-week="${which}">` +
    HOURS_LOCATIONS.map(l => `
      <div class="hloc">
        <h4>${escHtml(l.title)}</h4>
        ${w[l.key].map(r => hoursDayRow(which, l.key, r)).join("")}
      </div>`).join("") +
    `</div>`;
}

function weekLabel(which) {
  const m = hoursWeeks[which].monday;
  return `${shortDay(m)} – ${shortDay(addDays(m, 6))}`;
}

function showTab(which) {
  hoursTab = which;
  document.querySelectorAll("#hourstabs button").forEach(b =>
    b.classList.toggle("on", b.dataset.week === which));
  document.querySelectorAll("#hoursgrid [data-week]").forEach(el =>
    el.classList.toggle("hidden", el.dataset.week !== which));
}

function openHours(startOn) {
  document.getElementById("hourstabs").innerHTML = `
    <button type="button" data-week="this">This week <span>${weekLabel("this")}</span></button>
    <button type="button" data-week="next">Next week <span>${weekLabel("next")}</span></button>`;

  document.getElementById("hoursgrid").innerHTML = weekGrid("this") + weekGrid("next");

  const status = document.getElementById("hoursstatus");
  status.className = "hstatus";
  status.textContent = "Leave a time empty to show the day as closed.";

  const save = document.getElementById("hourssave");
  save.textContent = "Save hours";
  save.disabled = false;
  hoursSaved = false;

  document.querySelectorAll("#hourstabs button").forEach(b =>
    b.addEventListener("click", () => showTab(b.dataset.week)));

  document.querySelectorAll("#hoursgrid .hmore").forEach(btn => {
    btn.addEventListener("click", () => {
      const extra = btn.closest(".hfields").querySelector(".hextra");
      btn.innerHTML = extra.classList.toggle("open") ? "&minus;" : "+";
    });
  });

  // Sunday is about the week ahead. Any other day, you opened this to fix
  // something in the week you are standing in.
  showTab(startOn || (new Date().getDay() === 0 ? "next" : "this"));
  document.getElementById("hoursdlg").showModal();
}

// The X and Escape both mean "not now": nothing is written, and the Sunday
// prompt stays shut for this sitting rather than reopening on the next page.
function dismissHours() {
  if (!hoursSaved) storeSet("sessionStorage", SKIP_KEY, isoOf(nextMonday()));
  document.getElementById("hoursdlg").close();
}

// Both weeks go in one upsert, whichever tab is showing. Saving only the
// visible one would quietly throw away edits made on the other.
function collectHours() {
  const rows = [];
  ["this", "next"].forEach(which => {
    HOURS_LOCATIONS.forEach(l => {
      hoursWeeks[which][l.key].forEach(row => {
        const date = String(row.date).slice(0, 10);
        const entry = { location: row.location, day: row.day, date };
        HOURS_FIELDS.forEach(name => {
          const el = document.querySelector(
            `#hoursgrid [data-week="${which}"][data-loc="${l.key}"][data-date="${date}"][data-field="${name}"]`);
          const v = el ? el.value.trim() : "";
          entry[name] = v === "" ? null : v;   // empty means closed, and null is how the column says it
        });
        rows.push(entry);
      });
    });
  });
  return rows;
}

async function confirmHours() {
  const save = document.getElementById("hourssave");
  const status = document.getElementById("hoursstatus");

  if (hoursSaved) { document.getElementById("hoursdlg").close(); return; }

  const rows = collectHours();
  if (!rows.length) {
    status.className = "hstatus bad";
    status.textContent = "Nothing to save.";
    return;
  }

  save.disabled = true;
  save.textContent = "Saving…";
  status.className = "hstatus";
  status.textContent = "Saving both weeks…";

  try {
    const written = await db.upsert("hours", rows, "location,date");

    hoursWeeks = await loadHours();
    hoursSaved = true;
    storeSet("localStorage", DONE_KEY, isoOf(nextMonday()));

    status.className = "hstatus ok";
    status.textContent = `Saved. ${written.length} days written — the website has them now.`;
    save.textContent = "Done";
    save.disabled = false;

  } catch (err) {
    status.className = "hstatus bad";
    status.textContent = `Could not save: ${err.message}. Nothing was changed — try again.`;
    save.disabled = false;
    save.textContent = "Save hours";
  }
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
  .then(weeks => {
    hoursWeeks = weeks;
    hoursBtn.disabled = false;
    if (shouldAsk()) openHours("next");
  })
  .catch(err => {
    // The orders page is not the hours page. Hours that will not load must not
    // take the order book down with them -- say so on the button and stop.
    console.error("Hours:", err);
    hoursBtn.disabled = true;
    hoursBtn.title = "Could not load hours: " + err.message;
  });

hoursBtn.addEventListener("click", () => { if (hoursWeeks) openHours(); });
