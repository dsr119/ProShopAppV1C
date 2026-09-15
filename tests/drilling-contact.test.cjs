const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function setup(update) {
  const ctx=vm.createContext({console,Date,Intl});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/drilling.js'),'utf8').split('// Wiring\n')[0],ctx);
  ctx.db={update,selectAll:async()=>[{id:'one',last_contacted_at:'2026-07-01T12:00:00Z'}]};
  const button={},note={};
  const cell={querySelector:s=>s==='button'?button:note};
  const errors=[];ctx.showError=e=>errors.push(e.message);
  return {ctx,cell,button,note,errors};
}
test('daily state uses Eastern midnight, not UTC midnight',()=>{
  const {ctx}=setup();
  assert.equal(ctx.contactedToday('2026-09-15T23:00:00Z',new Date('2026-09-16T03:59:59Z')),true);
  assert.equal(ctx.contactedToday('2026-09-15T23:00:00Z',new Date('2026-09-16T04:00:00Z')),false);
  assert.equal(ctx.contactedToday(null),false);
});
test('daily reset handles winter offset and daylight saving transitions',()=>{
  const {ctx}=setup();
  assert.equal(ctx.contactedToday('2026-12-01T18:00:00Z',new Date('2026-12-02T04:59:59Z')),true);
  assert.equal(ctx.contactedToday('2026-12-01T18:00:00Z',new Date('2026-12-02T05:00:00Z')),false);
  assert.equal(ctx.contactedToday('2026-11-01T05:30:00Z',new Date('2026-11-01T06:30:00Z')),true);
});
test('successful contact saves returned timestamp, disables today and ignores repeat clicks',async()=>{
  let calls=0;
  const {ctx,cell,button,note}=setup(async(_,filter,patch)=>{calls++;assert.match(filter,/deleted_at=is.null/);return [{id:'one',...patch}];});
  await ctx.loadContacts();await ctx.markContact({id:'one'},cell);await ctx.markContact({id:'one'},cell);
  assert.equal(calls,1);assert.equal(button.disabled,true);assert.equal(button.textContent,'Contacted today ✓');assert.match(note.textContent,/Last:/);
});
test('failed or empty saves keep prior timestamp and allow retry',async()=>{
  for(const update of [async()=>{throw new Error('offline');},async()=>[]]) {
    const {ctx,cell,button,note,errors}=setup(update);
    await ctx.loadContacts();await ctx.markContact({id:'one'},cell);
    assert.equal(button.disabled,false);assert.match(note.textContent,/Jul 1, 2026/);assert.equal(errors.length,1);
  }
});
test('missing migration disables tracking but does not reject the queue load',async()=>{
  const {ctx,cell,button,note}=setup();
  ctx.db.selectAll=async()=>{throw new Error('missing column');};
  await ctx.loadContacts();ctx.paintContact(cell,{id:'one'});
  assert.equal(button.disabled,true);assert.equal(note.textContent,'Contact status unavailable');
});
