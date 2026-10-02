// New order — entry from behind the counter.
//
// A dialog on the orders page rather than a page of its own. Taking an order
// is a thing you do *to* the order book: you are already looking at it, the
// customer is at the counter, and a page navigation away and back loses your
// filters and your place in the list. Saving refreshes the table underneath,
// so the order you just took is visible the moment the dialog closes.
//
// Two modes, because 55% of what the shop orders is its own stock, not a
// customer's ball. Stock entry is bulk work done in one sitting (tape,
// sleeves, sanding pads), so that mode strips the form down to the item and
// keeps the dialog open between saves.
//
// This runs alongside orders.js and shares its globals -- `$`, `showError`
// and `load` are all defined there. Redeclaring any of them here would throw
// "already declared" and take the whole page down, so every name below is
// distinct from one in orders.js.

let noStock = false;
let noSession = [];   // added since the dialog was opened, newest first

function noStatus(msg, bad) {
  const el = $("o_status");
  el.textContent = msg || "";
  el.className = "hstatus" + (bad ? " bad" : msg ? " ok" : "");
  if (bad) console.error(msg);
}

// A name, phone and fitting are meaningless for a box of inner sleeves.
function noSetMode(stock) {
  noStock = stock;
  $("o_mode_customer").classList.toggle("on", !stock);
  $("o_mode_stock").classList.toggle("on", stock);
  $("o_customerfields").classList.toggle("hidden", stock);
  $("o_lbl_fitting").classList.toggle("hidden", stock);
  $("f_item").focus();
}

function noPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10
    ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`
    : String(raw || "").trim();
}

// "size 11 shoes, 12lb tzone, tzone bag" is three orders, not one: each item
// is ordered, arrives and gets picked up on its own, and the book has one row
// per item. Split on commas; blanks and a trailing full stop are dropped.
function noSplitItems(text) {
  return String(text || "")
    .split(",")
    .map((s) => s.trim().replace(/\.+$/, "").trim())
    .filter(Boolean);
}

// The items this save will create. "Keep as one item" is the escape hatch for
// the comma that belongs to the item ("Storm Phaze II, 15lb").
function noItems() {
  const text = $("f_item").value.trim();
  if ($("f_keepone").checked) return text ? [text] : [];
  return noSplitItems(text);
}

// Show staff what is about to be saved before they press Save, so a comma
// meant as part of one item gets caught at the counter, not in the book.
function noRenderSplit() {
  const parts = noSplitItems($("f_item").value);
  const wrap = $("o_split");
  wrap.classList.toggle("hidden", parts.length < 2);
  if (parts.length < 2) {
    $("f_keepone").checked = false;
    return;
  }
  const one = $("f_keepone").checked;
  $("o_splitmsg").textContent = one
    ? "Will save as one order."
    : `Will save as ${parts.length} separate orders, each with the same customer details:`;
  const list = $("o_splitlist");
  list.innerHTML = "";
  list.classList.toggle("hidden", one);
  for (const p of parts) {
    const li = document.createElement("li");
    li.textContent = p;
    list.appendChild(li);
  }
}

function noReadForm() {
  const items = noItems();
  const name = $("f_name").value.trim();
  const phoneRaw = $("f_phone").value.trim();
  const notes = [];

  if (!items.length) {
    $("f_item").focus();
    throw new Error("An item is required.");
  }
  if (!noStock && !name) {
    $("f_name").focus();
    throw new Error("A customer name is required — or switch to Shop stock.");
  }

  let phone = null;
  if (!noStock && phoneRaw) {
    const formatted = noPhone(phoneRaw);
    // Same rule the importer and the form trigger use: anything that is not a
    // usable number is kept as a note rather than stored as a phone.
    if (/^\d{3}-\d{3}-\d{4}$/.test(formatted)) phone = formatted;
    else notes.push("phone on file: " + phoneRaw);
  }

  const typed = $("f_notes").value.trim();
  if (typed) notes.unshift(typed);

  const submitted = new Date().toISOString();
  return items.map((item) => ({
    customer_name: noStock ? "Stock" : name,
    is_stock: noStock,
    phone,
    item,
    quantity: Math.max(1, parseInt($("f_qty").value, 10) || 1),
    fitting: noStock ? null : ($("f_fitting").value || null),
    order_location: $("f_orderloc").value || null,
    pickup_location: $("f_pickuploc").value || null,
    notes: notes.length ? notes.join("; ") : null,
    source: "in_shop",
    // Null on purpose: it means the shop has not placed this with a
    // distributor yet, which is what pins it to the top of the orders page.
    shop_order_date: null,
    submitted_at: submitted,
  }));
}

async function noSave(keepOpen) {
  let rows;
  try {
    rows = noReadForm();
  } catch (err) {
    noStatus(err.message, true);
    return;
  }

  const btn = keepOpen ? $("f_saveanother") : $("f_save");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    // One request for all of them, so a split entry lands whole or not at all.
    const created = (await db.insert("orders", rows)) || [];
    customers.invalidate();
    rows.forEach((row, i) => noSession.unshift(created[i] || row));
    noRenderSession();
    const who = rows[0].is_stock ? "Stock" : rows[0].customer_name;
    noStatus(rows.length === 1
      ? who + " — " + rows[0].item + " added."
      : who + " — " + rows.length + " orders added.");

    // Refresh the table behind the dialog. The point of taking the order here
    // is that it turns up in the book you are already looking at.
    load().catch((err) => console.error("Could not refresh the orders table:", err));

    if (keepOpen) {
      // Locations and mode carry over: stock gets entered in runs, and a
      // customer standing at the counter usually orders more than one thing.
      $("f_item").value = "";
      $("f_qty").value = "1";
      $("f_notes").value = "";
      noRenderSplit();
      $("f_item").focus();
    } else {
      noClearForm();
      $("orderdlg").close();
    }
  } catch (err) {
    noStatus(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function noClearForm() {
  for (const id of ["f_name", "f_phone", "f_item", "f_notes"]) $(id).value = "";
  $("f_qty").value = "1";
  $("f_fitting").value = "";
  $("f_orderloc").value = "";
  $("f_pickuploc").value = "";
  noRenderSplit();
}

// What was just added -- so a typo caught two seconds later is one click to fix.
function noRenderSession() {
  $("o_savedwrap").classList.toggle("hidden", noSession.length === 0);
  const list = $("o_savedlist");
  list.innerHTML = "";

  for (const row of noSession) {
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
          noSession = noSession.filter((r) => r.id !== row.id);
          noRenderSession();
          noStatus("Removed " + row.item + ".");
          load().catch(() => {});
        } catch (err) {
          undo.disabled = false;
          noStatus(err.message, true);
        }
      });
      el.appendChild(undo);
    }
    list.appendChild(el);
  }
}

function noOpen() {
  noSession = [];
  noRenderSession();
  noClearForm();
  noStatus("");
  noSetMode(false);
  $("orderdlg").showModal();
  $("f_item").focus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$("neworder").addEventListener("click", noOpen);
$("o_close").addEventListener("click", () => $("orderdlg").close());
$("o_mode_customer").addEventListener("click", () => noSetMode(false));
$("o_mode_stock").addEventListener("click", () => noSetMode(true));

$("orderform").addEventListener("submit", (e) => {
  e.preventDefault();
  noSave(false);
});
$("f_saveanother").addEventListener("click", () => noSave(true));
$("f_item").addEventListener("input", noRenderSplit);
$("f_keepone").addEventListener("change", noRenderSplit);

// Enter in the item box is the fast path for stock runs.
$("f_item").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    noSave(true);
  }
});

// Arriving from the old order.html bookmark opens the dialog straight away, so
// that URL still does what the person pressing it expects.
if (new URLSearchParams(location.search).get("new") === "1") noOpen();

customers.attach("f_name", "f_phone");
