'use strict';
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await fs.mkdir(path.join(root, '.local'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, '.local/background-'));
  const imageFile = path.join(dir, '测试 图片.png'), invalidFile = path.join(dir, '无效 图片.png');
  await fs.copyFile(path.join(root, 'assets/fox-logo.png'), imageFile);
  await fs.writeFile(invalidFile, 'not an image');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await electron.launch({ executablePath: require('electron'), args: [root, '--test-mode', `--data-dir=${dir}`], env });
    let page;
    for (let i=0;i<100;i++) { page=app.windows().find(p=>p.url().endsWith('/index.html')); if(page) break; await sleep(100); }
    assert.ok(page); await page.waitForSelector('[data-page=settings]');
    return { app, page };
  };
  const choose = async (app, file) => app.evaluate(({dialog}, value) => { dialog.showOpenDialog = async () => value ? {canceled:false,filePaths:[value]} : {canceled:true,filePaths:[]}; }, file);
  let {app,page}=await launch(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.locator('[data-page=settings]').click();
    assert.equal(await page.locator('body').getAttribute('data-background'), 'white');
    assert.equal(await page.locator('#background-opacity').inputValue(), '25');
    assert.equal(await page.locator('#panel-opacity').inputValue(), '100'); assert.equal(await page.locator('#panel-blur').inputValue(), '0');
    const themeColors = {};
    for (const preset of ['white','red','orange','yellow','cyan','purple','sage','cool','warm']) {
      await page.locator(`[data-bg-preset=${preset}]`).click(); assert.equal(await page.locator('body').getAttribute('data-background'),preset);
      await page.waitForTimeout(200);
      const colors = await page.evaluate(() => {
        const css = s => getComputedStyle(document.querySelector(s));
        const rgb = s => s.match(/\d+/g).slice(0,3).map(Number);
        const luminance = s => rgb(s).map(n => { const v=n/255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; }).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
        const ratio = (a,b) => { const [x,y]=[luminance(a),luminance(b)].sort((m,n)=>n-m); return (x+.05)/(y+.05); };
        const button=document.createElement('button'); button.className='primary'; document.body.append(button);
        const nav=css('nav button.active'), primary=getComputedStyle(button), secondary=css('[data-action=background-pick]'), radio=css('input[type=radio]'), checkbox=css('input[type=checkbox]'), range=css('input[type=range]');
        const result={accent:primary.backgroundColor,nav:nav.color,navBackground:nav.backgroundColor,secondary:secondary.color,radio:radio.accentColor,checkbox:checkbox.accentColor,range:range.accentColor,primaryContrast:ratio(primary.color,primary.backgroundColor),navContrast:ratio(nav.color,nav.backgroundColor)};button.remove();return result;
      });
      assert.equal(colors.nav,colors.accent); assert.equal(colors.secondary,colors.accent); assert.equal(colors.radio,colors.accent); assert.equal(colors.checkbox,colors.accent); assert.equal(colors.range,colors.accent);
      assert.ok(colors.primaryContrast>=4.5 && colors.navContrast>=4.5, `${preset} 对比度不足: ${JSON.stringify(colors)}`);
      themeColors[preset]=colors;
      if (preset === 'red' || preset === 'cyan') await page.screenshot({path:path.join(dir,`theme-${preset}.png`)});
    }
    await page.locator('[data-bg-preset=cool]').click(); assert.equal(await page.locator('body').getAttribute('data-background'), 'cool');
    await choose(app, null); await page.getByRole('button',{name:'选择图片'}).click(); assert.equal(await page.locator('body').getAttribute('data-background'), 'cool');
    await choose(app, invalidFile); await page.getByRole('button',{name:'选择图片'}).click(); await page.getByText('图片格式无效', {exact:false}).waitFor();
    for (const format of ['jpeg','webp']) {
      const generated = await page.evaluate(type => { const c=document.createElement('canvas'); c.width=16;c.height=16;const ctx=c.getContext('2d');ctx.fillStyle='#c08050';ctx.fillRect(0,0,16,16);return c.toDataURL(`image/${type}`).split(',')[1]; }, format);
      const file = path.join(dir, `测试 图片.${format}`); await fs.writeFile(file,Buffer.from(generated,'base64'));
      await choose(app,file); await page.getByRole('button',{name:'选择图片'}).click(); await page.getByText(`测试 图片.${format}`,{exact:true}).waitFor();
    }
    const largeFile=path.join(dir,'large.png');await fs.writeFile(largeFile,Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=4000;c.height=2000;c.getContext('2d').fillRect(0,0,4000,2000);return c.toDataURL().split(',')[1];}),'base64'));
    await choose(app,largeFile);await page.getByRole('button',{name:'选择图片'}).click();await page.getByText('large.png',{exact:true}).waitFor();await page.getByText('背景已自动保存').waitFor();
    const sizes=await page.evaluate(async()=>{const s=await window.assistant.call('view'),id=s.preferences.background.imageId;const load=url=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve([image.width,image.height]);image.onerror=reject;image.src=url;});return [await load(await window.assistant.call('read-background',{id,width:1200,height:800})),await load(await window.assistant.call('read-background',{id,original:true})),await load(await window.assistant.call('read-background',{id,width:3840,height:2160}))];});assert.deepEqual(sizes,[[2560,1280],[4000,2000],[4000,2000]]);
    await choose(app, imageFile); await page.getByRole('button',{name:'选择图片'}).click(); await page.getByText('测试 图片.png').waitFor();
    await page.waitForFunction(() => document.querySelector('#background-image').style.backgroundImage.startsWith('url('));
    const imageUrl = await page.evaluate(() => document.querySelector('#background-image').style.backgroundImage); assert.ok(imageUrl.includes('assistant-background://image/')); assert.ok(imageUrl.length < 150);
    const decoded = await page.evaluate(() => new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve([image.width,image.height]);image.onerror=()=>reject(Error('背景资源未解码'));image.src=document.querySelector('#background-image').style.backgroundImage.slice(5,-2);}));assert.ok(decoded[0]>0 && decoded[1]>0);
    await page.locator('#background-opacity').fill('48'); await page.locator('#background-blur').fill('7');
    await page.locator('#panel-opacity').fill('70'); await page.locator('#panel-blur').fill('12');
    const panel = await page.locator('#background-settings').evaluate(el => ({background:getComputedStyle(el).backgroundColor, blur:getComputedStyle(el).backdropFilter, opacity:getComputedStyle(el).opacity}));
    assert.equal(panel.background,'rgba(255, 255, 255, 0.7)'); assert.equal(panel.blur,'blur(12px)'); assert.equal(panel.opacity,'1');
    for (const [fit, size] of [['contain','contain'],['stretch','100% 100%'],['center','auto'],['cover','cover']]) {
      await page.locator('#background-fit').selectOption(fit);
      assert.equal(await page.locator('#background-image').evaluate(e=>e.style.backgroundSize), size);
    }
    assert.equal(await page.locator('#background-image').evaluate(e=>e.style.opacity),'0.48');
    assert.equal(await page.locator('#background-image').evaluate(e=>e.style.filter),'blur(7px)');
    await page.locator('input[name=background-mode][value=color]').check();
    assert.equal(await page.locator('#background-image').evaluate(e=>e.style.backgroundImage),'none');
    await page.locator('input[name=background-mode][value=image]').check();
    await page.waitForFunction(() => document.querySelector('#background-image').style.backgroundImage.startsWith('url('));
    await page.getByText('背景已自动保存').waitFor();
    await page.locator('[data-page=overview]').click();
    await page.screenshot({path:path.join(dir,'overview.png')});
    await page.locator('[data-page=settings]').click();
    await page.screenshot({path:path.join(dir,'settings.png')});
    assert.equal(await page.getByRole('button',{name:'保存设置'}).count(),0);
    await page.locator('#set-follow').check(); await page.waitForFunction(async()=>(await window.assistant.call('view')).preferences.follow);
    await page.locator('#set-tolerance').fill('75'); await page.locator('#set-tolerance').blur();
    await page.waitForFunction(async()=>(await window.assistant.call('view')).preferences.tolerance===75);
    await page.locator('#set-sampleInterval').fill('100'); await page.locator('#set-sampleInterval').blur();
    await page.waitForFunction(()=>document.querySelector('#scheduling-save-status').textContent.includes('采样间隔至少 250ms'));
    assert.equal((await page.evaluate(()=>window.assistant.call('view'))).preferences.sampleInterval,1000);
    await page.getByRole('button',{name:'恢复默认调度参数'}).click();
    await page.waitForFunction(()=>document.querySelector('#scheduling-save-status').textContent==='调度参数已恢复默认');
    const afterReset=(await page.evaluate(()=>window.assistant.call('view'))).preferences;
    assert.equal(afterReset.tolerance,50); assert.equal(afterReset.sampleInterval,1000); assert.equal(afterReset.follow,true); assert.equal(afterReset.background.imageName,'测试 图片.png');
    await page.locator('#set-tolerance').fill('80'); await page.locator('#set-tolerance').blur();
    await page.waitForFunction(()=>document.querySelector('#scheduling-save-status').textContent==='调度参数已自动保存');
    const saved = JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')).preferences.background;
    assert.deepEqual([saved.preset,saved.mode,saved.imageName,saved.opacity,saved.blur,saved.fit],['cool','image','测试 图片.png',48,7,'cover']);
    assert.deepEqual([saved.panelOpacity,saved.panelBlur],[70,12]);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')).preferences.follow,true);
    await fs.stat(path.join(dir,'backgrounds',`${saved.imageId}.png`));
    await fs.rename(imageFile, path.join(dir,'已移动 图片.png'));
    await app.evaluate(({app})=>app.quit()); await app.close();
    ({app,page}=await launch()); page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(() => document.querySelector('#background-image').style.backgroundImage.startsWith('url('));
    await page.locator('[data-page=settings]').click();
    assert.ok(await page.locator('#set-follow').isChecked());
    assert.equal(await page.locator('#set-tolerance').inputValue(),'80');
    assert.equal(await page.locator('#background-opacity').inputValue(),'48');
    assert.equal(await page.locator('#background-blur').inputValue(),'7');
    assert.equal(await page.locator('#panel-opacity').inputValue(),'70'); assert.equal(await page.locator('#panel-blur').inputValue(),'12');
    await app.evaluate(({app})=>app.quit()); await app.close();
    await fs.rename(path.join(dir,'backgrounds',`${saved.imageId}.png`),path.join(dir,'backgrounds',`${saved.imageId}.missing`));
    ({app,page}=await launch()); page.on('pageerror',e=>errors.push(e.message));
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#background-image').evaluate(e=>e.style.backgroundImage),'none');
    assert.equal(await page.locator('body').getAttribute('data-background'),'cool');
    await page.locator('[data-page=settings]').click();
    await page.getByRole('button',{name:'移除图片'}).click(); assert.equal(await page.locator('#background-image').evaluate(e=>e.style.backgroundImage),'none');
    await page.getByRole('button',{name:'恢复默认背景'}).click();
    assert.equal(await page.locator('body').getAttribute('data-background'),'white');
    assert.equal(await page.locator('#background-opacity').inputValue(),'25');
    assert.equal(await page.locator('#panel-opacity').inputValue(),'100'); assert.equal(await page.locator('#panel-blur').inputValue(),'0');
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(dir,'report.json'), JSON.stringify({passed:true, selection:'模拟系统文件选择器返回值', saved, themeColors, errors},null,2));
    console.log(`背景界面检查通过，证据目录：${dir}`);
  } finally { await app.evaluate(({app})=>app.quit()); await app.close(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
