// Orders page.
//
// The sort is the feature: anything with no shop_order_date is work Amy has
// not placed with a distributor yet, so it sits at the top of the page under
// its own heading, regardless of which quarter is selected. Changing the
// quarter filter must never hide outstanding work.

const LOCATIONS = ["", "Valley", "South Side", "Both"];

let ORDERS = [];          // everything currently loaded
let SELECTED = new Set(); // ids ticked for a bulk update

const $ = (id) => document.getElementById(id);

function showError(err) {
  const box = $("error");
  box.textContent = String(err && err.message ? err.message : err);
  box.classList.remove("hidden");
  console.error(err);
}

function clearError() {
  $("error").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const COLUMNS =
  "id,submitted_at,source,customer_name,is_stock,phone,item,quantity,notes," +
  "order_location,pickup_location,shop_order_date,supplier,supplier_order_no," +
  "invoice_no,price,paid,out_the_door,quarter,migration_flag";

async function load() {
  clearError();
  try {
    // Two requests rather than one, so the pending queue is always complete
    // even when a single quarter is selected.
    const quarter = $("quarter").value;
    const base = `select=${COLUMNS}&deleted_at=is.null`;

    const pending = db.select(
      "orders",
      `${base}&shop_order_date=is.null&order=submitted_at.asc.nullslast`
    );

    const placed = db.select(
      "orders",
      `${base}&shop_order_date=not.is.null` +
        (quarter ? `&quarter=eq.${encodeURIComponent(quarter)}` : "") +
        `&order=shop_order_date.desc,submitted_at.desc`
    );

    const [a, b] = await Promise.all([pending, placed]);
    ORDERS = [...a, ...b];
    SELECTED.clear();
    render();
  } catch (err) {
    showError(err);
  }
}

async function loadQuarters() {
  // Distinct quarters, newest first. PostgREST has no DISTINCT, so pull the
  // column and reduce it here -- it is one small array.
  const rows = await db.select(
    "orders",
    "select=quarter&deleted_at=is.null&quarter=not.is.null&order=quarter.desc"
  );
  const seen = [...new Set(rows.map((r) => r.quarter))];
  const sel = $("quarter");
  for (const q of seen) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = q;
    sel.appendChild(opt);
  }
  // Default to the newest quarter that has orders.
  if (seen.length) sel.value = seen[0];
}

async function loadSuggestions() {
  const [items, sup] = await Promise.all([
    db.select("items", "select=item&order=times_ordered.desc&limit=1500"),
    db.select("orders", "select=supplier&deleted_at=is.null&supplier=not.is.null"),
  ]);
  fillDatalist("items", items.map((i) => i.item));
  fillDatalist("suppliers", [...new Set(sup.map((s) => s.supplier))].sort());
}

