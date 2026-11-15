'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const M = require('../src/model.cjs');
const R = require('../src/routing.cjs');
const { Store, atomicWrite } = require('../src/store.cjs');
const { Service } = require('../src/service.cjs');
const { createDemo } = require('../src/simulation.cjs');
const { ConnectionPager } = require('../src/ui/pager.js');
const input = (changes = {}) => ({ name: '应用分流', processes: [], processPaths: ['C:\\Program Files (x86)\\中文,工具\\app.exe'], domains: [], route: { mode: 'default' }, ...changes });
test('one-step creation inherits default, custom edits isolate shared legacy routes and deletion retains legacy data', () => {
  const { state } = createDemo(); const original = structuredClone(state.scenes);
  R.saveEntry(state,input()); const added = state.rules.at(-1); assert.equal(added.sceneId,state.defaultSceneId);
  state.scenes.find(s=>s.id===state.defaultSceneId).subscriptionId='backup'; assert.equal(state.scenes.find(s=>s.id===added.sceneId).subscriptionId,'backup');
  const first = state.rules[0], sibling=state.rules[1], oldId=first.sceneId;
  R.saveEntry(state,{...first,route:{mode:'custom',settings:{subscriptionId:'backup',selected:state.subscriptions[2].nodes[0].id}}});
  assert.notEqual(first.sceneId,oldId); assert.equal(sibling.sceneId,oldId); assert.equal(state.scenes.find(s=>s.id===first.sceneId).managedByRuleId,first.id);
  const custom=first.sceneId; R.saveEntry(state,{...first,route:{mode:'default'}}); assert.equal(first.sceneId,state.defaultSceneId); assert.ok(!state.scenes.some(s=>s.id===custom));
  R.removeEntry(state,added.id); for(const s of original)assert.ok(state.scenes.some(n=>n.id===s.id));
});
test('exact path matching handles Chinese, spaces, parentheses, comma, regex characters and same-name executable isolation', () => {
  const { state }=createDemo(); R.saveEntry(state,input({domains:['example.com']})); const r=state.rules.at(-1), file=r.processPaths[0];
  const pattern=M.pathPattern(file); assert.ok(new RegExp(pattern,'i').test(file.toUpperCase())); assert.ok(!new RegExp(pattern,'i').test('D:\\other\\app.exe')); assert.ok(!/[(),]/.test(pattern));
  assert.ok(M.matchRule(r,'app.exe','sub.example.com',file)); assert.ok(!M.matchRule(r,'app.exe','example.com','D:\\other\\app.exe')); assert.ok(!M.matchRule(r,'app.exe','different.test',file));
  assert.ok(M.expression(r).includes('PROCESS-PATH-REGEX')); assert.throws(()=>R.saveEntry(state,input({processPaths:['app.exe']})));
});
test('v1 migration backs up original bytes, retains IDs/order/selections and requires explicit reattach', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-v2-'));
  try { const {state}=createDemo(); state.version=1; const raw=JSON.stringify(state); await atomicWrite(path.join(dir,'state.json'),raw); const store=new Store(dir); await store.load(); assert.equal(store.state.version,2); assert.ok(store.state.setup.needsUpgradeConfirmation); assert.equal(await fs.readFile(store.backupFile,'utf8'),raw); assert.deepEqual(store.state.scenes,state.scenes); assert.deepEqual(store.state.rules.map(r=>r.id),state.rules.map(r=>r.id)); assert.ok(store.state.rules.every(r=>Array.isArray(r.processPaths))); const again=new Store(dir); await again.load(); assert.ok(!again.migrated); }
  finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('invalid migration and backup failure preserve original state; v1 journal recovery remains compatible', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-v2-failure-')); let service;
  try {const {state}=createDemo();state.version=1; const raw=JSON.stringify(state);await atomicWrite(path.join(dir,'state.json'),raw);await atomicWrite(path.join(dir,'backups'),'blocked'); await assert.rejects(()=>new Store(dir).load());assert.equal(await fs.readFile(path.join(dir,'state.json'),'utf8'),raw);await fs.rm(path.join(dir,'backups'));
    await atomicWrite(path.join(dir,'transaction.json'),JSON.stringify({previousState:state,previousFile:'old config'}));service=await new Service(new Store(dir)).init();clearInterval(service.timer);assert.equal(service.state.version,2);assert.ok(!service.state.setup.ready);assert.equal(await fs.readFile(service.file,'utf8'),'old config');
  } finally {await service?.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('connection pagination exposes every current row, freezes snapshots, clamps refresh and resumes at page one', () => {
  const { ConnectionHistory } = require('../src/connection-history.cjs');
  const h=new ConnectionHistory(), p=new ConnectionPager(), rows=Array.from({length:137},(_,i)=>({id:String(i).padStart(4,'0'),bytes:i})); h.observe(rows.reverse(),1000);p.update(h.page());assert.equal(p.pages,14);assert.equal(p.visible[0].id,'0000');
  const found=new Set();for(let page=1;page<=p.pages;page++){p.update(h.page({page,mode:page===1?'pause':'snapshot'}));p.visible.forEach(r=>found.add(r.id));}assert.equal(found.size,137);assert.ok(p.paused);assert.equal(p.sampledAt,1000);
  const snapshot=JSON.stringify(p.visible);h.observe([],2000);p.update(h.page({page:p.page,mode:'snapshot'}));assert.equal(JSON.stringify(p.visible),snapshot);p.update(h.page({mode:'refresh'}));assert.equal(p.active,0);assert.equal(p.total,137);assert.equal(p.sampledAt,2000);assert.ok(p.paused);p.update(h.page({mode:'resume'}));assert.ok(!p.paused);assert.equal(p.page,1);assert.equal(h.snapshot,null);
});
test('one-entry manual switch detaches inherited rule without touching default or sibling and restore keeps origin', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-entry-'));let service;
  try {service=await new Service(new Store(dir),{demo:true}).init();clearInterval(service.timer);const r=service.state.rules[0],sibling=service.state.rules[1],original=service.state.scenes.find(s=>s.id===r.sceneId).selected;
    await service.command('switchRoutingEntry',{id:r.id,nodeId:service.state.subscriptions[2].nodes[0].id,temporary:true}); const selected=service.state.rules.find(x=>x.id===r.id);assert.notEqual(selected.sceneId,r.sceneId);assert.equal(service.state.rules.find(x=>x.id===sibling.id).sceneId,sibling.sceneId);assert.equal(service.state.scenes.find(x=>x.id===service.state.defaultSceneId).selected,original);
    await service.command('switchRoutingEntry',{id:r.id,operation:'restore'});assert.equal(service.state.scenes.find(x=>x.id===selected.sceneId).selected,original);
  }finally {await service?.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('detaching a shared route reconnects only attributable entry connections and preserves siblings, unknown and DIRECT', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-entry-reconnect-'));let service;
  try {service=await new Service(new Store(dir),{demo:true}).init();clearInterval(service.timer);const first=service.state.rules[0],closed=[];
    const connection=(id,process,host,chains=['AS_daily'])=>({id,chains,metadata:{process,host,network:'tcp'}});
    service.core.connections=async()=>({connections:[connection('own','chrome.exe','example.com'),connection('sibling','msedge.exe','example.org'),connection('unknown','',''),connection('direct','chrome.exe','example.com',['DIRECT'])]});service.core.close=async id=>closed.push(id);
    await service.command('switchRoutingEntry',{id:first.id,nodeId:service.state.subscriptions[2].nodes[0].id,reconnect:true});assert.deepEqual(closed,['own']);
    service.scheduler.metrics.removed={speed:99999,bytes:1};await service.scheduler.sample();assert.equal(service.scheduler.metrics.removed,undefined);
  }finally{await service?.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('failed unified save does not persist a partial rule or independent route', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-entry-atomic-'));let service;
  try{service=await new Service(new Store(dir),{demo:true}).init();clearInterval(service.timer);const before=JSON.stringify(service.state);service.store.save=async()=>{throw Error('disk full');};await assert.rejects(()=>service.command('saveRoutingEntry',input({route:{mode:'custom'}})));assert.equal(JSON.stringify(service.state),before);}
  finally{await service?.close();await fs.rm(dir,{recursive:true,force:true});}
});
