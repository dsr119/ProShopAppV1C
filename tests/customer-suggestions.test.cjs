const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('app/customers.js','utf8'),ctx);
const customers = ctx.window.customers;
test('deduplicates equivalent numbers but preserves same-name alternatives and shared family phones', () => {
  const rows = customers.contacts([
    {customer_name:'Alex Smith',phone:'(570) 555-0100'},
    {customer_name:' alex  smith ',phone:'+1 570-555-0100'},
    {customer_name:'Alex Smith',phone:'570-555-0101'},
    {customer_name:'Jamie Smith',phone:'570-555-0100'},
    {customer_name:'Stock',phone:'570-555-0100'},
    {customer_name:'Shop',phone:'570-555-0100',is_stock:true},
    {customer_name:'No number',phone:''},
  ]);
  assert.equal(rows.length,3);
  assert.equal(rows.filter(r=>r.name==='Alex Smith').length,2);
});
test('ticket contact remains readable in existing queue and can supply future suggestions', () => {
  const details = customers.ticketDetails(' Alex Smith ','570-555-0100',' Fit adjustment ');
  assert.equal(details,'Customer: Alex Smith\nPhone: 570-555-0100\n\nFit adjustment');
  assert.equal(customers.ticketContact(details).phone,'570-555-0100');
  assert.equal(customers.ticketDetails('','','Other task'),'Other task');
  assert.equal(customers.ticketDetails('','',''),null);
  assert.equal(Object.keys(customers.ticketContact('ordinary ticket')).length,0);
});

function pickerEnvironment(failAppointments = false) {
  let document;
  class Element {
    constructor() { this.children=[]; this.attributes={}; this.events={}; this.value=''; }
    append(...children) { for (const child of children) { child.parentNode=this; this.children.push(child); } }
    insertBefore(child, before) { child.parentNode=this; this.children.splice(this.children.indexOf(before),0,child); }
    setAttribute(k,v) { this.attributes[k]=v; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(k,fn) { (this.events[k] ||= []).push(fn); }
    dispatchEvent(e) { for (const fn of this.events[e.type] || []) fn(e); }
    replaceChildren() { this.children=[]; }
    focus() { document.activeElement=this; }
    scrollIntoView() {}
    async fire(type, extra={}) { for (const fn of this.events[type] || []) await fn({type,preventDefault(){},stopPropagation(){},...extra}); await new Promise(resolve=>setImmediate(resolve)); }
  }
  const name=new Element(), phone=new Element(), label=new Element(); label.append(name);
  document={activeElement:name,getElementById:id=>id==='name'?name:phone,createElement:()=>new Element()};
  const sandbox=vm.createContext({window:{},document,Event:class { constructor(type){this.type=type;} },db:{async selectAll(table){
    if(table==='appointments' && failAppointments) throw Error('offline');
    return table==='orders' ? [
      {customer_name:'Alex Smith',phone:'570-555-0100'},
      {customer_name:'Alex Smith',phone:'570-555-0101'},
    ] : table==='customer_directory' ? [{customer_name:'Imported Customer',phone:'570-555-0188'}] : [];
  }}});
  vm.runInContext(fs.readFileSync('app/customers.js','utf8'),sandbox);
  sandbox.window.customers.attach('name','phone');
  const wrap=name.parentNode;
  return {name,phone,list:wrap.children[1],status:wrap.children[2]};
}
test('keyboard selection fills the chosen phone, does not pick on typing, clears stale autofill',async()=>{
  const {name,phone,list}=pickerEnvironment();
  name.value='alex'; await name.fire('input');
  assert.equal(list.children.length,2); assert.equal(phone.value,'');
  await name.fire('keydown',{key:'ArrowDown'});
  await name.fire('keydown',{key:'ArrowDown'});
  await name.fire('keydown',{key:'Enter'});
  assert.equal(phone.value,'570-555-0101'); assert.equal(name.value,'Alex Smith');
  name.focus(); name.value='Jamie'; await name.fire('input');
  assert.equal(phone.value,'');
});
test('click selection preserves manual overrides and partial outages allow entry',async()=>{
  const {name,phone,list,status}=pickerEnvironment(true);
  name.value='smith'; await name.fire('input');
  assert.match(status.textContent,/could not load/);
  await list.children[0].fire('click');
  assert.equal(phone.value,'570-555-0100');
  phone.value='570-555-0199'; name.focus(); name.value='Jamie'; await name.fire('input');
  assert.equal(phone.value,'570-555-0199');
});

test('Square directory contacts participate in the same picker', async()=>{
  const {name,phone,list}=pickerEnvironment();
  name.value='imported'; await name.fire('input');
  assert.equal(list.children.length,1);
  await list.children[0].fire('click');
  assert.equal(name.value,'Imported Customer');
  assert.equal(phone.value,'570-555-0188');
});
