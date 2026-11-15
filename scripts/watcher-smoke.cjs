'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {waitForWatcher,stopWatcher}=require('../src/watcher.cjs');
(async()=>{
  const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});const dir=await fs.mkdtemp(path.join(root,'.local/watcher-'));
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({preferences:{follow:true}}));
  const exe=process.env.APP_EXE||require('electron');
  const entry=process.env.APP_EXE?path.join(path.dirname(exe),'resources/app.asar/src/watcher.cjs'):path.join(root,'src/watcher.cjs');
  const child=spawn(exe,[entry,dir,exe,'--test-mode',`--data-dir=${dir}`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:'pipe'});
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  let timeout;try{await waitForWatcher(dir);await stopWatcher(dir);const code=await Promise.race([exit,new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error('watcher did not stop')),15000))]);assert.equal(code,0);console.log('Watcher actual Node runtime start/stop passed: '+dir);}
  finally{clearTimeout(timeout);await stopWatcher(dir).catch(()=>{});if(child.exitCode===null)child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
