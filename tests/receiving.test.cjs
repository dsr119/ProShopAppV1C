const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(require('node:path').join(__dirname, '../app', name), 'utf8');
function model(extra={}) {
  const ctx=vm.createContext({window:{},Date,...extra});
  vm.runInContext(read('receiving.js'),ctx);
  return ctx.window.receiving;
}
test('arrival status is independent of drilling/payment/collection',()=>{
  const r=model();
  assert.equal(r.status({}).label,'Not ordered');
  assert.equal(r.status({shop_order_date:'2026-09-17',drilled:true}).key,'ordered');
  assert.equal(r.status({checked_in_at:'2026-09-17T12:00:00Z',out_the_door:true}).key,'received');
});
test('retains checked rows for exactly 24 hours, includes stock, excludes deleted/unordered/collected unchecked rows',()=>{
  const r=model(), now=Date.parse('2026-09-18T12:00:00Z');
  const row={shop_order_date:'2026-09-17',is_stock:true};
  assert.equal(r.visible(row,now),true);
  assert.equal(r.visible({...row,checked_in_at:'2026-09-17T12:00:01Z'},now),true);
  assert.equal(r.visible({...row,checked_in_at:'2026-09-17T12:00:00Z'},now),false);
  assert.equal(r.visible({...row,out_the_door:true},now),false);
  assert.equal(r.visible({...row,deleted_at:'2026-09-18'},now),false);
  assert.equal(r.visible({...row,shop_order_date:null},now),false);
  assert.equal(r.destination({pickup_location:'Valley',order_location:'South Side'}),'Valley');
  assert.equal(r.destination({order_location:'South Side'}),'South Side');
});
test('existing pages fall back only for missing check-in column, never hide other database failures',async()=>{
  const queries=[];
  const r=model({db:{selectAll:async(t,q)=>{queries.push(q);if(q.includes('checked_in_at'))throw Error('42703 checked_in_at does not exist');return [{id:'1'}];}}});
  assert.equal((await r.selectAll('orders','select=checked_in_at,id'))[0].id,'1');
  assert.equal(queries[1],'select=id');
  await assert.rejects(model({db:{selectAll:async()=>{throw Error('network offline');}}}).selectAll('orders','select=checked_in_at,id'),/offline/);
});
async function pageEnvironment({fail=false,conflict=false}={}) {
  class Element {
    constructor(){this.children=[];this.events={};this.value='';this.hidden=false;this.textContent='';this.className='';this.classList={toggle(){},add(){},remove(){}};}
    append(...els){this.children.push(...els);}
    replaceChildren(){this.children=[];}
    setAttribute(){}
    addEventListener(event,fn){this.events[event]=fn;}
  }
  const ids=Object.fromEntries(['refresh','search','location','error','notice','count','rows','empty'].map(k=>[k,new Element()]));
  const now=new Date().toISOString();
  const rows=[{id:'1',item:'Test ball',quantity:1,customer_name:'Sample Customer',pickup_location:'Valley',shop_order_date:now.slice(0,10),checked_in_at:null,out_the_door:false},
    {id:'2',item:'Test tape',quantity:3,is_stock:true,customer_name:'Stock',order_location:'South Side',shop_order_date:now.slice(0,10),checked_in_at:null,out_the_door:false}];
  const writes=[];
  const ctx=vm.createContext({window:{addEventListener(){}},document:{hidden:false,getElementById:id=>ids[id],createElement:()=>new Element(),addEventListener(){}},localStorage:{setItem(){}},setInterval(){},Date,console,
    db:{selectAll:async()=>structuredClone(rows),update:async(table,filter,patch)=>{
      writes.push({table,filter,patch});if(fail)throw Error('test failure');
      const row=rows.find(r=>filter.includes('id=eq.'+r.id));
      if(conflict){row.checked_in_at=now;return [];}
      Object.assign(row,patch);return [structuredClone(row)];
    }}});
  vm.runInContext(read('receiving.js'),ctx);ctx.receiving=ctx.window.receiving;
  vm.runInContext(read('check-in.js'),ctx);
  await new Promise(resolve=>setImmediate(resolve));
  const click=async(i=0)=>{const card=ids.rows.children[i],action=card.children[1];action.children.at(-1).events.click();await new Promise(resolve=>setImmediate(resolve));};
  return {ids,rows,writes,click};
}
test('check-in persists once, keeps grey row, and undo clears timestamp with compare-and-set',async()=>{
  const p=await pageEnvironment();
  assert.equal(p.ids.rows.children.length,2);
  await p.click();
  assert.match(p.writes[0].filter,/checked_in_at=is.null/);
  assert.ok(p.rows[0].checked_in_at);
  assert.equal(p.ids.rows.children.length,2);
  assert.match(p.ids.rows.children[1].className,/is-received/);
  await p.click(1);
  assert.match(p.writes[1].filter,/checked_in_at=eq./);
  assert.equal(p.rows[0].checked_in_at,null);
});
test('failed writes keep item unchecked; concurrent check-in reloads authoritative state',async()=>{
  const failed=await pageEnvironment({fail:true});await failed.click();
  assert.equal(failed.rows[0].checked_in_at,null);assert.match(failed.ids.error.textContent,/Could not save/);
  const concurrent=await pageEnvironment({conflict:true});await concurrent.click();
  assert.equal(concurrent.writes.length,1);assert.match(concurrent.ids.notice.textContent,/another device/);
  assert.match(concurrent.ids.rows.children[1].className,/is-received/);
});
test('location filtering and quantity label work for stock orders',async()=>{
  const p=await pageEnvironment();p.ids.location.value='South Side';p.ids.location.events.change();
  assert.equal(p.ids.rows.children.length,1);
  assert.equal(p.ids.rows.children[0].children[1].children[0].textContent,'Check in all 3');
  await p.click();assert.ok(p.rows[1].checked_in_at);
});
