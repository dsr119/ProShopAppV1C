const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup() {
  class El {
    constructor() {this.value='Both';this.textContent='';this.children=[];this.disabled=false;this.classList={add(){},remove(){},toggle(){}};}
    replaceChildren(){this.children=[];}
    append(...els){this.children.push(...els);}
    appendChild(el){this.children.push(el);}
    setAttribute(){}
    addEventListener(name,fn){this[name]=fn;}
    focus(){}
    select(){}
    showModal(){this.open=true;}
    close(){this.open=false;}
  }
  const els = {};
  const ctx = vm.createContext({console, Set, navigator:{clipboard:{writeText:async()=>{}}},document:{getElementById:id=>els[id]??=(new El()),createElement:()=>new El()}});
  for (const [file, stop] of [['drilling.js','// Wiring\n'],['drilling-export.js',"$('export_open').addEventListener"]]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../app',file),'utf8').split(stop)[0],ctx);
  }
  return {ctx,els};
}
const order = (id, extra={}) => ({id,customer_name:'Sample Customer',item:'Sample Ball',pickup_location:'Valley',...extra});

test('all-quarter export excludes finished, stock, deleted and booked rows including past/completed bookings',()=>{
  const {ctx}=setup();
  const rows=[order('open'),order('older',{quarter:'2025 Q1'}),order('drilled',{drilled:true}),order('no-drill',{no_drill_needed:true}),order('collected',{out_the_door:true}),order('stock',{is_stock:true}),order('deleted',{deleted_at:'date'}),order('booked')];
  const result=ctx.unscheduledOrders(rows,[{order_id:'booked',completed:true,appt_date:'2025-01-01'}]);
  assert.deepEqual(Array.from(result,r=>r.id).sort(),['older','open']);
});
test('legacy exact item bookings are omitted; deleted bookings and name-only matches do not hide orders',()=>{
  const {ctx}=setup();
  assert.equal(ctx.unscheduledOrders([order('one')],[{customer_name:'sample customer',service:' Drill  Sample Ball '}]).length,0);
  assert.equal(ctx.unscheduledOrders([order('one')],[{customer_name:'Sample Customer',service:'Other Ball'}]).length,1);
  assert.equal(ctx.unscheduledOrders([order('one')],[{order_id:'one',deleted_at:'date'}]).length,1);
});
test('location switch uses pickup, falls back to order location and includes Both at either shop',()=>{
  const {ctx}=setup();
  assert.equal(ctx.exportMatchesLocation(order('one'),'South Side'),false);
  assert.equal(ctx.exportMatchesLocation(order('one',{pickup_location:'Both'}),'South Side'),true);
  assert.equal(ctx.exportMatchesLocation(order('one',{pickup_location:null,order_location:'South Side'}),'South Side'),true);
  assert.equal(ctx.exportMatchesLocation(order('one',{pickup_location:null}),'Both'),true);
});
test('copy text contains names, balls, quantities and locations without phone or private notes',()=>{
  const {ctx}=setup();
  const text=ctx.exportText([order('one',{quantity:2,phone:'5551234',notes:'private',customer_name:'Sample\nCustomer'})],'Both');
  assert.equal(text,'Not drilled or scheduled — Both\n\n• Sample Customer — Sample Ball ×2 (Valley)');
});
test('removals affect only the export and survive switching locations',async()=>{
  const {ctx,els}=setup();
  const rows=[order('one'),order('two',{pickup_location:'South Side'})];
  ctx.db={selectAll:async table=>table==='orders'?rows:[]};
  await ctx.openDrillingExport();
  assert.equal(els.export_list.children.length,2);
  els.export_list.children[0].children[1].click();
  assert.equal(els.export_list.children.length,1);
  els.export_location.value='Valley';ctx.renderExport();assert.equal(els.export_copy.disabled,true);
  els.export_location.value='Both';ctx.renderExport();assert.equal(els.export_list.children.length,1);
  assert.equal(rows.length,2);
  await ctx.openDrillingExport();assert.equal(els.export_list.children.length,2);
});
test('copy success confirms and closes; clipboard failure keeps the dialog and exposes manual text',async()=>{
  const {ctx,els}=setup();ctx.db={selectAll:async t=>t==='orders'?[order('one')]:[]};
  await ctx.openDrillingExport();let text;
  ctx.navigator.clipboard.writeText=async value=>{text=value;};
  await ctx.copyDrillingExport();assert.match(text,/Sample Customer — Sample Ball/);assert.equal(els.exportdlg.open,false);assert.equal(els.export_notice.textContent,'Copied to clipboard');
  await ctx.openDrillingExport();ctx.navigator.clipboard.writeText=async()=>{throw new Error('denied');};
  await ctx.copyDrillingExport();assert.equal(els.exportdlg.open,true);assert.match(els.export_manual.value,/Sample Ball/);
});
test('failed appointment reads prevent copying an incomplete list',async()=>{
  const {ctx,els}=setup();ctx.db={selectAll:async t=>{if(t==='appointments')throw new Error('offline');return [order('one')];}};
  await ctx.openDrillingExport();assert.equal(els.export_copy.disabled,true);assert.match(els.export_status.textContent,/Could not load the complete list/);
});
