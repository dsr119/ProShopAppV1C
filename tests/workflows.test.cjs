const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '..', 'app', file), 'utf8');
function context(file, stop, extra = {}) {
  const ctx = vm.createContext({ Date, console, ...extra });
  vm.runInContext(source(file).split(stop)[0], ctx);
  return ctx;
}
const hours = () => context('hours.js', '/* ---------- wiring ---------- */');
const drilling = () => context('drilling.js', '// Wiring\n');
const monday = new Date(2026, 8, 14);
const seed = [{ location: 'Idle Hours South', day: 'Monday', date: '2026-08-31', open1: '6 PM', close1: '8 PM', open2: '9 PM', note2: 'After league' }];

test('hours recover after an extended gap with all 28 days and split-hour notes', () => {
  const rows = hours().missingHours(seed, monday);
  assert.equal(rows.length, 28);
  const mondays = rows.filter(r => r.location === 'Idle Hours South' && r.day === 'Monday');
  assert.equal(mondays.length, 2);
  for (const r of mondays) { assert.equal(r.open1, '6 PM'); assert.equal(r.open2, '9 PM'); assert.equal(r.note2, 'After league'); }
  assert.equal(rows.find(r => r.day === 'Tuesday').open1, null);
});

test('hours preserve saved dates, latest closure and do not copy future exceptions backwards', () => {
  const ctx = hours();
  const history = [...seed,
    { ...seed[0], date: '2026-09-07', open1: null, open2: null },
    { ...seed[0], date: '2026-09-21', open1: 'Holiday', open2: null }];
  const rows = ctx.missingHours(history, monday);
  assert.equal(rows.length, 27);
  assert.equal(rows.find(r => r.location === 'Idle Hours South' && r.date === '2026-09-14').open1, null);
  assert.equal(ctx.missingHours([...history, ...rows], monday).length, 0);
});

test('hours cross year and daylight saving boundaries with consecutive calendar dates', () => {
  for (const start of [new Date(2026, 11, 28), new Date(2026, 2, 2), new Date(2026, 9, 26)]) {
    const rows = hours().missingHours([], start).slice(0, 14);
    assert.equal(new Set(rows.map(r => r.date)).size, 14);
    assert.equal(rows[13].day, 'Sunday');
    const d = new Date(start); d.setDate(d.getDate() + 13);
    assert.equal(rows[13].date, hours().isoOf(d));
  }
});

test('load fills missing rows before readback; concurrent saved dates are retained', async () => {
  let stored = [...seed];
  const ctx = hours();
  ctx.db = {
    selectAll: async () => stored,
    insertMissing: async (_, rows) => {
      stored.push({ ...rows[0], open1: 'Concurrent edit' });
      for (const r of rows) if (!stored.some(s => s.date === r.date && s.location === r.location)) stored.push(r);
    },
    select: async (_, query) => {
      const from = query.match(/gte\.([^&]+)/)[1], to = query.match(/lte\.([^&]+)/)[1];
      return stored.filter(r => r.date >= from && r.date <= to);
    },
  };
  const result = await ctx.loadHours();
  assert.equal(result.this.idle.length, 7);
  assert.equal(result.next.valley.length, 7);
  assert.equal(result.this.idle[0].open1, 'Concurrent edit');
});

test('missing row request uses ignore-duplicates rather than overwriting existing hours', async () => {
  let options;
  const ctx = vm.createContext({window: {}, fetch: async (_, o) => {options = o; return {ok:true, text:async ()=>'[]'};}});
  vm.runInContext(source('db.js'), ctx);
  await ctx.window.db.insertMissing('hours', seed, 'location,date');
  assert.match(options.headers.Prefer, /resolution=ignore-duplicates/);
});

