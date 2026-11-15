'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ConnectionHistory}=require('../src/connection-history.cjs');
const {Scheduler}=require('../src/scheduler.cjs'),{createDemo}=require('../src/simulation.cjs'),M=require('../src/model.cjs');
test('subscription filters paginate complete history without changing order on completion',()=>{
  const h=new ConnectionHistory();h.observe(Array.from({length:120},(_,i)=>({id:`a${i}`,subscriptionId:'main'})),1);h.observe([],2);
  const secondary=Array.from({length:12},(_,i)=>({id:`z${String(i).padStart(2,'0')}`,subscriptionId:'download',node:'副订阅节点'}));h.observe(secondary,3);
  const initialIds=h.page().rows.map(row=>row.id);h.observe([],4);assert.deepEqual(h.page().rows.map(row=>row.id),initialIds);h.observe(secondary,5);
  const page=h.page({subscriptionId:'download'});assert.equal(page.total,12);assert.equal(page.active,12);assert.equal(page.rows.length,10);
  assert.equal(h.page({subscriptionId:'download',page:2}).rows.length,2);assert.equal(h.page({subscriptionId:'main'}).total,120);assert.equal(h.page({subscriptionId:'main'}).active,0);
});
test('filter changes preserve a complete frozen snapshot; refresh and resume use current attribution',()=>{
  const h=new ConnectionHistory();h.observe([{id:'a',subscriptionId:'main'},{id:'z',subscriptionId:'download'}],1);
  h.page({mode:'pause',subscriptionId:'download'});h.observe([{id:'z',subscriptionId:'main'},{id:'new',subscriptionId:'download'}],2);
  const frozen=h.page({mode:'snapshot',subscriptionId:'download'});assert.equal(frozen.rows[0].id,'z');assert.equal(frozen.sampledAt,1);assert.equal(frozen.active,1);
  assert.equal(h.page({mode:'snapshot',subscriptionId:'main'}).total,1);
  const refreshed=h.page({mode:'refresh',subscriptionId:'download'});assert.equal(refreshed.rows[0].id,'new');assert.equal(refreshed.sampledAt,2);
  const main=h.page({mode:'resume',subscriptionId:'main'});assert.equal(main.total,2);assert.equal(main.rows[0].id,'a');assert.equal(main.rows[0].status,'ended');assert.equal(h.snapshot,null);
  h.observe([{id:'unknown'}],3);assert.equal(h.page({subscriptionId:'@unknown'}).total,1);assert.equal(h.page({subscriptionId:'absent'}).total,0);
  for(const subscriptionId of [null,{},'../escape','x'.repeat(65)])assert.throws(()=>h.page({subscriptionId}));
  h.clear();assert.equal(h.bySubscription.size,0);assert.equal(h.page().total,0);
});
test('ending a secondary connection does not push it off the current page behind active primary connections',()=>{
  const h=new ConnectionHistory(),primary=Array.from({length:40},(_,i)=>({id:`main-${i}`,subscriptionId:'main'}));
  h.observe([{id:'000-secondary',subscriptionId:'download',node:'副订阅节点',bytes:123},...primary],1);const ids=h.page().rows.map(row=>row.id);
  h.observe(primary,2);const page=h.page();assert.deepEqual(page.rows.map(row=>row.id),ids);assert.equal(page.rows[0].status,'ended');assert.equal(page.rows[0].subscriptionId,'download');assert.equal(page.rows[0].bytes,123);assert.equal(page.active,40);assert.equal(page.total,41);
});
test('indexed sampling preserves secondary subscription identity and traffic with duplicate node names',async()=>{
  const {state}=createDemo();let frame,now=1000;
  const scheduler=new Scheduler({state:()=>state,core:{connections:async()=>({connections:frame})},clock:()=>now});
  frame=state.scenes.map((s,i)=>({id:i?'z'+i:'a',chains:[M.nodeName(s.selected),M.group(s.id)],download:100,metadata:{process:i?'IDMan.exe':'chrome.exe'}}));
  await scheduler.sample();now=2000;frame=frame.map(c=>({...c,download:500}));await scheduler.sample();
  const secondary=scheduler.history.page({subscriptionId:'download'});assert.equal(secondary.total,2);assert.ok(secondary.rows.every(r=>r.subscriptionId==='download'&&r.nodeId===state.scenes[1].selected));assert.equal(scheduler.subscriptionBytes.download,800);assert.equal(scheduler.subscriptionBytes.main,400);
});
