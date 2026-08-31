// Staff ticket intake.
//
// The one page a staff member ever needs: name, what is wrong, send. Everything
// Keith needs to triage -- status, assignee, due date -- is deliberately absent,
// because a person reporting a jammed ball return should not be picking who
// fixes it.
//
// The submitter's name is remembered in localStorage. Ticket two on the same
// shift should not mean typing your own name again.

const $ = (id) => document.getElementById(id);
const WHO_KEY = "proshop.ticket.submitter";

let session = [];   // sent since the page loaded, newest first

function showError(err) {
  $("error").textContent = String(err && err.message ? err.message : err);
  $("error").classList.remove("hidden");
  $("ok").classList.add("hidden");
  console.error(err);
}

function shortDate(v) {
  if (!v) return "";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

function showOk(msg) {
  $("ok").textContent = msg;
  $("ok").classList.remove("hidden");
  $("error").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Roster -- a suggestion list, not a gate
//
// A datalist rather than a <select>: someone filling in for a shift may not be
// on the roster yet, and "you are not on the list" is a terrible reason to
// lose a report that lane 6 is jamming.
// ---------------------------------------------------------------------------

async function loadStaffNames() {
  try {
    const dl = $("staffnames");
    for (const name of await staff.names()) {
      const o = document.createElement("option");
      o.value = name;
      dl.appendChild(o);
    }
  } catch (err) {
    console.error("Could not load the staff roster:", err);
  }
}

function rememberedWho() {
  try {
    return localStorage.getItem(WHO_KEY) || "";
  } catch {
    // Private browsing, or site data blocked. Not worth a word to the user.
    return "";
  }
}

function rememberWho(name) {
  try {
    localStorage.setItem(WHO_KEY, name);
  } catch {
    /* nothing to do -- the field just starts empty next time */
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function readForm() {
  const by = $("f_by").value.trim();
  const title = $("f_title").value.trim();

  if (!by) {
    $("f_by").focus();
    throw new Error("Put your name on it so Keith knows who to ask.");
  }
  if (!title) {
    $("f_title").focus();
    throw new Error("Give the ticket a one-line summary.");
  }

  return {
    submitted_by: by,
    submitted_at: new Date().toISOString(),
    location: $("f_location").value || null,
    title,
    category: $("f_category").value || null,
    priority: $("f_priority").value,
    due_date: $("f_due").value || null,
    details: $("f_details").value.trim() || null,
    // Every ticket lands unreviewed. Nothing here sets status or an assignee
    // -- that is the review page's job.
    status: "new",
  };
}

async function send(e) {
  e.preventDefault();

  let row;
  try {
    row = readForm();
  } catch (err) {
    return showError(err);
  }

  const btn = $("f_save");
  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    const [created] = await db.insert("tickets", row);
    rememberWho(row.submitted_by);
    session.unshift(created || row);
    renderSession();
    showOk("Sent. Keith will see it in the queue.");

    // The name and location stay: a shift that turns up one problem usually
    // turns up three, and they are all being reported by the same person
    // standing in the same building.
    $("f_title").value = "";
    $("f_details").value = "";
    $("f_category").value = "";
    $("f_priority").value = "normal";
    $("f_due").value = "";
    $("f_title").focus();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send ticket";
  }
}

// ---------------------------------------------------------------------------
// What was just sent -- a receipt, and a way to take back a mistake
// ---------------------------------------------------------------------------

function renderSession() {
  $("minewrap").classList.toggle("hidden", session.length === 0);
  const list = $("minelist");
  list.innerHTML = "";

  for (const t of session) {
    const el = document.createElement("div");
    el.className = "savedrow";

    const pri = document.createElement("span");
    pri.className = "badge pri-" + t.priority;
    pri.textContent = t.priority;

    const title = document.createElement("span");
    title.className = "it";
    title.textContent = t.title +
      (t.due_date ? " — needed by " + shortDate(t.due_date) : "");

    el.append(pri, title);

    // Only a row that came back from the insert has an id to withdraw.
    if (t.id) {
      const undo = document.createElement("button");
      undo.textContent = "Withdraw";
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        try {
          await db.softDelete("tickets", t.id);
          session = session.filter((x) => x.id !== t.id);
          renderSession();
          showOk("Withdrawn.");
        } catch (err) {
          undo.disabled = false;
          showError(err);
        }
      });
      el.appendChild(undo);
    }
    list.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$("ticketform").addEventListener("submit", send);
$("f_clear").addEventListener("click", () => {
  for (const id of ["f_title", "f_details", "f_due"]) $(id).value = "";
  $("f_category").value = "";
  $("f_priority").value = "normal";
  $("ok").classList.add("hidden");
  $("error").classList.add("hidden");
  $("f_title").focus();
});

$("f_by").value = rememberedWho();
loadStaffNames();
$(rememberedWho() ? "f_title" : "f_by").focus();