test('appointments require the exact order ID and distinguish upcoming, past and completed', () => {
  const ctx = drilling();
  const order = {id: 'one', customer_name: 'Sample Customer', item: 'Sample Ball'};
  const a = {order_id: 'one', appt_date: '2026-09-15', completed: false};
  assert.equal(ctx.appointmentStatus(order, [a], '2026-09-15').label, 'Scheduled');
  assert.equal(ctx.appointmentStatus({...order, id:'two'}, [a], '2026-09-15').label, 'Not scheduled');
  assert.equal(ctx.appointmentStatus(order, [a], '2026-09-16').label, 'Past appointment — check status');
  assert.equal(ctx.appointmentStatus(order, [{...a, completed:true}], '2026-09-16').label, 'Appointment completed');
});

test('legacy bookings are candidates only; name-only matches never imply the item is booked', () => {
  const ctx = drilling();
  const order = {id: 'one', customer_name: 'Sample Customer', item: 'Sample Ball'};
  const a = {customer_name:'sample customer', service:'Drill Sample Ball', completed:false};
  assert.match(ctx.appointmentStatus(order, [a], '2026-09-15').label, /Possible booking/);
  assert.equal(ctx.appointmentStatus(order, [{...a, service:'Drill Different Ball'}], '2026-09-15').label, 'Not scheduled');
});

class Element {
  constructor() { this.events={}; this.children=[]; this.value=''; this.textContent=''; this.disabled=false; this.classList={add(){},remove(){},toggle(){}}; }
  addEventListener(name, fn) { this.events[name]=fn; }
  appendChild(el) { this.children.push(el); }
  querySelector() { return this.children.at(-1) || null; }
  focus() {}
  select() {}
}
function orderEditor(update) {
  const ctx = context('orders.js','// Inline editing');
  // Load only the editor section so startup wiring never runs.
  vm.runInContext('function display(field, value) { return value ?? ""; }'+source('orders.js').slice(source('orders.js').indexOf('function editable('),source('orders.js').indexOf('function editable(')+source('orders.js').slice(source('orders.js').indexOf('function editable(')).indexOf('\nfunction ',1)),ctx);
  ctx.document={createElement:()=>new Element()};
  ctx.db={update}; ctx.render=()=>{}; ctx.showError=()=>{};
  return ctx;
}

test('stock rename saves name and stock flag atomically, and Stock returns the row to inventory', async () => {
  const patches=[];
  const ctx=orderEditor(async (_,filter,patch)=>{ patches.push({...patch}); });
  const order={id:'one',customer_name:'Stock',is_stock:true};
  for (const value of ['Sample Customer','Stock']) {
    const span=ctx.editable(order,'customer_name','text'); span.events.click();
    const input=span.children[0]; input.value=value; await input.events.blur();
  }
  assert.deepEqual(patches,[{customer_name:'Sample Customer',is_stock:false},{customer_name:'Stock',is_stock:true}]);
  assert.equal(order.is_stock,true);
});

test('failed stock saves leave local ownership unchanged; blank names do not write', async () => {
  let calls=0;
  const ctx=orderEditor(async ()=>{calls++;throw new Error('offline');});
  const order={id:'one',customer_name:'Stock',is_stock:true};
  for (const value of ['Sample Customer','   ']) {
    const span=ctx.editable(order,'customer_name','text'); span.events.click();
    const input=span.children[0]; input.value=value; await input.events.blur();
  }
  assert.equal(calls,1); assert.equal(order.customer_name,'Stock'); assert.equal(order.is_stock,true);
});

test('booking persists the exact order ID and reloads status immediately', async () => {
  const elements={s_service:{value:'Drill Sample Ball'},s_location:{value:'Valley'},s_time:{value:'14:00'},s_save:{},dlg:{close(){}}};
  const ctx=drilling(); ctx.document={getElementById:id=>elements[id]};
  let saved, refreshed=false, rendered=false;
  ctx.db={insert:async (_,row)=>{saved=row;}};
  ctx.loadAppointments=async ()=>{refreshed=true;}; ctx.render=()=>{rendered=true;};
  vm.runInContext('sched.order = {id:"order-one", customer_name:"Sample Customer"}; sched.picked="2026-09-15";',ctx);
  await ctx.bookAppointment({preventDefault(){}});
  assert.equal(saved.order_id,'order-one'); assert.equal(saved.appt_time,'14:00');
  assert.equal(refreshed,true); assert.equal(rendered,true);
});
