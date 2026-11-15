'use strict';
const { _electron:electron }=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});const dir=await fs.mkdtemp(path.join(root,'.local/taskbar-')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.PACKAGE_DIR ? path.join(process.env.PACKAGE_DIR,'win-unpacked/FoxFerry.exe') : require('electron');
  const app=await electron.launch({executablePath,args:[...(process.env.PACKAGE_DIR?[]:[root]),'--demo','--test-mode',`--data-dir=${dir}`],env});
  try{
    for(let i=0;i<100&&!await app.evaluate(()=>!!global.__assistantTest?.main);i++)await sleep(100);
    for(let i=0;i<100&&await app.evaluate(()=>global.__assistantTest.main.webContents.isLoadingMainFrame());i++)await sleep(100);
    const hwnd=await app.evaluate(()=>global.__assistantTest.main.getNativeWindowHandle().readBigUInt64LE().toString());
    const properties=JSON.parse(execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(__dirname,'taskbar-properties.ps1'),'-WindowHandle',hwnd],{windowsHide:true,encoding:'utf8'}));
    const values=Object.values(properties),icon=values.find(v=>/[\\/]icons[\\/]fox-[a-f0-9]{12}\.ico,0$/.test(v));assert.ok(icon,JSON.stringify(properties));assert.deepEqual(await fs.readFile(icon.slice(0,-2)),await fs.readFile(path.join(root,'assets/fox-logo.ico')));assert.ok(values.includes('local.foxferry.desktop'));assert.ok(values.includes('FoxFerry'));assert.ok(values.some(v=>v.includes('--demo')&&v.includes(`--data-dir=${dir}`)&&v.includes(root)));
    await fs.writeFile(path.join(dir,'report.json'),JSON.stringify({passed:true,hwnd,properties,assertions:['source electron.exe taskbar stores fox icon override','unchanged window app ID and FoxFerry display name','relaunch preserves project, demo and isolated data directory']},null,2));console.log(`Native taskbar properties passed: ${dir}`);
  }finally{await app.evaluate(({app})=>app.quit());await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
