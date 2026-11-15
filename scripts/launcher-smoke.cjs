'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const http = require('node:http');
const M = require('../src/model.cjs');
const {createDemo}=require('../src/simulation.cjs');
const { exec } = require('../src/core.cjs');
const { freePort } = require('../src/probe.cjs');
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
async function processes() {
  const {stdout}=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','@(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId) | ConvertTo-Json -Compress'],{windowsHide:true,timeout:10000});
  return JSON.parse(stdout.trim()||'[]');
}
async function launch(file,args) {const child=spawn('wscript.exe',[file,...args],{windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});const pid=child.pid;await new Promise((r,j)=>{child.once('error',j);child.once('exit',code=>code===0?r():j(Error('WSH startup failed: '+code)));});return pid;}
(async()=>{
  if(process.platform!=='win32')throw Error('此验证需要 Windows');
  const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});const dir=await fs.mkdtemp(path.join(root,'.local/启动器 空格,中文-'));const fixture=path.join(dir,'测试 项目');await fs.mkdir(fixture);
  for(const name of ['src','assets','node_modules'])await fs.symlink(path.join(root,name),path.join(fixture,name),'junction');await fs.copyFile(path.join(root,'package.json'),path.join(fixture,'package.json'));
  for(const name of ['启动助手.vbs','启动演示.vbs']){const file=path.join(root,name);assert.deepEqual([...((await fs.readFile(file)).subarray(0,2))],[255,254]);await fs.copyFile(file,path.join(fixture,name));}
  const packed = path.join(root, 'release/foxferry-0.2.7');
  try { await fs.access(path.join(packed, 'win-unpacked/FoxFerry.exe')); await fs.mkdir(path.join(fixture, 'release')); await fs.symlink(packed, path.join(fixture, 'release/foxferry-0.2.7'), 'junction'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const isApp = p => /^(electron|FoxFerry)\.exe$/i.test(p.Name);
  const port=await freePort(),data=path.join(dir,'隔离 数据');const args=['--demo','--test-mode',`--data-dir=${data}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'];let browser,page,mock;
  try{
    const pid=await launch(path.join(fixture,'启动助手.vbs'),args);
    for(let i=0;i<80;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:800});break;}catch{await sleep(100);}}
    assert.ok(browser,'silent launcher starts Electron');for(let i=0;i<50;i++){page=browser.contexts()[0]?.pages().find(p=>p.url().endsWith('/index.html'));if(page)break;await sleep(100);}assert.ok(page);await page.waitForSelector('#route-list .scene');assert.equal(await page.title(),'FoxFerry');assert.ok((await page.evaluate(()=>window.assistant.call('view'))).demo);
    let rows=await processes(),ids=new Set([pid]);for(let i=0;i<10;i++)for(const p of rows)if(ids.has(p.ParentProcessId))ids.add(p.ProcessId);const children=rows.filter(p=>ids.has(p.ProcessId));assert.ok(children.some(isApp));assert.ok(!children.some(p=>/^(cmd|powershell|pwsh|conhost|OpenConsole)\.exe$/i.test(p.Name)),'no console or shell descendants');
    const roots=rows.filter(p=>p.ParentProcessId===pid&&isApp(p)).map(p=>p.ProcessId);assert.equal(roots.length,1);await launch(path.join(fixture,'启动演示.vbs'),args);await sleep(1000);rows=await processes();assert.ok(rows.some(p=>p.ProcessId===roots[0]));assert.equal(browser.contexts()[0].pages().filter(p=>p.url().endsWith('/index.html')).length,1);
    await page.screenshot({path:path.join(dir,'silent-launch.png')});
    const missing=path.join(dir,'缺少依赖');await fs.mkdir(missing);await fs.copyFile(path.join(root,'启动助手.vbs'),path.join(missing,'启动助手.vbs'));await assert.rejects(()=>exec('cscript.exe',['//NoLogo',path.join(missing,'启动助手.vbs')],{windowsHide:true,timeout:5000}),e=>e.code===2&&e.stdout.includes('Electron'));
    await page.evaluate(()=>window.assistant.call('quit'));await browser.close();page=null;browser=null;
    const requests=[];mock=http.createServer((req,res)=>{requests.push(req.url);res.setHeader('Content-Type','application/json');res.end('{"meta":true,"version":"fixture"}');});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
    const migratedDir=path.join(dir,'旧版 数据'),vergeDir=path.join(dir,'隔离 Verge');await fs.mkdir(path.join(vergeDir,'profiles'),{recursive:true});await fs.mkdir(migratedDir);
    const {state}=createDemo(),config={...M.compile(state),'external-controller':`127.0.0.1:${mock.address().port}`};state.version=1;state.setup={ready:true,vergeDir,corePath:process.execPath};const raw=JSON.stringify(state);
    await fs.writeFile(path.join(migratedDir,'state.json'),raw);await fs.writeFile(path.join(migratedDir,'assistant-owned.yaml'),M.stringify(config));await fs.writeFile(path.join(vergeDir,'clash-verge.yaml'),M.stringify(config));await fs.writeFile(path.join(vergeDir,'profiles/owned.yaml'),M.stringify(config));await fs.writeFile(path.join(vergeDir,'profiles.yaml'),M.stringify({current:'own',items:[{uid:'own',type:'local',file:'owned.yaml'}]}));
    const migrationPort=await freePort();await launch(path.join(fixture,'启动助手.vbs'),['--test-mode',`--data-dir=${migratedDir}`,`--remote-debugging-port=${migrationPort}`]);
    for(let i=0;i<80;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${migrationPort}`,{timeout:800});break;}catch{await sleep(100);}}assert.ok(browser);
    for(let i=0;i<50;i++){page=browser.contexts()[0]?.pages().find(p=>p.url().endsWith('/index.html'));if(page)break;await sleep(100);}assert.ok(page);await page.waitForSelector('#route-list');await sleep(1300);
    const upgraded=await page.evaluate(()=>window.assistant.call('view'));assert.equal(upgraded.version,2);assert.ok(upgraded.paused&&upgraded.setup.needsUpgradeConfirmation);assert.deepEqual(requests,[],'upgrade never discovers or touches live control API');const backups=await fs.readdir(path.join(migratedDir,'backups'));assert.equal(await fs.readFile(path.join(migratedDir,'backups',backups[0]),'utf8'),raw);await page.screenshot({path:path.join(dir,'migration.png')});
    await fs.writeFile(path.join(dir,'report.json'),JSON.stringify({assertions:['UTF-16LE BOM','Chinese spaces and comma in project path','ELECTRON_RUN_AS_NODE removed in child environment','native GUI visible without cmd/PowerShell/conhost','both launchers reuse existing instance','missing dependencies return actionable failure','real-mode v1 upgrade backs up exact bytes and requires explicit reattach','upgrade makes zero requests to isolated control API'],processNames:children.map(p=>p.Name)},null,2));console.log(`Silent launcher smoke passed. Artifacts: ${dir}`);
  }finally{if(page)try{await page.evaluate(()=>window.assistant.call('quit'));}catch{}await browser?.close();if(mock)await new Promise(r=>mock.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
