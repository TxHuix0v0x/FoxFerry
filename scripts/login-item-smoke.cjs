'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
(async()=>{
  const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'.local/login-'));
  const entry=path.join(dir,'entry.cjs');await fs.writeFile(entry,"global.req=require;require('electron').app.whenReady().then(()=>{global.ready=true;});");
  await fs.mkdir(path.join(dir,'中文 路径'));await fs.copyFile(require('electron'),path.join(dir,'中文 路径','FoxFerry.exe'));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:require('electron'),args:[entry],env});
  try {
    const result=await app.evaluate(async({app},{modulePath,dir})=>{
      const {configureLogin,registry}=global.req(modulePath);const assert=global.req('node:assert/strict');
      const name='FoxFerryTest_'+process.pid;const before=await registry(name);assert.ok(before.every(v=>v.value===null),'unique test item initially absent');
      const cases=[];
      try {
        for(const exe of [process.execPath,global.req('node:path').join(dir,'中文 路径','FoxFerry.exe')]) {
          const options={name,path:exe,args:['--watch',`--data-dir=${dir}/中文 数据`]};
          const undo=await configureLogin(app,options,true);
          const actual=app.getLoginItemSettings(options);assert.equal(actual.openAtLogin,false);assert.ok(actual.launchItems.some(i=>i.name===name&&i.enabled));
          const enabled=await registry(name);
          app.setLoginItemSettings({...options,openAtLogin:true,enabled:false});assert.ok(app.getLoginItemSettings(options).launchItems.some(i=>i.name===name&&!i.enabled));
          const disabled=await registry(name);
          await assert.rejects(()=>configureLogin(app,options,true,false),/禁用/);assert.deepEqual(await registry(name),disabled);
          const fake={setLoginItemSettings:s=>app.setLoginItemSettings({...s,enabled:false}),getLoginItemSettings:s=>app.getLoginItemSettings(s)};
          await assert.rejects(()=>configureLogin(fake,options,true),/禁用/);assert.deepEqual(await registry(name),disabled);
          await registry(name,enabled);
          const broken={setLoginItemSettings:s=>app.setLoginItemSettings({...s,args:['wrong']}),getLoginItemSettings:s=>app.getLoginItemSettings(s)};
          await assert.rejects(()=>configureLogin(broken,options,true),/匹配/);assert.deepEqual(await registry(name),enabled);
          await configureLogin(app,options,false);assert.equal((await registry(name))[0].value,null);
          await undo();assert.deepEqual(await registry(name),before);
          cases.push({exe,args:options.args,oldOpenAtLogin:actual.openAtLogin,namedItemEnabled:true});
        }
      } finally {await registry(name,before);assert.deepEqual(await registry(name),before);}
      return {electron:process.versions.electron,cases,restored:true};
    },{modulePath:path.join(root,'src/login-item.cjs'),dir});
    await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(result,null,2));console.log('Windows login item API passed: '+dir);
  }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
