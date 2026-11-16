'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, nativeImage, dialog, shell, protocol, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Store, redact, atomicWrite } = require('./store.cjs');
const { Service } = require('./service.cjs');
const { dataDirectory } = require('./identity.cjs');
const { configureLogin } = require('./login-item.cjs');
const { stopWatcher, waitForWatcher } = require('./watcher.cjs');
const { HostGate } = require('./host.cjs');
const { acceptProcesses } = require('./discovery.cjs');
const { watcherPipe } = require('./watcher.cjs');
const sockets = require('node:net');
const updater = require('./updates.cjs').createUpdater(require('../package.json'), require('../package.json').version);
const taskbarAppId = 'local.foxferry.desktop';
const demo = process.argv.includes('--demo');
const testing = process.argv.includes('--test-mode');
const homeArg = process.argv.find(s => s.startsWith('--data-dir='));
const dataDir = homeArg ? path.resolve(homeArg.slice(11)) : dataDirectory(app.getPath('appData'), demo);
app.setName('FoxFerry');
if (process.platform === 'win32') app.setAppUserModelId('local.foxferry');
app.setPath('userData', process.argv.includes('--watch') ? path.join(dataDir, 'watcher') : dataDir);
protocol.registerSchemesAsPrivileged([{ scheme:'assistant-background', privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) { app.quit(); }
else if (process.argv.includes('--watch')) runWatcher();
else runApp();
function launchArgs(flag) { return [...(app.isPackaged ? [] : [path.resolve(__dirname, '..')]), flag, `--data-dir=${dataDir}`]; }
function spawnWatcher() {
  const child = spawn(process.execPath, [path.join(__dirname,'watcher.cjs'), dataDir, process.execPath, ...launchArgs('--follow-host')], { env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}, detached:true, windowsHide:true, stdio:'ignore' });
  child.unref(); return new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
}
async function runWatcher() { try { await spawnWatcher(); } finally { app.quit(); } }
async function runApp() {
  let service, main, tray, quitting = false, hostTimer, hostSocket, closing = false, taskbarIconPath;
  app.on('window-all-closed', () => {});
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/fox-logo.ico'));
  function windowOptions(extra = {}) { return { icon, autoHideMenuBar: true, backgroundColor: '#f4f7f4', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }, ...extra }; }
  function secure(win) { win.setMenu(null); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); win.webContents.on('will-navigate', e => e.preventDefault()); win.webContents.session.setPermissionRequestHandler((_web, _permission, done) => done(false)); }
  function showMain() {
    if (!main || main.isDestroyed()) {
      main = new BrowserWindow(windowOptions({ width: 1180, height: 820, minWidth: 900, minHeight: 640, title: 'FoxFerry', backgroundMaterial: 'mica', show: false }));
      secure(main); main.loadFile(path.join(__dirname, 'ui/index.html'));
      const visibility = () => main?.webContents.send('window-visibility', main.isVisible() && !main.isMinimized());
      for (const event of ['show','hide','minimize','restore']) main.on(event,visibility);
      main.webContents.once('did-finish-load', () => {
        if (process.platform === 'win32') {
          const args = [...(app.isPackaged ? [] : [path.resolve(__dirname,'..')]), ...(demo ? ['--demo'] : []), ...(homeArg ? [homeArg] : [])];
          // Regroup after native window creation; early registration can reuse Explorer's Electron icon.
          app.setAppUserModelId(taskbarAppId);
          main.setAppDetails({ appId:taskbarAppId, appIconPath:taskbarIconPath, appIconIndex:0, relaunchCommand:[process.execPath,...args].map(arg => `"${arg.replace(/(\\+)$/, '$1$1')}"`).join(' '), relaunchDisplayName:'FoxFerry' });
        }
        main.show();
      });
      main.on('close', event => { if (!quitting) { event.preventDefault(); main.hide(); } });
    } else { main.show(); main.focus(); }
  }
  function stateChanged() { if (main && !main.isDestroyed()) main.webContents.send('state-changed'); }
  function trayMenu() {
    const state = service.state, enabled = !service.paused && !!service.core && !!service.scheduler;
    const label = text => String(text).replaceAll('&', '&&');
    const targets = [{ name: '默认线路', sceneId: state.defaultSceneId }, ...state.rules.map(r => ({ name: r.name, sceneId: r.sceneId, ruleId: r.id }))].filter(t => state.scenes.some(s => s.id === t.sceneId));
    const operate = async (target, operation, node) => {
      try { await service.command(target.ruleId ? 'switchRoutingEntry' : operation === 'manual' ? 'switch' : 'auto', target.ruleId ? { id: target.ruleId, operation, nodeId: node?.id } : { sceneId: target.sceneId, nodeId: node?.id }); }
      catch (error) { dialog.showErrorBox('FoxFerry · 无法切换', error.message); }
      finally { stateChanged(); }
    };
    return Menu.buildFromTemplate([
      { label: label(service.status), enabled: false },
      { label: '打开主界面', click: showMain },
      { label: '快捷切换线路', enabled: enabled && targets.length > 0, submenu: targets.length ? targets.map(target => {
        const scene = state.scenes.find(s => s.id === target.sceneId);
        const sub = state.subscriptions.find(s => s.id === scene.subscriptionId), selected = sub?.nodes.find(n => n.id === scene.selected);
        return { label: label(target.name + (target.ruleId && target.sceneId === state.defaultSceneId ? ' · 跟随默认' : '')), submenu: [
          { label: label(`当前：${sub?.name || '订阅已失效'} / ${selected?.name || '节点已失效'} · ${scene.mode === 'auto' ? '同国自动' : '手动锁定'}`), enabled: false },
          { label: '启用同国自动选择', type: 'checkbox', checked: scene.mode === 'auto', enabled, click: () => operate(target, 'auto') },
          ...state.subscriptions.map(sub => ({ label: label(sub.name), submenu: sub.nodes.length ? sub.nodes.map(n => ({ label: label(`${n.name}${n.detectedCountry ? ' · 检测 ' + n.detectedCountry : n.nameCountry ? ' · 标注 ' + n.nameCountry : ' · 国家未知'}`), type: 'checkbox', checked: scene.selected === n.id, enabled, click: () => operate(target, 'manual', n) })) : [{ label: '没有可用节点', enabled: false }] }))
        ] };
      }) : [{ label: '尚无线路', enabled: false }] },
      { label: '暂停调度', enabled: !service.paused, click: async () => { try { await service.command('pause'); } catch (error) { dialog.showErrorBox('FoxFerry · 无法暂停', error.message); } finally { stateChanged(); } } },
      { type: 'separator' },
      { label: '退出 FoxFerry（本次 Clash Verge 会话不再拉起）', click: () => { quitting = true; app.quit(); } }
    ]);
  }
  async function syncFollow(previous) {
    const enabled = service.state.preferences.follow;
    if (demo || testing || previous === enabled) return;
    let undo;
    try {
      if (app.isPackaged) undo = await configureLogin(app, {name:'FoxFerryFollow',path:process.execPath,args:launchArgs('--watch')}, enabled, previous !== undefined);
      if (enabled) { try { await spawnWatcher(); await waitForWatcher(dataDir); } catch { await stopWatcher(dataDir).catch(() => {}); await spawnWatcher(); await waitForWatcher(dataDir); } connectWatcher(); }
      else { clearTimeout(hostTimer); await stopWatcher(dataDir); hostSocket?.destroy(); hostSocket = null; }
    } catch(error) {
      if(undo) try { await undo(); } catch(rollback) { throw Error(`${error.message}；${rollback.message}`); }
      if(!previous) await stopWatcher(dataDir).catch(()=>{});
      throw error;
    }
  }
  const gate = new HostGate();
  function connectWatcher() {
    clearTimeout(hostTimer);
    if (quitting || demo || testing || !service.state.preferences.follow || hostSocket) return;
    const socket = sockets.connect(watcherPipe(dataDir)); hostSocket = socket; let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const row = buffer.slice(0,end); buffer = buffer.slice(end+1);
        try { const value = JSON.parse(row); acceptProcesses(value); if (gate.update(value.hosts).exited && service.state.preferences.follow) { quitting = true; app.quit(); } } catch {}
      }
    });
    socket.on('error',()=>{});
    socket.on('close',()=> { hostSocket = null; if (!quitting && service.state.preferences.follow) hostTimer = setTimeout(connectWatcher,500); });
  }
  try {
    await app.whenReady();
    if (process.platform === 'win32') {
      const bytes = await fs.readFile(path.join(__dirname,'../assets/fox-logo.ico'));
      taskbarIconPath = path.join(dataDir,'icons',`fox-${createHash('sha256').update(bytes).digest('hex').slice(0,12)}.ico`);
      try { await fs.access(taskbarIconPath); } catch (error) { if(error.code!=='ENOENT')throw error; await atomicWrite(taskbarIconPath,bytes); }
    }
    Menu.setApplicationMenu(null);
    protocol.handle('assistant-background', request => {
      const url = new URL(request.url), match = /^\/([a-f0-9]{64})(-display)?\.png$/.exec(url.pathname);
      if (url.hostname !== 'image' || !match) return new Response('',{status:404});
      return net.fetch(pathToFileURL(path.join(dataDir,'backgrounds',match[1]+(match[2] || '')+'.png')).href);
    });
    service = await new Service(new Store(dataDir), { demo, notify: alert => {
      if (Notification.isSupported() && !testing) { const notice = new Notification({ title: 'FoxFerry · 调度提醒', body: `${service.state.scenes.find(s => s.id === alert.sceneId)?.name}：${alert.message}` }); notice.on('click', showMain); notice.show(); }
    } }).init();
    if (testing) global.__assistantTest = { get service() { return service; }, get main() { return main; }, get tray() { return tray; } };
    ipcMain.handle('assistant', async (event, action, value) => {
      const file = event.senderFrame?.url;
      const allowed = pathToFileURL(path.join(__dirname, 'ui/index.html')).href;
      if (file !== allowed || event.sender !== main?.webContents) throw Error('无效的界面来源');
      if (Buffer.byteLength(JSON.stringify(value ?? {})) > 1024 * 1024) throw Error('请求过大');
      if (action === 'window-visible') return event.sender === main?.webContents && main.isVisible() && !main.isMinimized();
      if (action === 'pick-background') {
        if (event.sender !== main?.webContents) throw Error('无效的界面来源');
        const selected = await dialog.showOpenDialog(main, { properties: ['openFile'], filters: [{ name: '背景图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
        if (selected.canceled || !selected.filePaths.length) return null;
        const file = selected.filePaths[0], stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw Error('请选择不超过 20 MiB 的图片');
        const bytes = await fs.readFile(file);
        if (bytes.length > 20 * 1024 * 1024 || !(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) || (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'))) throw Error('图片格式无效，请选择 PNG、JPEG 或 WebP');
        let image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty() && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
          // Electron nativeImage does not decode WebP on all platforms; use an isolated Chromium decoder.
          const decoder = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false } });
          try {
            decoder.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
            await decoder.loadURL('data:text/html,<meta charset="utf-8">');
            const data = `data:image/webp;base64,${bytes.toString('base64')}`;
            const pngData = await decoder.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const image=new Image();image.onerror=()=>reject(Error('无法解码图片'));image.onload=()=>{if(!image.width||!image.height||image.width>8192||image.height>8192||image.width*image.height>24000000)return reject(Error('图片尺寸过大'));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);resolve(canvas.toDataURL('image/png').slice(22));};image.src=${JSON.stringify(data)};})`);
            image = nativeImage.createFromBuffer(Buffer.from(pngData, 'base64'));
          } finally { decoder.destroy(); }
        }
        const size = image.getSize();
        if (image.isEmpty() || !size.width || !size.height || size.width > 8192 || size.height > 8192 || size.width * size.height > 24000000) throw Error('无法解码图片，或图片尺寸过大');
        const png = image.toPNG(), id = createHash('sha256').update(png).digest('hex');
        await atomicWrite(path.join(dataDir, 'backgrounds', `${id}.png`), png);
        const scale = Math.min(1,2560 / size.width,1440 / size.height);
        if (scale < 1) await atomicWrite(path.join(dataDir,'backgrounds',`${id}-display.png`), image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'}).toPNG());
        return { imageId: id, imageName: path.basename(file).replace(/[\r\n\0]/g, ' ').slice(0, 255) };
      }
      if (action === 'read-background') {
        if (event.sender !== main?.webContents || !/^[a-f0-9]{64}$/.test(value?.id || '')) throw Error('无效的背景资源');
        try {
          await fs.access(path.join(dataDir,'backgrounds',`${value.id}.png`));
          let suffix = '';
          if (!value.original && value.width <= 2560 && value.height <= 1440) { try { await fs.access(path.join(dataDir,'backgrounds',`${value.id}-display.png`)); suffix = '-display'; } catch {} }
          await fs.access(path.join(dataDir,'backgrounds',`${value.id}${suffix}.png`));
          return `assistant-background://image/${value.id}${suffix}.png`;
        }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }
      if (action === 'open-config') { await shell.openPath(path.dirname(service.file)); return; }
      if (action === 'pick') {
        const kind = value?.kind;
        const result = await dialog.showOpenDialog(main, kind === 'dir' ? { properties: ['openDirectory'] } : { properties: ['openFile'], filters: ['core', 'app'].includes(kind) ? [{ name: kind === 'app' ? '应用程序' : 'Mihomo', extensions: ['exe'] }] : [{ name: 'Mihomo YAML', extensions: ['yaml', 'yml'] }] });
        return result.canceled ? null : result.filePaths[0];
      }
      if (action === 'check-updates') return updater.check();
      if (action === 'open-repository') { await shell.openExternal(updater.repository()); return; }
      if (action === 'open-issues') { await shell.openExternal(updater.repository()+'/issues'); return; }
      if (action === 'open-release') { await shell.openExternal(updater.release()); return; }
      if (action === 'license-text') {
        const files = {mit:'LICENSE',notice:'NOTICE.md'};
        if(!Object.hasOwn(files,value?.kind))throw Error('无效的许可证请求');
        return fs.readFile(path.join(__dirname,'..',files[value.kind]),'utf8');
      }
      if (action === 'quit') { quitting = true; app.quit(); return; }
      const before = service.state.preferences.follow;
      const result = await service.command(action, value);
      if (action === 'preferences' && value?.follow !== undefined) try { await syncFollow(before); } catch (error) { await service.command('preferences', { follow: before }); throw error; }
      if (!['view','summary','connections'].includes(action)) { stateChanged(); } return result;
    });
    tray = new Tray(icon); tray.setToolTip('FoxFerry'); tray.on('double-click', showMain); tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
    app.on('second-instance', () => { if (!quitting) showMain(); });
    if (!demo && !testing) try { await syncFollow(undefined); } catch(error) { await service.command('preferences',{follow:false}); try { if(app.isPackaged)await configureLogin(app,{name:'FoxFerryFollow',path:process.execPath,args:launchArgs('--watch')},false); await stopWatcher(dataDir); } catch(cleanup) { error.message += '；清理未完成：'+cleanup.message; } dialog.showErrorBox('FoxFerry 联动未启用',error.message); }
    showMain();
    if (!demo && service.state.setup.ready && !service.state.setup.needsUpgradeConfirmation) service.command('attach').catch(e => service.fail(e));
    app.on('before-quit', event => {
      if (closing) return; event.preventDefault(); quitting = true; clearTimeout(hostTimer); hostSocket?.destroy(); closing = true;
      service.close().finally(() => app.quit());
    });
  } catch (e) { dialog.showErrorBox('FoxFerry 无法启动', redact(e.message)); app.exit(1); }
}
