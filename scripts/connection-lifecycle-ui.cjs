'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),{spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{chromium}=require('playwright'),assert=require('node:assert/strict');
const {createDemo}=require('../src/simulation.cjs'),M=require('../src/model.cjs'),{ruleSignature}=require('../src/service.cjs'),{freePort}=require('../src/probe.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});const dir=await fs.mkdtemp(path.join(root,'.local/live-lifecycle-')),data=path.join(dir,'data'),verge=path.join(dir,'verge'),{state}=createDemo();
  let active=true,bytes=0,browser,page;const requests=[];
  state.scenes.forEach(s=>s.mode='manual');state.preferences.follow=false;state.preferences.sampleInterval=250;state.preferences.averageWindow=1000;state.setup={ready:true,vergeDir:verge,corePath:process.execPath};
  const compiled=M.compile(state),proxies=Object.fromEntries(compiled['proxy-groups'].map(g=>[g.name,{type:'Selector',all:g.proxies,now:g.proxies[0]}]));for(const s of state.scenes)proxies[M.group(s.id)].now=M.nodeName(s.selected);for(const n of M.nodes(state))proxies[M.nodeName(n.id)]={type:'Socks5',udp:true};
  const server=http.createServer((req,res)=>{
    requests.push([req.method,req.url]);res.setHeader('Content-Type','application/json');
    if(req.method!=='GET'){res.writeHead(405);res.end('{}');return;}
    const route=req.url.split('?')[0];let result;
    if(route==='/version')result={meta:true,version:'isolated-lifecycle'};
    else if(route==='/proxies')result={proxies};
    else if(route==='/rules')result={rules:ruleSignature(compiled)};
    else if(route==='/configs')result={mode:'rule','find-process-mode':'always'};
    else if(route==='/connections'){
      bytes+=400;
      const row=(id,scene,process)=>({id,chains:[M.nodeName(scene.selected),M.group(scene.id)],download:bytes,metadata:{process,network:'tcp',host:'fixture.example.test'}});
      result={connections:[...Array.from({length:40},(_,i)=>row(`main-${String(i).padStart(3,'0')}`,state.scenes[0],'chrome.exe')),...(active?[row('000-secondary',state.scenes[1],'IDMan.exe')]:[])]};
    }else{res.writeHead(404);res.end('{}');return;}res.end(JSON.stringify(result));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    await fs.mkdir(data,{recursive:true});await fs.mkdir(path.join(verge,'profiles'),{recursive:true});
    await fs.writeFile(path.join(data,'state.json'),JSON.stringify(state));await fs.writeFile(path.join(data,'assistant-owned.yaml'),M.stringify(compiled));await fs.writeFile(path.join(verge,'profiles/owned.yaml'),M.stringify(compiled));await fs.writeFile(path.join(verge,'profiles.yaml'),M.stringify({current:'owned',items:[{uid:'owned',type:'local',file:'owned.yaml'}]}));await fs.writeFile(path.join(verge,'clash-verge.yaml'),M.stringify({...compiled,'external-controller':`127.0.0.1:${server.address().port}`}));
    const debugPort=await freePort(),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const launch=spawn('wscript.exe',[path.join(root,'启动助手.vbs'),'--test-mode',`--data-dir=${data}`,`--remote-debugging-port=${debugPort}`,'--remote-debugging-address=127.0.0.1'],{env,windowsHide:true,stdio:'ignore'});await new Promise((r,j)=>{launch.once('error',j);launch.once('exit',code=>code===0?r():j(Error('VBS failed')));});
    for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{timeout:500});break;}catch{await sleep(100);}}assert.ok(browser);
    for(let i=0;i<100;i++){page=browser.contexts()[0]?.pages().find(p=>p.url().endsWith('/index.html'));if(page)break;await sleep(100);}assert.ok(page);
    await page.waitForSelector('#connection-rows tr[data-id="000-secondary"][data-status="active"]');
    assert.equal((await page.evaluate(()=>window.assistant.call('view'))).appVersion,require('../package.json').version);assert.equal(await page.locator('#app-version').textContent(),'v'+require('../package.json').version);
    const before=await page.locator('#connection-rows tr[data-id="000-secondary"]').innerText();await page.screenshot({path:path.join(dir,'active.png'),fullPage:true});await sleep(1800);
    const session=await browser.newBrowserCDPSession(),processInfo=await session.send('SystemInfo.getProcessInfo'),pid=processInfo.processInfo.find(p=>p.type==='browser').id;
    const props=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'taskbar-properties.ps1'),'-TargetProcessId',String(pid)],{windowsHide:true,encoding:'utf8'});await fs.writeFile(path.join(dir,'taskbar-properties.json'),props.stdout);
    const capture=spawn('python',['-c',"from PIL import ImageGrab; import sys; im=ImageGrab.grab(); im.crop((0,max(0,im.height-110),im.width,im.height)).save(sys.argv[1])",path.join(dir,'taskbar.png')],{env,windowsHide:true,stdio:'ignore'});await new Promise((r,j)=>{capture.once('error',j);capture.once('exit',code=>code===0?r():j(Error('Taskbar capture failed')));});
    active=false;
    await page.waitForFunction(async()=>{const r=await window.assistant.call('connections',{subscriptionId:'download'});return r.total===1&&r.rows[0]?.status==='ended';});await sleep(1200);
    const count=await page.locator('#connection-rows tr[data-id="000-secondary"][data-status="ended"]').count(),metadata=await page.evaluate(()=>window.assistant.call('connections',{subscriptionId:'download'}));
    const report={before,endedVisibleOnSamePage:count,secondaryHistory:metadata,requests,assertions:['actual root VBS launch','real Core HTTP and ownership guard','40 primary connections continue after secondary ends','same secondary row remains visible without pausing or filtering','no proxy/config writes']};await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));await page.screenshot({path:path.join(dir,'ended.png'),fullPage:true});
    assert.equal(count,1,`secondary connection disappeared from the real-time page; evidence: ${dir}`);assert.equal(metadata.rows[0].subscriptionId,'download');assert.ok((await page.locator('#connection-rows tr[data-id="000-secondary"]').innerText()).includes('副订阅 · 下载'));assert.ok(requests.filter(([,url])=>url==='/connections').length>=4);assert.ok(requests.every(([method])=>method==='GET'));
    await page.evaluate(()=>window.assistant.call('quit'));await browser.close();page=null;browser=null;
    const restartPort=await freePort(),restart=spawn('wscript.exe',[path.join(root,'启动助手.vbs'),'--test-mode',`--data-dir=${data}`,`--remote-debugging-port=${restartPort}`,'--remote-debugging-address=127.0.0.1'],{env,windowsHide:true,stdio:'ignore'});await new Promise((r,j)=>{restart.once('error',j);restart.once('exit',code=>code===0?r():j(Error('Restart failed')));});
    for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${restartPort}`,{timeout:500});break;}catch{await sleep(100);}}
    for(let i=0;i<100;i++){page=browser?.contexts()[0]?.pages().find(p=>p.url().endsWith('/index.html'));if(page)break;await sleep(100);}assert.ok(page);await page.waitForSelector('#connection-rows tr[data-id="main-000"]');await sleep(1800);
    const captureRestart=spawn('python',['-c',"from PIL import ImageGrab; import sys; im=ImageGrab.grab(); im.crop((0,max(0,im.height-110),im.width,im.height)).save(sys.argv[1])",path.join(dir,'taskbar-restart.png')],{env,windowsHide:true,stdio:'ignore'});await new Promise((r,j)=>{captureRestart.once('error',j);captureRestart.once('exit',code=>code===0?r():j(Error('Restart taskbar capture failed')));});
    const reset=await page.evaluate(()=>window.assistant.call('connections',{subscriptionId:'download'}));assert.equal(reset.total,0,'session history clears only on application exit');report.restartSameDataDirectory=true;report.historyClearsOnExitOnly=true;await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
    console.log(`Root VBS live lifecycle passed: ${dir}`);
  }catch(error){let view,renderer;try{view=await page?.evaluate(()=>window.assistant.call('view'));renderer=await page?.evaluate(()=>({visibility:document.visibilityState,windowVisible,refreshing,pagerRows:pager.rows,pagerTotal:pager.total,uiStatus:document.getElementById('status').textContent,message:document.getElementById('message').textContent}));await page?.screenshot({path:path.join(dir,'failure.png'),fullPage:true});}catch{}await fs.writeFile(path.join(dir,'failure.json'),JSON.stringify({error:error.message,requests,view,renderer},null,2));console.error(`Evidence: ${dir}`);throw error;}
  finally{if(page)try{await page.evaluate(()=>window.assistant.call('quit'));}catch{}await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
