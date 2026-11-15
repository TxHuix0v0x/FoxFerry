'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {UpdateNotice}=require('../src/ui/update-notice.js');
test('notice lifetimes pause for hover/focus, expire, and ignore stale page responses',async()=>{
 let now=0,page=true,id=0;const timers=new Map();let resolve,calls=0;
 const n=new UpdateNotice({document:null,isSettings:()=>page,request:()=>{calls++;return new Promise(r=>resolve=r);},now:()=>now,setTimer:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimer:key=>timers.delete(key)});
 const check=n.check();await n.check();assert.equal(calls,1);resolve({status:'current',message:'latest'});await check;assert.equal(n.remaining,5000);
 now=2000;n.hold('hover',true);assert.equal(n.remaining,3000);assert.equal(timers.size,0);n.hold('focus',true);n.hold('hover',false);assert.equal(timers.size,0);n.hold('focus',false);assert.equal([...timers.values()][0].delay,3000);[...timers.values()][0].fn();assert.equal(n.result,null);
 const old=n.check(),oldResolve=resolve;page=false;n.leave();oldResolve({status:'update'});await old;assert.equal(n.result,null);
 page=true;const pending=n.check();const stale=resolve;n.leave();const fresh=n.check();stale({status:'update'});await pending;assert.equal(n.busy,true);resolve({status:'error',message:'offline'});await fresh;assert.equal(n.remaining,8000);
 n.leave();const update=n.check();resolve({status:'update'});await update;assert.equal(timers.size,0);assert.equal(n.result.status,'update');n.leave();assert.equal(n.result,null);
});
