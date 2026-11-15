'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { Service } = require('../src/service.cjs');
const { createDemo } = require('../src/simulation.cjs');
const { selectedAssistant } = require('../src/discovery.cjs');
const { startWatcher, watcherPipe } = require('../src/watcher.cjs');
const M = require('../src/model.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
test('sampling uses live preferences, never overlaps, stops on pause/close and resumes once', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const {state}=createDemo(), store={state,dir:'/fixture',save:async value=>{store.state=structuredClone(M.validateState(value));}};
  const s=new Service(store,{demo:true}); s.core={};s.paused=false;let samples=0,release;
  s.tick=async()=>{samples++;if(release===null)await new Promise(r=>{release=r;});};
  try {
    s.scheduleSample();s.scheduleSample();t.mock.timers.tick(999);await flush();assert.equal(samples,0);
    t.mock.timers.tick(1);await flush();assert.equal(samples,1);
    await s.command('preferences',{sampleInterval:3000});t.mock.timers.tick(2999);await flush();assert.equal(samples,1);t.mock.timers.tick(1);await flush();assert.equal(samples,2);
    release=null;t.mock.timers.tick(3000);await flush();assert.equal(samples,3);t.mock.timers.tick(9000);await flush();assert.equal(samples,3);
    const changing=s.command('preferences',{sampleInterval:500});release();await changing;await flush();t.mock.timers.tick(499);await flush();assert.equal(samples,3);t.mock.timers.tick(1);await flush();assert.equal(samples,4);
    await s.command('pause');t.mock.timers.tick(5000);await flush();assert.equal(samples,4);
    s.paused=false;s.scheduleSample();t.mock.timers.tick(500);await flush();assert.equal(samples,5);
    await s.close();t.mock.timers.tick(5000);await flush();assert.equal(samples,5);
  } finally {await s.close();}
});
test('summary omits history and unchanged static state; preferences and latency invalidate it', async()=>{
  const {state}=createDemo(),s=new Service({state,dir:'/fixture'});s.connectionHistory.observe(Array.from({length:50000},(_,i)=>({id:String(i),bytes:i})),1);
  const first=s.summary(),second=s.summary({revision:first.revision});assert.ok(!Object.hasOwn(first.state,'connections'));assert.ok(!Object.hasOwn(second,'state'));assert.ok(Buffer.byteLength(JSON.stringify(second))<1000);
  s.store.state=structuredClone(state);assert.ok(s.summary({revision:first.revision}).state);
  const page=s.connectionHistory.page();assert.equal(page.total,50000);assert.equal(page.rows.length,10);
});
test('cached ownership invalidates for atomic replacement; action validation always rereads',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-cache-'));
  try{await fs.mkdir(path.join(dir,'profiles'));const {state}=createDemo();const file=path.join(dir,'profiles/own.yaml');await fs.writeFile(file,M.stringify(M.compile(state)));await fs.writeFile(path.join(dir,'profiles.yaml'),M.stringify({current:'own',items:[{uid:'own',type:'local',file:'own.yaml'}]}));assert.ok(await selectedAssistant(dir,state.owner,{cached:true}));assert.ok(await selectedAssistant(dir,state.owner,{cached:true}));await fs.writeFile(file,'proxies: []');assert.equal(await selectedAssistant(dir,state.owner,{cached:true}),false);assert.equal(await selectedAssistant(dir,state.owner),false);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('watcher shares snapshots, does not relaunch manual exit in same host session, detects restart and stops when disabled',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let hosts=[{key:'pid:created-1'}],follow=true,launches=0;
  const dir=path.join(os.tmpdir(),`watcher-fixture-${process.pid}`),watcher=startWatcher({dir,snapshot:async()=>({at:Date.now(),hosts,kernel:'fixture'}),readFollow:async()=>follow,launch:()=>launches++});let socket;
  try{
    await new Promise(r=>watcher.server.once('listening',r));const connected=new Promise(r=>watcher.server.once('connection',r));socket=net.connect(watcherPipe(dir));const peer=await connected;const received=new Promise(r=>socket.once('data',r));t.mock.timers.tick(2500);await received;assert.equal(launches,0);
    const disconnected=new Promise(r=>peer.once('close',r));socket.destroy();await disconnected;t.mock.timers.tick(2500);await flush();assert.equal(launches,0);
    hosts=[{key:'pid:created-2'}];t.mock.timers.tick(2500);await flush();assert.equal(launches,1);
    hosts=[];t.mock.timers.tick(2500);await flush();t.mock.timers.tick(2500);await flush();hosts=[{key:'pid:created-3'}];t.mock.timers.tick(2500);await flush();assert.equal(launches,2);
    follow=false;t.mock.timers.tick(2500);await flush();assert.equal(watcher.server.listening,false);
  }finally{socket?.destroy();watcher.stop();}
});
