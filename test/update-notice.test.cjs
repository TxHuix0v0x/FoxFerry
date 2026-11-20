'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {UpdateNotice}=require('../src/ui/update-notice.js');
test('in-app update reports download progress, keeps a red dot and surfaces failures',async()=>{
  let resolveInstall,rejectInstall,installs=0;
  const elements={
    'updates-button':{disabled:false,dotted:false,classList:{toggle(name,on){this.owner.dotted=on;}},setAttribute(){}},
    'update-result':{hidden:true,matches:()=>false,contains:()=>false},'update-text':{textContent:''},
    'update-install-button':{hidden:true,disabled:false},'release-button':{hidden:true}
  };
  elements['updates-button'].classList.owner=elements['updates-button'];
  const doc={getElementById:id=>elements[id]||null};
  const n=new UpdateNotice({document:doc,isSettings:()=>true,request:async()=>({status:'update',downloadable:true,message:'有新版本'}),installRequest:()=>{installs++;return new Promise((resolve,reject)=>{resolveInstall=resolve;rejectInstall=reject;});},now:()=>0,setTimer:()=>1,clearTimer(){}});
  await n.check();
  assert.equal(elements['update-install-button'].hidden,false);assert.equal(elements['release-button'].hidden,false);
  assert.equal(elements['updates-button'].dotted,true);
  const start=n.startUpdate();assert.equal(n.busy,true);
  n.progress({received:50,total:100});assert.match(elements['update-text'].textContent,/50%/);
  n.progress({received:1024,total:0});assert.match(elements['update-text'].textContent,/MB/);
  resolveInstall({started:true});await start;assert.equal(installs,1);assert.equal(n.busy,false);
  assert.match(elements['update-text'].textContent,/即将重启/);
  const failing=new UpdateNotice({document:doc,isSettings:()=>true,request:async()=>({status:'update',message:'有新版本'}),installRequest:async()=>{throw Error('下载失败');},now:()=>0,setTimer:()=>1,clearTimer(){}});
  await failing.check();await failing.startUpdate();
  assert.match(elements['update-text'].textContent,/更新失败：下载失败/);
});

test('notice lifetimes pause for hover/focus, expire, and ignore stale page responses',async()=>{
 let now=0,page=true,id=0;const timers=new Map();let resolve,calls=0;
 const n=new UpdateNotice({document:null,isSettings:()=>page,request:()=>{calls++;return new Promise(r=>resolve=r);},now:()=>now,setTimer:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimer:key=>timers.delete(key)});
 const check=n.check();await n.check();assert.equal(calls,1);resolve({status:'current',message:'latest'});await check;assert.equal(n.remaining,5000);
 now=2000;n.hold('hover',true);assert.equal(n.remaining,3000);assert.equal(timers.size,0);n.hold('focus',true);n.hold('hover',false);assert.equal(timers.size,0);n.hold('focus',false);assert.equal([...timers.values()][0].delay,3000);[...timers.values()][0].fn();assert.equal(n.result,null);
 const old=n.check(),oldResolve=resolve;page=false;n.leave();oldResolve({status:'update'});await old;assert.equal(n.result,null);
 page=true;const pending=n.check();const stale=resolve;n.leave();const fresh=n.check();stale({status:'update'});await pending;assert.equal(n.busy,true);resolve({status:'error',message:'offline'});await fresh;assert.equal(n.remaining,8000);
 n.leave();const update=n.check();resolve({status:'update'});await update;assert.equal(timers.size,0);assert.equal(n.result.status,'update');n.leave();assert.equal(n.result,null);
});
