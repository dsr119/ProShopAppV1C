// New order — entry from behind the counter.
//
// Two modes, because 55% of what the shop orders is its own stock, not a
// customer's ball. Stock entry is bulk work done in one sitting (tape,
// sleeves, sanding pads), so that mode strips the form down to the item and
// keeps the page open between saves.

const $ = (id) => document.getElementById(id);

let stockMode = false;
let session = [];   // what was added since the page loaded, newest first

function showError(err) {
  $("error").textContent = String(err && err.message ? err.message : err);
  $("error").classList.remove("hidden");
  $("ok").classList.add("hidden");
  console.error(err);
}

function showOk(msg) {
  $("ok").textContent = msg;
  $("ok").classList.remove("hidden");
  $("error").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Autocomplete — 1,474 items from ten years of order history
// ---------------------------------------------------------------------------

async function loadItems() {
  try {
    // Supabase caps a response at 1000 rows; ordering by frequency means the
    // cut falls on things nobody has bought in years.
    const rows = await db.select(
      "items",
      "select=item&order=times_ordered.desc&limit=1000"
    );
    const dl = $("items");
    dl.innerHTML = "";
    for (const r of rows) {
      const o = document.createElement("option");
      o.value = r.item;
      dl.appendChild(o);
    }
  } catch (err) {
    // A missing typeahead should not stop anyone taking an order.
    console.error("Could not load item suggestions:", err);
  }
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

function setMode(stock) {
  stockMode = stock;
  $("mode_customer").classList.toggle("on", !stock);
  $("mode_stock").classList.toggle("on", stock);

  // A name, phone and fitting are meaningless for a box of inner sleeves.
  $("customerfields").classList.toggle("hidden", stock);
  $("lbl_fitting").classList.toggle("hidden", stock);

  $("f_item").focus();
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10
    ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`
    : String(raw || "").trim();
}

function readForm() {
  const item = $("f_item").value.trim();
  const name = $("f_name").value.trim();
  const phoneRaw = $("f_phone").value.trim();
  const notes = [];

  if (!item) {
    $("f_item").focus();
    throw new Error("An item is required.");
  }
  if (!stockMode && !name) {
    $("f_name").focus();
    throw new Error("A customer name is required — or switch to Shop stock.");
  }

  let phone = null;
  if (!stockMode && phoneRaw) {
    const formatted = normalizePhone(phoneRaw);
    // Same rule the importer and the form trigger use: anything that is not a
    // usable number is kept as a note rather than stored as a phone.
    if (/^\d{3}-\d{3}-\d{4}$/.test(formatted)) phone = formatted;
    else notes.push("phone on file: " + phoneRaw);
  }

  const typed = $("f_notes").value.trim();
  if (typed) notes.unshift(typed);

  return {
    customer_name: stockMode ? "Stock" : name,
    is_stock: stockMode,
    phone,
    item,
    quantity: Math.max(1, parseInt($("f_qty").value, 10) || 1),
    fitting: stockMode ? null : ($("f_fitting").value || null),
    order_location: $("f_orderloc").value || null,
    pickup_location: $("f_pickuploc").value || null,
    notes: notes.length ? notes.join("; ") : null,
    source: "in_shop",
    // Null on purpose: it means the shop has not placed this with a
    // distributor yet, which is what pins it to the top of the orders page.
    shop_order_date: null,
    submitted_at: new Date().toISOString(),
  };
}

async function save(keepOpen) {
  let row;
  try {
    row = readForm();
  } catch (err) {
    showError(err);
    return;
  }

  const btn = keepOpen ? $("f_saveanother") : $("f_save");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const [created] = await db.insert("orders", row);
    session.unshift(created || row);
    renderSession();
    showOk(
      (row.is_stock ? "Stock" : row.customer_name) +
        " — " + row.item + " added to the order queue."
    );

    if (keepOpen) {
      // Locations and mode carry over: stock gets entered in runs, and a
      // customer standing at the counter usually orders more than one thing.
      $("f_item").value = "";
      $("f_qty").value = "1";
      $("f_notes").value = "";
      $("f_item").focus();
    } else {
      clearForm();
    }
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function clearForm() {
  for (const id of ["f_name", "f_phone", "f_item", "f_notes"]) $(id).value = "";
  $("f_qty").value = "1";
  $("f_fitting").value = "";
  $("f_orderloc").value = "";
  $("f_pickuploc").value = "";
  $("f_item").focus();
}

// ---------------------------------------------------------------------------
// What was just added — so a typo caught two seconds later is one click to fix
// ---------------------------------------------------------------------------

function renderSession() {
  $("savedwrap").classList.toggle("hidden", session.length === 0);
  const list = $("savedlist");
  list.innerHTML = "";

  for (const row of session) {
    const el = document.createElement("div");
    el.className = "savedrow";

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = row.is_stock ? "Stock" : row.customer_name;

    const it = document.createElement("span");
    it.className = "it";
    it.textContent = row.item + (row.quantity > 1 ? ` ×${row.quantity}` : "");

    el.append(who, it);

    if (row.id) {
      const undo = document.createElement("button");
      undo.textContent = "Undo";
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        try {
          await db.softDelete("orders", row.id);
          session = session.filter((r) => r.id !== row.id);
          renderSession();
          showOk("Removed " + row.item + ".");
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

$("mode_customer").addEventListener("click", () => setMode(false));
$("mode_stock").addEventListener("click", () => setMode(true));

$("orderform").addEventListener("submit", (e) => {
  e.preventDefault();
  save(false);
});
$("f_saveanother").addEventListener("click", () => save(true));
$("f_clear").addEventListener("click", () => {
  clearForm();
  $("ok").classList.add("hidden");
  $("error").classList.add("hidden");
});

// Enter in the item box is the fast path for stock runs.
$("f_item").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    save(true);
  }
});

loadItems();
setMode(false);
