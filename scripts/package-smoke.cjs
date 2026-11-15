'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
(async () => {
  const root = path.resolve(__dirname, '..'); const output = process.env.PACKAGE_DIR || path.join(root,'release'); const packed = path.join(output, 'win-unpacked/resources/app.asar');
  const files = asar.listPackage(packed).map(p => p.replaceAll('\\', '/'));
  assert.equal(JSON.parse(asar.extractFile(packed, 'package.json').toString()).version, require('../package.json').version, 'packaged version matches current source');
  assert.ok(!files.some(file => /clash/i.test(file)), 'no old product names in packaged file paths');
  const metadata = JSON.parse(asar.extractFile(packed, 'package.json').toString()); assert.equal(metadata.name,'foxferry'); assert.equal(require('../package.json').build.appId,'local.foxferry'); assert.equal(require('../package.json').build.productName,'FoxFerry'); assert.equal(require('../package.json').build.win.executableName,'FoxFerry'); assert.equal(require('../package.json').build.nsis.shortcutName,'FoxFerry'); assert.equal(metadata.description,'FoxFerry · 订阅聚合与分流助手');
  for (const p of ['/src/main.cjs', '/src/connection-history.cjs', '/src/routing.cjs', '/src/ui/pager.js', '/docs/安装与升级.md', '/assets/fox-logo.ico', '/assets/fox-logo.png', '/licenses/CC-BY-4.0.txt', '/NOTICE.md', '/node_modules/yaml/LICENSE']) assert.ok(files.includes(p), `packaged ${p}`);
  assert.ok(!files.some(p => /^\/(\.local|\.research|test|scripts)\//.test(p) || /\/state\.json$|\/transaction\.json$/.test(p)), 'no research, tests or runtime data in app');
  assert.ok(files.includes('/src/watcher.cjs')); assert.ok(!files.includes('/assets/icon.png') && !files.includes('/assets/app.ico'));
  assert.ok(!files.includes('/assets/maid.png') && !files.some(p => /^\/src\/ui\/pet\./.test(p)));
  const sourceFiles = [];
  async function collect(dir) { for (const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})) { const file=path.join(dir,entry.name); if(entry.isDirectory()) await collect(file); else sourceFiles.push('/'+file.replaceAll('\\','/')); } }
  await collect('src');
  const packedSource = files.filter(p => p.startsWith('/src/') && /\.(cjs|js|css|html)$/.test(p));
  assert.deepEqual(packedSource.sort(), sourceFiles.sort(), 'all current source files, no missing or stale files');
  for (const file of packedSource) assert.deepEqual(asar.extractFile(packed,path.normalize(file.slice(1))),await fs.readFile(path.join(root,file.slice(1))),`source bytes ${file}`);
  const docs = files.filter(p => p.startsWith('/docs/') && /\.[^/]+$/.test(p));
  assert.ok(docs.includes('/docs/安装与升级.md') && docs.every(file=>['/docs/安装与升级.md','/docs/使用指南.md'].includes(file)),'only explicit user documentation is packaged');
  assert.ok(!files.some(p => /验收证据|验证记录|report\.json$|(?:^|\/)(?:test|scripts|\.local|\.research)(?:\/|$)|\.(?:png|jpg|webp)$/i.test(p) && !p.startsWith('/assets/fox-logo.')), 'no test artifacts, research or screenshots');

  if(files.includes('/docs/使用指南.md')){const help=asar.extractFile(packed,path.normalize('docs/使用指南.md')).toString();assert.ok(!help.includes('foxferry-0.2.4')&&!help.includes('右上角「项目仓库」'));assert.ok(help.includes('侧边栏「关于」页'));}
  const mainCode = asar.extractFile(packed, 'src/main.cjs').toString(); assert.ok(mainCode.includes('contextIsolation: true')); assert.ok(mainCode.includes('sandbox: true'));
  assert.ok(mainCode.includes("tray.setToolTip('FoxFerry')")); assert.ok(mainCode.includes("title: 'FoxFerry · 调度提醒'")); assert.ok(mainCode.includes("showErrorBox('FoxFerry 无法启动'")); assert.ok(!/Clash 助手|Clash 订阅聚合与调度助手|Clash 调度提醒/.test(mainCode));
  await fs.mkdir(path.join(root,'.local'),{recursive:true});
  const dir = await fs.mkdtemp(path.join(root, '.local/package-')); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.join(output, 'win-unpacked/FoxFerry.exe'), args: ['--demo', '--test-mode', `--data-dir=${dir}`], env });
  try {
    let page; for (let i = 0; i < 40; i++) { page = app.windows().find(p => p.url().endsWith('index.html')); if (page) break; await new Promise(r => setTimeout(r, 100)); }
    assert.ok(page); await page.waitForSelector('.scene'); assert.equal(await page.title(),'FoxFerry'); assert.equal(await app.evaluate(({app})=>app.getName()),'FoxFerry'); assert.equal(await app.evaluate(({app})=>app.getPath('userData')),dir); assert.equal((await page.locator('.brand > div').innerText()).trim(),'FoxFerry\n订阅聚合与分流助手'); assert.ok(await page.locator('.brand img').evaluate(i=>i.complete&&i.naturalWidth>0)); assert.equal(await page.locator('.scene').count(), 5);
    assert.ok(await app.evaluate(({Menu})=>Menu.getApplicationMenu()===null));
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
    assert.ok(await app.evaluate(()=>!('pet' in global.__assistantTest.service.state.preferences) && !('position' in global.__assistantTest.service.state.preferences)));

    const observed = await app.evaluate(async () => { const s = global.__assistantTest.service; clearInterval(s.timer); await s.queue; await s.scheduler.sample(); const count = s.view().connections.length; s.core.connections = async () => ({ connections: [] }); await s.scheduler.sample(); return count; });
    assert.ok(observed > 0); await page.waitForSelector('#connection-rows tr[data-status="ended"]');
    assert.equal(await page.locator('#connection-rows tr[data-status="ended"]').count(), observed);
    await page.screenshot({ path: path.join(dir, 'packaged.png') });
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({ packagedFiles: files.length, sourceFiles: sourceFiles.length, assertions: ['FoxFerry window/sidebar/app name and unchanged isolated userData', 'packaged tray, notification and error titles use FoxFerry', 'unchanged internal package and installation identity', 'allowlisted package contents, fox icons and upstream licenses, no pet assets', 'all packaged source bytes match current source', 'one window and no pet configuration', 'no user runtime data', 'MIT/CC attribution included', 'packaged executable boots isolated demo', 'ended connections remain visible in packaged application'], electron: await app.evaluate(() => process.versions.electron) }, null, 2));
    console.log(`Packaged application smoke passed. Artifacts: ${dir}`);
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
