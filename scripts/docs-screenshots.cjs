'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{_electron:electron}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..');await fs.mkdir(path.join(root,'.local'),{recursive:true});await fs.mkdir(path.join(root,'docs/images'),{recursive:true});const dir=await fs.mkdtemp(path.join(root,'.local/docs-'));const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const exe=process.env.APP_EXE||path.join(root,'release/win-unpacked/FoxFerry.exe');
 const app=await electron.launch({executablePath:exe,args:['--demo','--test-mode',`--data-dir=${dir}`],env});
 try{
  assert.equal(await app.evaluate(({app})=>app.getVersion()),'0.2.9');
  const page=await app.firstWindow();await page.waitForSelector('#route-list .scene');await app.evaluate(()=>global.__assistantTest.main.setSize(1400,960));
  assert.ok((await page.evaluate(()=>window.assistant.call('view'))).demo);
  await page.screenshot({path:path.join(root,'docs/images/overview.jpg'),type:'jpeg',quality:82});
  await page.locator('[data-page=rules]').click();await page.waitForSelector('#content table');
  assert.ok(!(await page.locator('#content').innerText()).includes(dir));
  await page.screenshot({path:path.join(root,'docs/images/routing.jpg'),type:'jpeg',quality:82});
  await page.locator('[data-page=about]').click();await page.waitForSelector('.about-grid');
  await page.screenshot({path:path.join(root,'docs/images/about.jpg'),type:'jpeg',quality:82});
  for(const width of [900,1400]){await app.evaluate((_,width)=>global.__assistantTest.main.setSize(width,960),width);await page.waitForFunction(()=>document.querySelector('nav button').getBoundingClientRect().width>0);for(const button of await page.locator('nav button').all()){assert.equal(await button.evaluate(e=>e.scrollWidth<=e.clientWidth),true);}assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.locator('nav button[data-page=settings] svg').click();assert.equal(await page.locator('h1').innerText(),'设置');await page.keyboard.press('Tab');assert.equal(await page.locator('nav button[data-page=about]').evaluate(e=>e===document.activeElement),true);await page.keyboard.press('Enter');assert.equal(await page.locator('h1').innerText(),'关于');assert.equal(await page.locator('nav button[data-page=about]').evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
  console.log('Formal documentation images generated from packaged isolated demo.');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