function fillDatalist(id, values) {
  const dl = $(id);
  dl.innerHTML = "";
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    dl.appendChild(o);
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function statusOf(o) {
  if (!o.shop_order_date) return "pending";
  if (o.out_the_door) return "done";
  return "ordered";
}

function visible() {
  const q = $("search").value.trim().toLowerCase();
  const loc = $("location").value;
  const st = $("status").value;

  return ORDERS.filter((o) => {
    if (loc && o.order_location !== loc && o.pickup_location !== loc) return false;

    if (st === "pending" && o.shop_order_date) return false;
    if (st === "ordered" && (!o.shop_order_date || o.out_the_door)) return false;
    if (st === "done" && !o.out_the_door) return false;
    if (st === "unpaid" && (o.paid || o.is_stock)) return false;

    if (q) {
      const hay = [
        o.customer_name, o.item, o.phone, o.supplier,
        o.supplier_order_no, o.invoice_no, o.notes,
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function money(v) {
  return v === null || v === undefined || v === "" ? "" : "$" + Number(v).toFixed(2);
}

function shortDate(v) {
  if (!v) return "";
  const [y, m, d] = v.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

function render() {
  const rows = visible();
  const body = $("rows");
  body.innerHTML = "";

  const pending = rows.filter((o) => !o.shop_order_date);
  const placed = rows.filter((o) => o.shop_order_date);

  if (pending.length) {
    body.appendChild(groupRow(`Not ordered yet — ${pending.length}`));
    pending.forEach((o) => body.appendChild(orderRow(o)));
  }
  if (placed.length) {
    const q = $("quarter").value;
    body.appendChild(groupRow(q ? `${q} — ${placed.length}` : `All quarters — ${placed.length}`));
    placed.forEach((o) => body.appendChild(orderRow(o)));
  }

  $("empty").classList.toggle("hidden", rows.length > 0);
  $("count").textContent =
    `${rows.length} of ${ORDERS.length} shown` +
    (pending.length ? ` · ${pending.length} awaiting order` : "");
  updateBulkBar();
}

function groupRow(label) {
  const tr = document.createElement("tr");
  tr.className = "grouprow";
  const td = document.createElement("td");
  td.colSpan = 17;
  td.textContent = label;
  tr.appendChild(td);
  return tr;
}

function orderRow(o) {
  const tr = document.createElement("tr");
  tr.dataset.id = o.id;
  const status = statusOf(o);
  if (status === "pending") tr.classList.add("pending");
  if (SELECTED.has(o.id)) tr.classList.add("selected");

  // checkbox
  const cbCell = td(tr, "Select");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = SELECTED.has(o.id);
  cb.addEventListener("change", () => {
    cb.checked ? SELECTED.add(o.id) : SELECTED.delete(o.id);
    tr.classList.toggle("selected", cb.checked);
    updateBulkBar();
  });
  cbCell.appendChild(cb);

  // status
  const label = { pending: "Not ordered", ordered: "Ordered", done: "Out the door" }[status];
  const st = td(tr, "Status");
  const b = document.createElement("span");
  b.className = "badge " + status;
  b.textContent = label;
  st.appendChild(b);
  if (o.migration_flag) {
    const f = document.createElement("span");
    f.className = "badge flag";
    f.textContent = "check";
    f.title = o.migration_flag;
    f.style.marginLeft = "4px";
    st.appendChild(f);
  }

  // customer
  const nameCell = td(tr, "Customer");
  if (o.is_stock) {
    nameCell.innerHTML = '<span class="stock">Stock</span>';
  } else {
    nameCell.appendChild(editable(o, "customer_name", "text"));
  }

  td(tr, "Item").appendChild(editable(o, "item", "text", { list: "items" }));
  td(tr, "Qty", "num").appendChild(editable(o, "quantity", "number"));
  td(tr, "Phone", "nowrap").appendChild(editable(o, "phone", "text"));
  td(tr, "Order loc").appendChild(editable(o, "order_location", "select", { options: LOCATIONS }));
  td(tr, "Pickup").appendChild(editable(o, "pickup_location", "select", { options: LOCATIONS }));
  td(tr, "Shop ordered", "nowrap").appendChild(editable(o, "shop_order_date", "date"));
  td(tr, "Supplier").appendChild(editable(o, "supplier", "text", { list: "suppliers" }));
  td(tr, "Order #").appendChild(editable(o, "supplier_order_no", "text"));
  td(tr, "Invoice #").appendChild(editable(o, "invoice_no", "text"));
  td(tr, "Price", "num").appendChild(editable(o, "price", "number"));
  td(tr, "Paid").appendChild(checkbox(o, "paid"));
  td(tr, "Out").appendChild(checkbox(o, "out_the_door"));
  td(tr, "Notes", "col-notes").appendChild(editable(o, "notes", "text"));

  const del = document.createElement("button");
  del.textContent = "×";
  del.title = "Remove this order";
  del.addEventListener("click", () => removeOrder(o, tr));
  td(tr, "Remove").appendChild(del);

  return tr;
}

function td(tr, label, cls) {
  const cell = document.createElement("td");
  if (label) cell.dataset.label = label;
  if (cls) cell.className = cls;
  tr.appendChild(cell);
  return cell;
}

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

function display(field, value) {
  if (value === null || value === undefined || value === "") return "";
  if (field === "price") return money(value);
  if (field === "shop_order_date") return shortDate(value);
  return String(value);
}

function editable(order, field, type, opts = {}) {
  const span = document.createElement("span");
  span.className = "cell";
  const paint = () => {
    const text = display(field, order[field]);
    span.textContent = text;
    span.classList.toggle("empty", text === "");
  };
  paint();

  span.addEventListener("click", () => {
    if (span.querySelector("input,select")) return;

    const input =
      type === "select"
        ? Object.assign(document.createElement("select"), {})
        : Object.assign(document.createElement("input"), { type });

    if (type === "select") {
      for (const v of opts.options) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v || "—";
        input.appendChild(o);
      }
      input.value = order[field] || "";
    } else {
      if (opts.list) input.setAttribute("list", opts.list);
      if (type === "number") input.step = field === "price" ? "0.01" : "1";
      input.value = order[field] === null || order[field] === undefined ? "" : order[field];
    }

    span.textContent = "";
    span.appendChild(input);
    input.focus();
    if (input.select) input.select();

    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      let value = input.value.trim();
      if (value === "") value = null;
      else if (type === "number") value = Number(value);

      if (value === order[field]) return paint();

      span.classList.add("saving");
      try {
        await db.update("orders", `id=eq.${order.id}`, { [field]: value });
        order[field] = value;
        span.classList.remove("saving", "saveerr");
        paint();
        // Clearing or setting the shop order date moves the row between the
        // pending queue and the placed list, so the page has to re-sort.
        if (field === "shop_order_date") render();
      } catch (err) {
        span.classList.remove("saving");
        span.classList.add("saveerr");
        paint();
        showError(err);
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { settled = true; paint(); }
    });
  });

  return span;
}

function checkbox(order, field) {
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!order[field];
  cb.addEventListener("change", async () => {
    const value = cb.checked;
    try {
      await db.update("orders", `id=eq.${order.id}`, { [field]: value });
      order[field] = value;
      if (field === "out_the_door") render();
    } catch (err) {
      cb.checked = !value;   // put it back
      showError(err);
    }
  });
  return cb;
}

async function removeOrder(order, tr) {
  const who = order.is_stock ? "Stock" : order.customer_name;
  if (!confirm(`Remove this order?\n\n${who} — ${order.item}\n\nIt is hidden, not erased, and can be restored.`)) {
    return;
  }
  try {
    await db.softDelete("orders", order.id);
    ORDERS = ORDERS.filter((o) => o.id !== order.id);
    SELECTED.delete(order.id);
    render();
  } catch (err) {
    showError(err);
  }
}

// ---------------------------------------------------------------------------
// Bulk "mark as ordered"
//
// Amy places one distributor order covering dozens of items, then records the
// same supplier / order # / invoice # against every one of them. In the
// workbook that meant typing the same four values 38 times.
// ---------------------------------------------------------------------------

function updateBulkBar() {
  $("selcount").textContent = SELECTED.size;
  $("bulkbar").classList.toggle("hidden", SELECTED.size === 0);
}

async function applyBulk() {
  const patch = {};
  if ($("b_date").value) patch.shop_order_date = $("b_date").value;
  if ($("b_supplier").value.trim()) patch.supplier = $("b_supplier").value.trim();
  if ($("b_order").value.trim()) patch.supplier_order_no = $("b_order").value.trim();
  if ($("b_invoice").value.trim()) patch.invoice_no = $("b_invoice").value.trim();

  if (!Object.keys(patch).length) {
    return showError(new Error("Fill in at least one field to apply."));
  }

  const ids = [...SELECTED];
  const btn = $("b_apply");
  btn.disabled = true;
  btn.textContent = "Applying…";

  try {
    // One request for the whole batch.
    await db.update("orders", `id=in.(${ids.join(",")})`, patch);
    for (const o of ORDERS) {
      if (SELECTED.has(o.id)) Object.assign(o, patch);
    }
    clearBulk();
    render();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Apply to selected";
  }
}

function clearBulk() {
  SELECTED.clear();
  $("checkall").checked = false;
  for (const id of ["b_date", "b_supplier", "b_order", "b_invoice"]) $(id).value = "";
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportCsv() {
  const rows = visible();
  const cols = [
    "customer_name", "item", "quantity", "phone", "order_location",
    "pickup_location", "shop_order_date", "supplier", "supplier_order_no",
    "invoice_no", "price", "paid", "out_the_door", "notes",
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(",")]
    .concat(rows.map((o) => cols.map((c) => esc(o[c])).join(",")))
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 150);
});

$("quarter").addEventListener("change", load);
$("location").addEventListener("change", render);
$("status").addEventListener("change", render);
$("export").addEventListener("click", exportCsv);
$("b_apply").addEventListener("click", applyBulk);
$("b_clear").addEventListener("click", () => { clearBulk(); render(); });

$("checkall").addEventListener("change", (e) => {
  const rows = visible();
  if (e.target.checked) rows.forEach((o) => SELECTED.add(o.id));
  else SELECTED.clear();
  render();
});

(async function init() {
  try {
    await loadQuarters();
    await load();
    loadSuggestions();   // not worth blocking the page on
  } catch (err) {
    showError(err);
  }
})();
