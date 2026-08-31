// Ticket queue -- Keith's side.
//
// Staff send tickets from ticket.html; this page is where they get read,
// prioritised and handed to someone. The default tab is "To review", because
// the failure mode of a ticket system is not a lost ticket, it is a ticket
// nobody has looked at.
//
// Assignment is a name, not an id. See migration/add_staff_and_tickets.sql --
// the roster supplies the spelling, it does not own the history.

const $ = (id) => document.getElementById(id);

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_LABEL = {
  new: "To review",
  assigned: "Assigned",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

let TICKETS = [];
let view = "review";
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
    render();
  } catch (err) {
    showError(err);
  }
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
  if (which === "review") return t.status === "new";
  if (which === "open") return t.status !== "new" && t.status !== "done";
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
    review: "Nothing waiting to be reviewed.",
    open: "Nothing in progress.",
    done: "Nothing finished yet.",
    all: "No tickets.",
  }[view];

  // Tab counts are of the whole queue, not the filtered view -- the point of
  // the number is to be true when you are looking at another tab.
  $("n_review").textContent = TICKETS.filter((t) => inView(t, "review")).length;
  $("n_open").textContent = TICKETS.filter((t) => inView(t, "open")).length;

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

  head.append(pri, title, status);
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

  // "Reviewed and handed off" is one click on the common path.
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
  open.textContent = "Details";
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
    showError(err);
  }
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
// Details dialog
// ---------------------------------------------------------------------------

function openDialog(t) {
  editing = t;
  $("dlgtitle").textContent = "Ticket";
  $("t_title").textContent = t.title;
  $("t_meta").textContent =
    [`from ${t.submitted_by}`, ago(t.submitted_at), t.category, t.location]
      .filter(Boolean).join(" · ");

  $("t_details").textContent = t.details || "No further details given.";
  $("t_details").classList.toggle("muted", !t.details);

  $("t_status").value = t.status;
  $("t_priority").value = t.priority;
  $("t_due").value = t.due_date || "";
  $("t_resolution").value = t.resolution || "";

  staff.fillSelect($("t_staff"), t.assigned_to)
    .catch((err) => console.error("Could not load the staff roster:", err));

  $("dlg").showModal();
}

async function saveDialog(e) {
  e.preventDefault();
  if (!editing) return;

  const name = $("t_staff").value || null;
  const status = $("t_status").value;

  const changes = {
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

  const btn = $("t_save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await db.update("tickets", `id=eq.${editing.id}`, changes);
    Object.assign(editing, changes);
    $("dlg").close();
    render();
  } catch (err) {
    showError(err);
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
