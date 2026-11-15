'use strict';
const { _electron: electron } = require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});const dir=await fs.mkdtemp(path.join(root,'.local/performance-ui-')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:require('electron'),args:[root,'--demo','--test-mode',`--data-dir=${dir}`],env});
  try{
    let page;for(let i=0;i<100;i++){page=app.windows().find(p=>p.url().endsWith('/index.html'));if(page)break;await sleep(100);}await page.waitForSelector('#route-list');
    await page.evaluate(async()=>{const original=call;let release;try{call=(action,value)=>action==='window-visible'?new Promise(resolve=>{release=resolve;}):original(action,value);const pending=syncVisibility();visibilityChanged(true);release(false);await pending;if(!windowVisible)throw Error('旧可见性响应覆盖了新的显示事件');}finally{call=original;}});
    await app.evaluate(async()=>{const s=global.__assistantTest.service;await s.command('preferences',{sampleInterval:250,averageWindow:1000,sustained:250});s.state.scenes[0].threshold=1;s.uiCalls=0;s.samples=0;s.notices=0;s.notify=()=>s.notices++;s.scheduler.notify=()=>s.notices++;const command=s.command.bind(s);s.command=(a,v)=>{if(['view','summary','connections'].includes(a))s.uiCalls++;return command(a,v);};let bytes=0;s.core.connections=async()=>{s.samples++;return {connections:[{id:'hidden-fixture',chains:['N_'+s.state.scenes[0].selected,'AS_daily'],download:bytes+=100000,metadata:{process:'fixture.exe',network:'tcp'}}]};};global.__assistantTest.main.show();});
    await sleep(1300);await app.evaluate(()=>global.__assistantTest.main.hide());await sleep(200);
    const start=await app.evaluate(()=>{const s=global.__assistantTest.service;s.scheduler.alerts=[];const mem=s.scheduler.runtime('daily');mem.high=null;mem.alerted=null;s.notices=0;return {ui:s.uiCalls,samples:s.samples,notices:s.notices};});await sleep(1600);
    const end=await app.evaluate(()=>{const s=global.__assistantTest.service;return {ui:s.uiCalls,samples:s.samples,notices:s.notices,alerts:s.scheduler.alerts.length,visible:global.__assistantTest.main.isVisible(),paused:s.paused};});assert.equal(end.ui,start.ui);assert.ok(end.samples>start.samples+2);assert.ok(end.notices>start.notices&&end.alerts>0);assert.equal(end.paused,false);assert.equal(end.visible,false);
    await app.evaluate(()=>global.__assistantTest.main.show());await page.waitForFunction(()=>!document.hidden&&document.querySelector('#connection-rows').innerText.includes('fixture.exe'));
    await page.locator('[data-page=settings]').click();const settings=await app.evaluate(()=>{const s=global.__assistantTest.service;s.requests=[];const command=s.command.bind(s);s.command=(a,v)=>{s.requests.push([a,v]);return command(a,v);};return true;});await sleep(1400);const requests=await app.evaluate(()=>global.__assistantTest.service.requests);assert.ok(requests.some(([a,v])=>a==='summary'&&v.overview===false));assert.ok(!requests.some(([a])=>a==='connections'||a==='view'));
    await fs.writeFile(path.join(dir,'report.json'),JSON.stringify({start,end,settings,requests,assertions:['hidden zero UI requests','background sampling and alert continue','show immediately restores latest connections','settings requests status/revision only']},null,2));console.log(`Performance UI passed: ${dir}`);
  }finally{await app.evaluate(({app})=>app.quit());await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
