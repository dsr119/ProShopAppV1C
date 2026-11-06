// Demo stand-in for app/db.js.
//
// Same five verbs, same PostgREST-style query strings, but every table lives in
// memory and is filled with made-up rows when the page loads. Nothing is sent
// anywhere: there is no fetch in this file, and config.js is not loaded.
// Refreshing the page starts over from the sample data.

(() => {
  // ---------------------------------------------------------------- sample data
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = a => a[Math.floor(rand() * a.length)];
  const uid = () => "demo-" + Math.floor(rand() * 1e12).toString(36) + "-" + (++uidN);
  let uidN = 0;

  const pad = n => String(n).padStart(2, "0");
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const day = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const stamp = (n, h = 15) => { const d = day(n); d.setHours(h, Math.floor(rand() * 60)); return d.toISOString(); };

  const FIRST = ["Alex", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Sam", "Jamie", "Chris", "Pat",
                 "Drew", "Quinn", "Avery", "Logan", "Reese", "Cameron", "Dana", "Jesse", "Kendall", "Rowan"];
  const LAST = ["Sample", "Example", "Demo", "Tester", "Placeholder", "Mockford", "Fakely", "Notreal",
                "Pretendo", "Dummyson"];
  const STAFF = ["Keith", "Amy", "Doug", "Mike", "Lisa"];
  const BALLS = ["Storm Phaze 6", "Roto Grip Hustle Ink", "Motiv Venom Shock", "Hammer Black Widow 3.0",
                 "Brunswick Prism", "Storm IQ Tour", "Radical Bonus Zone", "Ebonite Game Breaker 5 Solid",
                 "DV8 Hater", "Track Kinetic Ruby", "900 Global Zen", "Columbia 300 Swerve"];
  const OTHER = ["Dexter SST 8 Pro shoes", "Storm 3-ball roller bag", "Vise thumb inserts (10)",
                 "Ebonite wrist positioner", "Brunswick ball towel", "Vise grip tape"];
  const SUPPLIERS = ["Ace Mitchell", "Storm direct", "Brunswick direct", "Vise"];
  const LOCS = ["Valley", "South Side"];

  // Names are obviously fake; phones use the reserved 555-0100..0199 range.
  const people = [];
  for (let i = 0; i < 26; i++) {
    people.push({ name: `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
                  phone: `570-555-01${pad(i + 10)}` });
  }

  const orders = [];
  for (let i = 0; i < 46; i++) {
    const p = pick(people);
    const ageDays = -Math.floor(rand() * 75);
    const ball = rand() < 0.75;
    const ordered = ageDays < -3 || rand() < 0.4;
    const shopDate = ordered ? iso(day(ageDays + 1)) : null;
    const done = ageDays < -30 && rand() < 0.7;
    const drilled = ball && (done || (ageDays < -10 && rand() < 0.5));
    const stock = rand() < 0.08;
    orders.push({
      id: uid(),
      legacy_id: null,
      created_at: stamp(ageDays), updated_at: stamp(ageDays),
      submitted_at: stamp(ageDays, 10 + Math.floor(rand() * 10)),
      source: pick(["in_shop", "in_shop", "google_form", "website"]),
      customer_name: stock ? "Shop stock" : p.name,
      is_stock: stock,
      phone: stock ? null : p.phone,
      email: null,
      item: ball ? pick(BALLS) + (rand() < 0.5 ? " 15 lb" : " 14 lb") : pick(OTHER),
      quantity: rand() < 0.9 ? 1 : 2,
      fitting: ball ? pick(["Specs on file", "Need appointment", "Specs on file"]) : null,
      notes: rand() < 0.2 ? "Wants it before Thursday league" : null,
      order_location: pick(LOCS), pickup_location: pick(LOCS),
      shop_order_date: shopDate,
      supplier: ordered ? pick(SUPPLIERS) : null,
      supplier_order_no: ordered ? "PO-" + (4200 + i) : null,
      invoice_no: null,
      price: ball ? pick([164.95, 189.95, 209.95, 229.95]) : pick([24.95, 59.95, 119.95]),
      paid: rand() < 0.6,
      out_the_door: done,
      has_been_called: done || (drilled && rand() < 0.5),
      time_called: null,
      staff_member: pick(STAFF),
      internal_notes: rand() < 0.15 ? "Called, left voicemail" : null,
      deleted_at: null,
      drilled, drilled_at: drilled ? stamp(ageDays + 5) : null,
      no_drill_needed: !ball,
      checked_in_at: ordered && ageDays < -6 && rand() < 0.6 ? stamp(ageDays + 6) : null,
      last_contacted_at: null,
      due_date: ball && !done ? iso(day(Math.floor(rand() * 10) + 1)) : null,
    });
  }
  // A few fresh ones that have not been ordered from the supplier yet.
  for (let i = 0; i < 4; i++) {
    const p = people[i + 3];
    orders.push({ ...orders[i], id: uid(), customer_name: p.name, phone: p.phone, is_stock: false,
      submitted_at: stamp(-i, 11 + i), shop_order_date: null, supplier: null, supplier_order_no: null,
      out_the_door: false, drilled: false, drilled_at: null, checked_in_at: null, item: pick(BALLS) + " 15 lb",
      no_drill_needed: false, fitting: "Specs on file" });
  }

  const SERVICES = ["Drill new ball", "Fitting / layout", "Plug and redrill", "Resurface", "Lesson",
                    "Oil extraction", "Thumb slug fit"];
  const appointments = [];
  for (let i = 0; i < 24; i++) {
    const p = pick(people);
    const n = Math.floor(rand() * 21) - 5;
    appointments.push({
      id: uid(), legacy_id: null, created_at: stamp(n - 3), updated_at: stamp(n - 3),
      customer_name: p.name, phone: p.phone, service: pick(SERVICES), location: pick(LOCS),
      appt_date: iso(day(n)), appt_time: `${pad(13 + Math.floor(rand() * 7))}:${pick(["00", "30"])}:00`,
      completed: n < 0, notes: null, deleted_at: null, order_id: null,
    });
  }

  const staff = STAFF.map((name, i) => ({ id: uid(), created_at: stamp(-200), updated_at: stamp(-200),
                                           name, active: true, sort_order: i }));

  const TICKETS = [
    ["Lane 12 ball return jammed", "Equipment", "urgent"],
    ["Low on thumb inserts (1 1/8)", "Supplies", "normal"],
    ["Drill press belt squealing", "Equipment", "high"],
    ["Customer: plug and redrill Storm Phaze 6", "Customer", "normal"],
    ["Front counter PC slow to boot", "Computer", "normal"],
    ["Order more grip tape", "Supplies", "low"],
    ["Light out over the bench", "Building", "normal"],
    ["Customer: resurface two balls before tournament", "Customer", "high"],
  ];
  const tickets = TICKETS.map(([title, category, priority], i) => {
    const status = ["new", "new", "assigned", "in_progress", "new", "done", "blocked", "assigned"][i];
    const p = people[i + 5];
    return {
      id: uid(), created_at: stamp(-i * 2), updated_at: stamp(-i),
      submitted_at: stamp(-i * 2, 14), submitted_by: pick(STAFF), location: pick(LOCS),
      title, category, priority, status,
      details: category === "Customer" ? `Customer: ${p.name} (${p.phone})` : "Noticed during the evening shift.",
      assigned_to: status === "new" ? null : pick(STAFF), assigned_at: status === "new" ? null : stamp(-i),
      due_date: i % 3 === 0 ? iso(day(i)) : null, resolution: status === "done" ? "Fixed" : null,
      completed_at: status === "done" ? stamp(-1) : null, deleted_at: null, plug_state: null,
    };
  });

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const hours = [];
  const monday = day(-((today.getDay() + 6) % 7));
  for (let w = -1; w < 2; w++) for (const location of LOCS) DAYS.forEach((dname, i) => {
    const d = new Date(monday); d.setDate(d.getDate() + w * 7 + i);
    const closed = (location === "South Side" && i === 0) || i === 6 && location === "Valley";
    hours.push({ id: uid(), created_at: stamp(-30), updated_at: stamp(-30), location, day: dname,
                 date: iso(d), day_index: i, open1: closed ? null : (i >= 5 ? "12:00 PM" : "4:00 PM"),
                 close1: closed ? null : "9:00 PM", note1: null, open2: null, close2: null, note2: null });
  });

  const items = [...BALLS, ...OTHER].map((item, i) => ({ item, times_ordered: 60 - i * 3, last_ordered: iso(day(-i)) }));
  const customer_directory = people.map(p => ({ id: uid(), customer_name: p.name, phone: p.phone,
                                                source: "square", created_at: stamp(-300), deleted_at: null }));

  const TABLES = { orders, appointments, staff, tickets, hours, items, customer_directory,
                   balls: [], staff_bags: [], voice_aliases: [], voice_review: [] };

  // Generated column, kept current on every write.
  const quarterOf = d => d ? `${d.slice(0, 4)} Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}` : null;
  const touch = (table, row) => { if (table === "orders") row.quarter = quarterOf(row.shop_order_date); return row; };
  orders.forEach(r => touch("orders", r));

  // ------------------------------------------------------- PostgREST mini-engine
  const literal = v => v === "null" ? null : v === "true" ? true : v === "false" ? false : v;
  const cmp = (a, b) => {
    if (a == null || b == null) return null;
    const na = Number(a), nb = Number(b);
    if (typeof a !== "boolean" && a !== "" && b !== "" && !isNaN(na) && !isNaN(nb)
        && !/^\d{4}-/.test(String(a))) return na - nb;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  };
  const likeRe = (p, flags) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", flags);

  // One condition: column + "op.value" (with optional "not." prefix).
  function test(row, col, expr) {
    let neg = false;
    if (expr.startsWith("not.")) { neg = true; expr = expr.slice(4); }
    const dot = expr.indexOf(".");
    const op = expr.slice(0, dot), raw = expr.slice(dot + 1);
    const v = row[col];
    let ok;
    switch (op) {
      case "eq":    ok = v != null && String(v) === String(literal(raw)); break;
      case "neq":   ok = v != null && String(v) !== String(literal(raw)); break;
      case "is":    ok = raw === "null" ? v == null : v === literal(raw); break;
      case "gt":    ok = cmp(v, raw) > 0; break;
      case "gte":   ok = cmp(v, raw) >= 0; break;
      case "lt":    ok = cmp(v, raw) < 0; break;
      case "lte":   ok = cmp(v, raw) <= 0; break;
      case "like":  ok = v != null && likeRe(raw).test(String(v)); break;
      case "ilike": ok = v != null && likeRe(raw, "i").test(String(v)); break;
      case "in":    ok = raw.replace(/^\(|\)$/g, "").split(",").map(s => s.replace(/^"|"$/g, ""))
                          .includes(String(v)); break;
      default: throw new Error("demo db: unsupported operator " + op);
    }
    return neg ? !ok : ok;
  }

  // Split on commas that are not inside parentheses.
  function splitTop(s) {
    const out = []; let depth = 0, cur = "";
    for (const c of s) {
      if (c === "(") depth++; if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }
  // "or=(a.eq.1,and(b.is.null,c.gt.2))" style groups.
  function group(row, kind, body) {
    const parts = splitTop(body).map(part => {
      const m = part.match(/^(not\.)?(and|or)\((.*)\)$/);
      if (m) { const r = group(row, m[2], m[3]); return m[1] ? !r : r; }
      const dot = part.indexOf(".");
      return test(row, part.slice(0, dot), part.slice(dot + 1));
    });
    return kind === "or" ? parts.some(Boolean) : parts.every(Boolean);
  }

  function parse(query) {
    const q = { filters: [], order: [], select: null, limit: null };
    for (const pair of (query || "").split("&").filter(Boolean)) {
      const eqAt = pair.indexOf("=");
      const key = decodeURIComponent(pair.slice(0, eqAt));
      const val = decodeURIComponent(pair.slice(eqAt + 1));
      if (key === "select") q.select = val === "*" ? null : val.split(",");
      else if (key === "order") q.order = val.split(",").map(s => {
        const [col, dir = "asc", nulls] = s.split(".");
        return { col, desc: dir === "desc", nullsFirst: nulls ? nulls === "nullsfirst" : dir === "desc" };
      });
      else if (key === "limit") q.limit = +val;
      else if (key === "offset" || key === "on_conflict") continue;
      else if (key === "or" || key === "and") q.filters.push(row => group(row, key, val.replace(/^\(|\)$/g, "")));
      else q.filters.push(row => test(row, key, val));
    }
    return q;
  }

  function run(table, query) {
    const rows = TABLES[table];
    if (!rows) throw new Error("demo db: no sample table " + table);
    const q = parse(query);
    let out = rows.filter(r => q.filters.every(f => f(r)));
    if (q.order.length) out = out.slice().sort((a, b) => {
      for (const o of q.order) {
        const x = a[o.col], y = b[o.col];
        if (x == null && y == null) continue;
        if (x == null) return o.nullsFirst ? -1 : 1;
        if (y == null) return o.nullsFirst ? 1 : -1;
        const c = cmp(x, y);
        if (c) return o.desc ? -c : c;
      }
      return 0;
    });
    if (q.limit != null) out = out.slice(0, q.limit);
    return { matched: out, select: q.select };
  }
  const shape = (rows, select) => rows.map(r => {
    if (!select) return { ...r };
    const o = {}; select.forEach(c => { o[c] = r[c] ?? null; }); return o;
  });
  const settle = v => new Promise(res => setTimeout(() => res(JSON.parse(JSON.stringify(v))), 60));

  function fill(table, row) {
    const now = new Date().toISOString();
    const base = { id: uid(), created_at: now, updated_at: now, deleted_at: null };
    if (table === "tickets") Object.assign(base, { submitted_at: now, status: "new", priority: "normal" });
    if (table === "orders") Object.assign(base, { quantity: 1, is_stock: false, paid: false, out_the_door: false,
      has_been_called: false, drilled: false, no_drill_needed: false });
    if (table === "staff") base.active = true;
    if (table === "appointments") base.completed = false;
    return touch(table, { ...base, ...row });
  }
  const sameKey = (a, b, keys) => keys.every(k => String(a[k]) === String(b[k]));

  const db = {
    select(table, query = "") { const r = run(table, query); return settle(shape(r.matched, r.select)); },
    selectAll(table, query = "") { return db.select(table, query); },

    insert(table, rows) {
      const added = (Array.isArray(rows) ? rows : [rows]).map(r => fill(table, r));
      TABLES[table].push(...added);
      return settle(added);
    },

    upsert(table, rows, conflict) {
      const keys = conflict.split(","), out = [];
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        const hit = TABLES[table].find(x => sameKey(x, r, keys));
        if (hit) { Object.assign(hit, r, { updated_at: new Date().toISOString() }); touch(table, hit); out.push(hit); }
        else { const n = fill(table, r); TABLES[table].push(n); out.push(n); }
      }
      return settle(out);
    },

    insertMissing(table, rows, conflict) {
      const keys = conflict.split(","), out = [];
      for (const r of rows) if (!TABLES[table].some(x => sameKey(x, r, keys))) {
        const n = fill(table, r); TABLES[table].push(n); out.push(n);
      }
      return settle(out);
    },

    update(table, filter, patch) {
      const hits = run(table, filter).matched;
      hits.forEach(r => { Object.assign(r, patch, { updated_at: new Date().toISOString() }); touch(table, r); });
      return settle(hits);
    },

    softDelete(table, id) { return db.update(table, `id=eq.${id}`, { deleted_at: new Date().toISOString() }); },
    restore(table, id) { return db.update(table, `id=eq.${id}`, { deleted_at: null }); },
  };

  window.db = db;
  window.SUPABASE_URL = "demo://in-memory";   // nothing reads these in the demo; set so no code breaks
  window.SUPABASE_KEY = "demo";

  // ------------------------------------------------------------- demo banner
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.setAttribute("role", "note");
    bar.style.cssText = "position:sticky;top:0;z-index:9999;background:#fff4d6;color:#5a4300;" +
      "border-bottom:1px solid #e6c766;font:600 13px/1.4 system-ui,sans-serif;padding:7px 14px;text-align:center";
    bar.innerHTML = 'Demo with made-up sample data. Changes stay in this tab and reset on refresh. ' +
      '<a href="https://github.com/dsr119/ProShopAppV1C" style="color:inherit">See the code</a>';
    document.body.prepend(bar);
  });
})();
