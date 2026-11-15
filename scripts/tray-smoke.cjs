'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createDemo } = require('../src/simulation.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = path.resolve(__dirname, '..'); await fs.mkdir(path.join(root,'.local'),{recursive:true}); const dir = await fs.mkdtemp(path.join(root, '.local/tray-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.APP_EXE || require('electron');
  const launch = args => electron.launch({ executablePath, args: [...(process.env.APP_EXE ? [] : [root]), '--test-mode', ...args], env });
  for (const legacy of [false, true]) {
    const data = path.join(dir, legacy ? 'legacy' : 'fresh'); await fs.mkdir(data);
    let expected;
    if (legacy) {
      expected = createDemo().state; expected.setup.ready = false; expected.preferences.follow = true; expected.preferences.background.preset = 'warm';
      const old = structuredClone(expected); old.preferences.pet = true; old.preferences.position = { x: -900, y: 200 };
      await fs.writeFile(path.join(data, 'state.json'), JSON.stringify(old));
    }
    const app = await launch([`--data-dir=${data}`]);
    try {
      const page = await app.firstWindow(); await page.waitForSelector('#route-list', { state: 'attached' });
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      assert.equal(await page.locator('#set-pet').count(), 0);
      const state = await page.evaluate(() => window.assistant.call('view'));
      assert.ok(!('pet' in state.preferences) && !('position' in state.preferences));
      if (!legacy) assert.ok((await page.locator('body').innerText()).includes('欢迎使用 FoxFerry'));
      if (legacy) {
        assert.deepEqual(await app.evaluate(() => global.__assistantTest.service.state), expected);
        await page.evaluate(() => window.assistant.call('preferences', { tolerance: 80 }));
        const saved = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
        assert.ok(!('pet' in saved.preferences) && !('position' in saved.preferences));
      }
      assert.equal(await app.evaluate(() => {
        const t = global.__assistantTest.tray; t.popUpContextMenu = menu => { global.trayMenu = menu; }; t.emit('right-click');
        return global.trayMenu.items.find(i => i.label === '快捷切换线路').enabled;
      }), false);
    } finally { await app.close(); }
  }
  const app = await launch(['--demo', `--data-dir=${path.join(dir, 'demo')}`]);
  try {
    const page = await app.firstWindow(); await page.waitForSelector('#route-list');
    const result = await app.evaluate(async ({ dialog, BrowserWindow }) => {
      const check = (value, message) => { if (!value) throw Error(message); };
      const { service: s, main, tray } = global.__assistantTest;
      clearTimeout(s.timer); s.timer = null; s.scheduleSample = () => {}; await s.queue;
      let menu, opens = 0, probes = 0, closes = 0, uiCalls = 0;
      tray.popUpContextMenu = value => { menu = value; opens++; };
      const errors = []; dialog.showErrorBox = (title, message) => errors.push({ title, message });
      s.core.close = async () => { closes++; };
      s.core.delay = async () => { probes++; return { delay: 10 }; };
      const command = s.command.bind(s); s.command = (action, value) => { if (['view', 'summary', 'connections'].includes(action)) uiCalls++; return command(action, value); };
      const open = () => { tray.emit('right-click'); return menu.items.find(i => i.label === '快捷切换线路'); };
      const target = name => open().submenu.items.find(i => i.label.startsWith(name));
      const nodeItem = (name, sub, node) => target(name).submenu.items.find(i => i.label.startsWith(sub)).submenu.items.find(i => i.label.startsWith(node));
      const click = async item => { item.click(); await s.queue; await new Promise(r => setImmediate(r)); };
      main.close(); await new Promise(r => setTimeout(r, 200));
      const startCalls = uiCalls;
      check(!main.isVisible() && BrowserWindow.getAllWindows().length === 1, 'close hides only main window');
      const originalDefault = s.state.scenes.find(x => x.id === 'daily').selected;
      await click(nodeItem('默认线路', '备用订阅', '日本 02'));
      const selectedDefault = s.state.scenes.find(x => x.id === 'daily').selected;
      check(selectedDefault !== originalDefault, 'default selection changed');
      check(s.state.rules.find(r => r.id === 'edge').sceneId === 'daily', 'sibling follows default');
      check(nodeItem('Edge', '备用订阅', '日本 02').checked, 'following entry shows current selection');
      await click(nodeItem('Chrome', '副订阅', '香港 01'));
      const rule = s.state.rules.find(r => r.id === 'chrome'), ownId = rule.sceneId;
      check(ownId !== 'daily', 'single inherited entry isolates');
      check(s.state.scenes.find(x => x.id === 'daily').selected === selectedDefault, 'independent change preserves default');
      check(!target('Chrome').label.includes('跟随默认') && target('Edge').label.includes('跟随默认'), 'follow relation is current');
      await click(target('Chrome').submenu.items.find(i => i.label === '启用同国自动选择'));
      check(s.state.scenes.find(x => x.id === ownId).mode === 'auto', 'independent auto mode');
      await click(target('默认线路').submenu.items.find(i => i.label === '启用同国自动选择'));
      check(s.state.scenes.find(x => x.id === 'daily').mode === 'auto', 'default auto mode');
      check(target('默认线路').submenu.items.find(i => i.label === '启用同国自动选择').checked, 'fresh auto checkbox');
      check(probes === 0 && closes === 0, 'menu causes no probes or disconnects');
      const stale = nodeItem('默认线路', '备用订阅', '香港 01');
      const next = structuredClone(s.state); next.subscriptions.find(x => x.id === 'backup').name = '更新后的备用订阅';
      next.subscriptions.find(x => x.id === 'backup').nodes = next.subscriptions.find(x => x.id === 'backup').nodes.filter(n => n.name !== '香港 01');
      await s.commit(next);
      check(!target('默认线路').submenu.items.find(i => i.label === '备用订阅'), 'updated subscription replaces old menu');
      check(!target('默认线路').submenu.items.find(i => i.label === '更新后的备用订阅').submenu.items.some(i => i.label.startsWith('香港 01')), 'deleted node omitted');
      const beforeStale = JSON.stringify(s.state); await click(stale);
      check(errors.length === 1 && JSON.stringify(s.state) === beforeStale, 'stale node fails with actual state retained');
      const select = s.core.select; s.core.select = async () => { throw Error('模拟切换失败'); };
      const beforeFailure = JSON.stringify(s.state); await click(nodeItem('默认线路', '主订阅', '日本 01'));
      check(errors.length === 2 && JSON.stringify(s.state) === beforeFailure, 'failed switch retains actual state and reports error'); s.core.select = select;
      const removedSubscriptionNode = nodeItem('默认线路', '主订阅', '日本 01');
      const empty = structuredClone(s.state); empty.subscriptions.find(x => x.id === 'main').nodes = []; await s.commit(empty);
      check(target('默认线路').submenu.items.find(i => i.label.startsWith('主订阅')).submenu.items[0].enabled === false, 'empty subscription disabled');
      const staleSubscription = nodeItem('默认线路', '主订阅', '没有可用节点');
      await s.command('removeSubscription', { id: 'main' });
      check(!target('默认线路').submenu.items.some(i => i.label.startsWith('主订阅')), 'removed subscription omitted');
      check(staleSubscription.enabled === false, 'empty placeholder is not actionable');
      const beforeRemovedSubscription = JSON.stringify(s.state); await click(removedSubscriptionNode);
      check(errors.length === 3 && JSON.stringify(s.state) === beforeRemovedSubscription, 'stale subscription action retains actual state');
      check(uiCalls === startCalls && !main.isVisible(), 'hidden tray actions do not request UI data or show a window');
      const hiddenUiCalls = uiCalls - startCalls;
      const state = structuredClone(s.state);
      tray.emit('double-click'); check(main.isVisible(), 'double click opens main');
      main.hide(); open(); await click(menu.items.find(i => i.label === '打开主界面')); check(main.isVisible(), 'open menu restores main');
      main.hide(); open(); await click(menu.items.find(i => i.label === '暂停调度'));
      check(s.paused && !open().enabled && !s.timer, 'pause disables menu and stops sampling');
      check(BrowserWindow.getAllWindows().length === 1 && closes === 0, 'no new windows or connection closes');
      return { state, errors, opens, probes, closes, hiddenUiCalls };
    });
    assert.ok(result.errors.every(error => error.title.startsWith('FoxFerry')));
    await app.evaluate(() => global.__assistantTest.tray.emit('double-click'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('暂停'));
    const view = await page.evaluate(() => window.assistant.call('view'));
    assert.deepEqual(view.scenes, result.state.scenes); assert.deepEqual(view.rules, result.state.rules);
    await page.screenshot({ path: path.join(dir, 'restored.png') });
    const exited = app.waitForEvent('close');
    await app.evaluate(() => {
      const t = global.__assistantTest.tray;
      t.popUpContextMenu = menu => menu.items.find(i => i.label.startsWith('退出 FoxFerry')).click(); t.emit('right-click');
    }).catch(error => { if (!/closed|destroyed/.test(error.message)) throw error; });
    await exited;
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({ ...result, assertions: ['fresh and legacy real-mode isolated startup, one window', 'legacy preferences preserved and pet fields discarded on save', 'unattached and paused actions disabled', 'actual tray event builds fresh Electron menu from memory', 'hidden default, inherited independent and same-country auto actions', 'subscription update, removed node/subscription and failed selection retain actual state', 'restored UI agrees with tray', 'zero menu-triggered probes or disconnects', 'double-click, open and explicit quit callbacks'] }, null, 2));
    console.log(`Tray smoke passed. Artifacts: ${dir}`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
