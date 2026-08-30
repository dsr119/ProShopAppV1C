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
  "shop_order_date,submitted_at,drilled,drilled_at,out_the_door,paid,notes,quarter";

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
  if (!r.shop_order_date) return { key: "pending", label: "Not ordered" };
  return { key: "ordered", label: "Waiting to drill" };
}

function finished(r) {
  return r.drilled || r.out_the_door;
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

  const btn = document.createElement("button");
  if (r.drilled) {
    btn.textContent = "Undo";
    btn.title = r.drilled_at ? "Drilled " + shortDate(r.drilled_at) : "";
  } else {
    btn.textContent = "Drilled";
    btn.className = "primary";
    // Nothing to drill yet if the shop has not placed the order.
    if (!r.shop_order_date) {
      btn.disabled = true;
      btn.title = "Not ordered from the distributor yet";
    }
  }
  btn.addEventListener("click", () => toggleDrilled(r, btn));
  act.appendChild(btn);

  return tr;
}

async function toggleDrilled(r, btn) {
  const next = !r.drilled;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const patch = {
      drilled: next,
      drilled_at: next ? new Date().toISOString() : null,
    };
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

(async function init() {
  try {
    await loadQuarters();
    await load();
  } catch (err) {
    showError(err);
  }
})();
