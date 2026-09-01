// Hours for the public website -- the read half only.
//
// Drop-in replacement for the Google Sheet / gviz block that used to fill the
// two hours cards on the home page. It reads the same `hours` table the app
// confirms into, so the week the shop confirmed on Sunday is the week the
// website shows.
//
// This file deliberately contains no way to CHANGE hours. Confirming is done
// behind the counter, in the app. A customer-facing page has no business
// carrying a write path.
//
// To use it: replace everything from `const SHEET_ID` to the end of the old
// hours <script> block with this. Nothing else on the page changes -- the
// markup, the class names and the two container ids are all the same.

const SUPABASE_URL = "https://ngghyuvykqqklztvvmld.supabase.co";
const SUPABASE_KEY = "sb_publishable_X-ZHYha1P8FPVL2rvAk-bA_CdXD8g-g";

const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const now       = new Date();
const todayStr  = `${now.getMonth() + 1}/${now.getDate()}`;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// "2026-09-07" -> "9/7". Built from the parts on purpose: new Date() on a
// bare date string reads it as UTC midnight, which shows the day before to
// anyone west of Greenwich.
function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return (m && d) ? `${m}/${d}` : '';
}

function formatTimeRange(open, close, note) {
  if (!open || !String(open).trim()) return { text: 'Closed', type: 'closed' };
  const lc = String(open).toLowerCase().trim();
  if (lc === 'closed') return { text: 'Closed', type: 'closed' };
  if (lc.includes('appoint')) return { text: 'By Appointment', type: 'appt' };

  let text = (close && String(close).trim() && String(close).toLowerCase() !== 'closed')
    ? `${esc(open)} – ${esc(close)}`
    : esc(open);
  if (note && String(note).trim()) text += ` <span class="hours-note">(${esc(note)})</span>`;
  return { text, type: 'normal' };
}

function buildList(containerId, rows) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!rows || !rows.length) {
    el.innerHTML = '<div class="hours-error">No hours available.</div>';
    return;
  }

  rows.sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day));

  el.innerHTML = rows.map(row => {
    const date    = shortDate(row.date);
    const isToday = date === todayStr;
    const dateStr = date ? `<span class="day-date">${date}</span>` : '';

    const t1 = formatTimeRange(row.open1, row.close1, row.note1);
    let timeHTML = `<span class="day-time ${t1.type}">${t1.text}</span>`;

    if (row.open2) {
      const t2 = formatTimeRange(row.open2, row.close2, row.note2);
      timeHTML += `<span class="day-time-sep">&amp;</span>
                   <span class="day-time ${t2.type}">${t2.text}</span>`;
    }

    return `
      <div class="hours-row${isToday ? ' is-today' : ''}">
        <span class="day-name${isToday ? ' today' : ''}">
          ${esc(row.day)}${dateStr}${isToday ? '<span class="today-badge">Today</span>' : ''}
        </span>
        <span class="day-times">${timeHTML}</span>
      </div>`;
  }).join('');
}

fetch(`${SUPABASE_URL}/rest/v1/hours?select=*&order=day_index.asc`, {
  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  cache: 'no-store',
})
  .then(r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  })
  .then(rows => {
    const valley = [], idle = [];
    rows.forEach(row => {
      const loc = (row.location || '').toLowerCase();
      if (loc.includes('valley')) valley.push(row);
      else if (loc.includes('idle')) idle.push(row);
    });
    buildList('valleyLanesList', valley);
    buildList('idleHoursList',   idle);
  })
  .catch(err => {
    ['valleyLanesList','idleHoursList'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML =
        `<div class="hours-error">⚠️ Could not load hours.<br><small>${esc(err.message)}</small></div>`;
    });
  });
