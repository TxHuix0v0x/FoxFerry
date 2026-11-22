'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const format = (n = 0) => { const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; };
const button = (action, label, data = '', cls = '') => `<button data-action="${action}" ${data} class="${cls}">${label}</button>`;
const option = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current) ? 'selected' : ''}>${esc(label)}</option>`;
const pager = new ConnectionPager(), ui = { summaryOpen: false, connectionSubscription: '', openSub: '', chooseFill: null, openSwitches: '', trafficOpen: false, rulesExpanded: false, routesExpanded: false, traffic: { range: 'd7', data: null, at: 0, requested: false } };
let state, page = 'overview', modalSubmit, busy = false, scanResult = null;
const backgroundDefault = { mode:'color', preset:'white', imageId:'', imageName:'', opacity:25, blur:0, fit:'cover', panelOpacity:100, panelBlur:0, lineDepth:0, shadow:0 };
const backgroundPresets = [['white','霁雪'],['red','桃夭'],['orange','杏霞'],['yellow','桂月'],['cyan','碧汀'],['purple','藤烟'],['sage','苔影'],['cool','远岚'],['warm','暖玉']];
let backgroundDraft, backgroundRequest = 0;
let backgroundSaveTimer, backgroundSaveVersion = 0, backgroundSaveStatus = '';
let schedulingTimer, schedulingVersion = 0, settingsSaveStatus = '';
let viewRevision, refreshing = false, windowVisible = !document.hidden, connectionRequest = 0, visibilityRevision = 0;
function settingsStatus(text) { settingsSaveStatus = text; for (const id of ['settings-save-status','scheduling-save-status']) if ($(id)) $(id).textContent = text; }
function schedulingValues() {
  const values = {};
  for (const input of document.querySelectorAll('[data-scale]')) {
    const key = input.id.slice(4), value = Number(input.value) * Number(input.dataset.scale);
    if (!input.value.trim() || !Number.isFinite(value) || value < (['tolerance','idleRate'].includes(key) ? 0 : 1) || value > 2147483647) throw Error('请填写有效的调度参数');
    values[key] = value;
  }
  if (values.sampleInterval < 250 || values.averageWindow < values.sampleInterval) throw Error('采样间隔至少 250ms，平均窗口不得短于采样间隔');
  return values;
}
function saveScheduling(version, values) {
  settingsStatus('正在保存调度参数…');
  window.assistant.call('preferences', values).then(() => {
    Object.assign(state.preferences, values);
    if (version === schedulingVersion) settingsStatus('调度参数已自动保存');
  }).catch(error => { if (version === schedulingVersion) settingsStatus(`保存失败：${error.message}`); });
}
function scheduleScheduling(immediate = false) {
  clearTimeout(schedulingTimer); const version = ++schedulingVersion;
  let values;
  try { values = schedulingValues(); } catch (error) { settingsStatus(`${error.message}，尚未保存`); return; }
  if (immediate) saveScheduling(version, values);
  else { settingsStatus('调度参数待保存'); schedulingTimer = setTimeout(() => saveScheduling(version, values), 700); }
}
async function saveDesktopSetting(input) {
  const key = 'follow';
  input.disabled = true;
  try { await call('preferences', { [key]:input.checked }); settingsStatus('Clash Verge 联动已自动保存'); }
  catch (error) { try { state = await call('view'); input.checked = state.preferences[key]; } catch {} settingsStatus(`保存失败：${error.message}`); message(`保存失败：${error.message}`, true); }
  finally { if (input.isConnected) input.disabled = key === 'follow' && state.demo; }
}
function saveBackground() {
  clearTimeout(backgroundSaveTimer);
  const version = ++backgroundSaveVersion;
  backgroundSaveStatus = '正在保存背景…';
  if ($('background-save-status')) $('background-save-status').textContent = backgroundSaveStatus;
  window.assistant.call('preferences', { background:structuredClone(backgroundDraft) }).then(() => {
    if (version !== backgroundSaveVersion) return;
    backgroundSaveStatus = '背景已自动保存';
    if ($('background-save-status')) $('background-save-status').textContent = backgroundSaveStatus;
  }).catch(error => {
    if (version !== backgroundSaveVersion) return;
    backgroundSaveStatus = `背景保存失败：${error.message}`;
    if ($('background-save-status')) $('background-save-status').textContent = backgroundSaveStatus;
    message(backgroundSaveStatus, true);
  });
}
function scheduleBackgroundSave() { clearTimeout(backgroundSaveTimer); backgroundSaveTimer = setTimeout(saveBackground, 200); }
const lineBase = [230, 234, 241], lineDeep = [148, 158, 174];
function lineColor(depth) { const t = Math.min(1, Math.max(0, Number(depth) / 100)); return `rgb(${lineBase.map((value, index) => Math.round(value + (lineDeep[index] - value) * t)).join(', ')})`; }
async function applyBackground() {
  const bg = backgroundDraft, layer = $('background-image'), request = ++backgroundRequest;
  document.body.dataset.background = bg.preset;
  document.body.dataset.backgroundMode = bg.mode;
  document.body.style.setProperty('--panel-opacity', String(bg.panelOpacity / 100));
  document.body.style.setProperty('--panel-blur', `${bg.panelBlur}px`);
  document.body.style.setProperty('--line', lineColor(bg.lineDepth));
  document.body.style.setProperty('--panel-shadow', `0 10px 26px rgba(38, 49, 72, ${(bg.shadow / 100 * 0.18).toFixed(3)})`);
  layer.style.opacity = String(bg.opacity / 100); layer.style.filter = `blur(${bg.blur}px)`;
  layer.style.backgroundSize = ({ cover:'cover', contain:'contain', stretch:'100% 100%', center:'auto' })[bg.fit];
  layer.style.backgroundImage = 'none';
  if (bg.mode !== 'image' || !bg.imageId) return;
  try {
    const data = await call('read-background', { id:bg.imageId, original:bg.fit === 'center', width:Math.ceil(innerWidth * devicePixelRatio), height:Math.ceil(innerHeight * devicePixelRatio) });
    if (request === backgroundRequest && data) layer.style.backgroundImage = `url("${data}")`;
  } catch { /* An unavailable image falls back to the selected color. */ }
}
function backgroundControls() {
  const bg = backgroundDraft;
  return `<h2>背景设置</h2><p class="hint">背景更改立即预览并自动保存。</p><div class="background-modes"><label><input type="radio" name="background-mode" value="color" ${bg.mode === 'color' ? 'checked' : ''}>纯色 / 预设</label><label><input type="radio" name="background-mode" value="image" ${bg.mode === 'image' ? 'checked' : ''}>图片</label></div><div class="background-presets" aria-label="背景颜色">${backgroundPresets.map(([id,name]) => `<button type="button" data-bg-preset="${id}" aria-pressed="${bg.preset === id}"><span class="swatch swatch-${id}" aria-hidden="true"></span>${name}</button>`).join('')}</div><div class="background-file">${button('background-pick','选择图片')}<span>${esc(bg.imageName || '尚未选择图片')}</span>${button('background-remove','移除图片', bg.imageId ? '' : 'disabled')}</div><div class="background-controls"><label for="background-opacity">图片不透明度 <output id="background-opacity-value">${bg.opacity}%</output><input id="background-opacity" type="range" min="0" max="100" value="${bg.opacity}"></label><label for="background-blur">图片模糊半径 <output id="background-blur-value">${bg.blur} px</output><input id="background-blur" type="range" min="0" max="50" value="${bg.blur}"></label><label for="background-fit">填充方式<select id="background-fit">${[['cover','填充裁切'],['contain','完整适应'],['stretch','拉伸'],['center','原尺寸居中']].map(([id,name]) => option(id,name,bg.fit)).join('')}</select></label></div><div class="background-controls"><label for="panel-opacity">面板不透明度 <output id="panel-opacity-value">${bg.panelOpacity}%</output><input id="panel-opacity" type="range" min="0" max="100" value="${bg.panelOpacity}"></label><label for="panel-blur">面板毛玻璃模糊 <output id="panel-blur-value">${bg.panelBlur} px</output><input id="panel-blur" type="range" min="0" max="50" value="${bg.panelBlur}"></label></div><div class="background-controls"><label for="line-depth">UI 线条加深 <output id="line-depth-value">${bg.lineDepth}%</output><input id="line-depth" type="range" min="0" max="100" value="${bg.lineDepth}"></label><label for="panel-shadow">面板阴影 <output id="panel-shadow-value">${bg.shadow}%</output><input id="panel-shadow" type="range" min="0" max="100" value="${bg.shadow}"></label></div><p class="hint">面板不透明度、毛玻璃、线条与阴影只影响卡片外观，不影响文字和按钮。</p>${button('background-reset','恢复默认背景')} <span id="background-save-status" role="status">${esc(backgroundSaveStatus)}</span><p class="hint">无可用图片时显示所选颜色；选择文件后会复制到助手的用户数据目录，不修改原图。</p>`;
}
function refreshBackgroundControls() { if ($('background-settings')) $('background-settings').innerHTML = backgroundControls(); }
const titles = { overview: '运行概览', subscriptions: '订阅管理', rules: '分流管理', setup: '首次接入', settings: '设置', about:'关于' };
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; $('message').hidden = false; }
async function call(action, value) { const response = await window.assistant.call(action, value); if (response?.state) state = response.state; return response?.result ?? response; }
function allNodes() { return state.subscriptions.flatMap(s => s.nodes); }
function subName(id) { return state.subscriptions.find(s => s.id === id)?.name || '订阅不可用'; }
function nodeName(id) { return allNodes().find(n => n.id === id)?.name || '不可用 · 拒绝连接'; }
function sceneLabel(id) { if (id === state.defaultSceneId) return '默认线路'; const refs = state.rules.filter(r => r.sceneId === id); return refs.length === 1 ? refs[0].name : (state.scenes.find(s => s.id === id)?.name || '其他 / 直连') + (refs.length > 1 ? '（共享旧线路）' : ''); }
const delayText = node => node.delay ? `${node.delay} ms` : node.delayFailed ? '超时' : '—';
function setStatus() {
  const el = $('status'), retry = !state.demo && state.paused;
  el.textContent = state.status + (retry ? ' · 点击重新接入' : '');
  el.classList.toggle('status-action', retry);
  if (retry) { el.setAttribute('role', 'button'); el.tabIndex = 0; el.title = '调度已暂停或异常，点击重新接入'; }
  else { el.setAttribute('role', 'status'); el.removeAttribute('tabindex'); el.removeAttribute('title'); }
}
async function retryAttach() {
  if (busy || !state || state.demo || !state.paused) return;
  busy = true;
  try { await call('attach'); message('已重新接入调度。'); render(); }
  catch (error) { message(`重新接入失败：${error.message}`, true); }
  finally { busy = false; }
}
const trafficRanges = [['today', '当天'], ['day24', '近 24 小时'], ['d7', '近 7 天'], ['d14', '近 14 天'], ['d30', '近 30 天'], ['all', '全部']];
function niceCeiling(value) {
  const units = [1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4];
  for (const unit of units) for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
    const candidate = step * unit;
    if (candidate >= value) return candidate;
  }
  return units.at(-1) * 1024;
}
function trafficBars(data) {
  const plot = document.createElement('div'); plot.className = 'traffic-plot';
  const top = niceCeiling(Math.max(1, ...data.rows.map(row => row.bytes)));
  const axis = document.createElement('div'); axis.className = 'traffic-yaxis';
  for (const value of [top, top / 2, 0]) { const span = document.createElement('span'); span.textContent = format(value); axis.append(span); }
  const body = document.createElement('div'); body.className = 'traffic-bars-wrap';
  const grid = document.createElement('div'); grid.className = 'traffic-grid'; grid.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index++) grid.append(document.createElement('span'));
  const bars = document.createElement('div'); bars.className = 'traffic-bars';
  const sparse = data.rows.length > 14;
  data.rows.forEach((row, index) => {
    const column = document.createElement('div'); column.className = 'traffic-col'; column.title = `${row.label} · ${format(row.bytes)}`;
    const track = document.createElement('span'); track.className = 'traffic-track';
    const fill = document.createElement('i'); fill.className = 'traffic-fill'; fill.style.height = `${(row.bytes / top * 100).toFixed(1)}%`;
    track.append(fill);
    const tick = document.createElement('span'); tick.className = 'traffic-tick'; tick.textContent = sparse && index % 3 ? '' : row.label;
    column.append(track, tick); bars.append(column);
  });
  body.append(grid, bars); plot.append(axis, body); return plot;
}
function trafficHeat(data) {
  const box = document.createElement('div'); box.className = 'traffic-heat';
  const rows = data.rows, max = Math.max(1, ...rows.map(row => row.bytes));
  const first = new Date(`${rows[0]?.date || ''}T00:00:00`);
  const offset = Number.isFinite(first.getTime()) ? (first.getDay() + 6) % 7 : 0;
  const days = document.createElement('div'); days.className = 'traffic-heat-days';
  for (const name of ['周一', '', '周三', '', '周五', '', '周日']) { const span = document.createElement('span'); span.textContent = name; days.append(span); }
  const grid = document.createElement('div'); grid.className = 'traffic-heat-grid';
  rows.forEach((row, index) => {
    const level = row.bytes ? Math.max(1, Math.ceil(row.bytes / max * 4)) : 0;
    const cell = document.createElement('i'); cell.className = `traffic-cell l${level}`;
    const position = offset + index;
    cell.style.gridColumn = String(Math.floor(position / 7) + 1); cell.style.gridRow = String((position % 7) + 1);
    cell.title = `${row.date || row.label} · ${format(row.bytes)}`;
    grid.append(cell);
  });
  const main = document.createElement('div'); main.className = 'traffic-heat-main'; main.append(days, grid);
  const legend = document.createElement('div'); legend.className = 'traffic-heat-legend';
  legend.innerHTML = '少' + [0, 1, 2, 3, 4].map(level => `<i class="traffic-cell l${level}"></i>`).join('') + '多';
  box.append(main, legend); return box;
}
function paintTraffic() {
  if (!$('traffic-chart')) return;
  const data = ui.traffic.data;
  document.querySelectorAll('[data-action="traffic-range"]').forEach(el => el.classList.toggle('active', el.dataset.range === ui.traffic.range));
  if (!data) { $('traffic-chart').textContent = ui.traffic.requested ? '正在读取流量记录…' : ''; return; }
  const chart = $('traffic-chart'); chart.textContent = '';
  if (!data.rows.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '暂无记录'; chart.append(empty); }
  else chart.append(data.range === 'all' ? trafficHeat(data) : trafficBars(data));
  const first = data.rows[0]?.date || data.rows[0]?.label || '';
  $('traffic-total').textContent = data.range === 'all' && first ? `${first} – 今天 · 合计 ${format(data.total)}` : `合计 ${format(data.total)} · ${data.unit === 'hour' ? '按小时' : '按天'}`;
}
async function loadTraffic(range) {
  ui.traffic.range = range; ui.traffic.requested = true;
  try { ui.traffic.data = await call('traffic', { range }); } catch (error) { ui.traffic.data = null; message(`读取流量记录失败：${error.message}`, true); }
  ui.traffic.at = Date.now();
  paintTraffic();
}
function openModal(html, submit) { $('edit-content').innerHTML = html; modalSubmit = submit; $('editor').showModal(); }
function setHtml(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }
function keyed(container, items, make, update) {
  const existing = new Map([...container.children].map(e => [e.dataset.key, e]));
  items.forEach((item, i) => { let el = existing.get(item.key); if (!el) { el = make(item); el.dataset.key = item.key; } existing.delete(item.key); update(el, item); if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null); });
  existing.forEach(el => el.remove());
}
const ROUTES_PAGE = 6, RULES_PAGE = 8;
function routeTargets() { return [{ key: '@default', name: '默认线路', sceneId: state.defaultSceneId }, ...state.rules.filter(r => r.direct !== true).map(r => ({ key: r.id, name: r.name, sceneId: r.sceneId, ruleId: r.id }))].filter(t => state.scenes.some(s => s.id === t.sceneId)); }
function overview() {
  return `<div id="welcome"></div><div id="alerts"></div><div class="cards"><div class="card"><span class="card-label">当前线路总速率</span><div class="metric" id="metric-speed"></div><p class="muted" id="metric-window"></p></div><div class="card"><span class="card-label">日常订阅观测流量</span><div class="metric" id="metric-main"></div><p class="muted">仅本次运行的已采样连接</p></div><div class="card"><span class="card-label">其他订阅观测流量</span><div class="metric" id="metric-other"></div><p class="muted">辅助判断主订阅消耗</p></div></div><details class="panel traffic-panel" id="traffic-details" ${ui.trafficOpen ? 'open' : ''}><summary>观测流量历史</summary><div class="actions" id="traffic-ranges">${trafficRanges.map(([id, label]) => `<button type="button" data-action="traffic-range" data-range="${id}" class="${ui.traffic.range === id ? 'active' : ''}">${label}</button>`).join('')}</div><div id="traffic-chart" class="traffic-chart"></div><p class="muted" id="traffic-total"></p></details><div class="section-head"><h2>分流线路</h2><div class="actions"><small id="route-count"></small><span id="route-more"></span></div></div><div class="scene-list" id="route-list"></div><div class="section-head"><h2>实际连接</h2><small>本次运行 · 含已结束连接 · 退出清空</small></div><div class="panel connections-panel"><div class="connection-tools"><span id="connection-mode"></span><label>订阅 <select id="connection-subscription" aria-label="筛选连接订阅"></select></label><div class="actions">${button('connections-pause','暂停刷新')}${button('connections-refresh','刷新快照')}${button('connections-resume','恢复实时')}</div></div><div class="connections-table"><table><thead><tr><th>应用 / 传输</th><th>命中线路</th><th>实际订阅</th><th>实际节点</th><th>采样累计</th><th>状态 / 发现时间</th></tr></thead><tbody id="connection-rows"></tbody></table></div><div class="pagination"><span id="connection-page-info"></span><div class="actions">${button('connections-prev','上一页')}<label for="connection-page">页码</label><input id="connection-page" type="number" min="1" value="1" aria-label="连接页码">${button('connections-go','跳转')}${button('connections-next','下一页')}</div></div></div><details class="panel" id="application-summary"><summary>按应用汇总本次观测流量</summary><table><thead><tr><th>应用</th><th>采样增量</th></tr></thead><tbody id="application-rows"></tbody></table></details><details class="panel auto-panel" id="auto-panel"><summary>自动调度检查</summary><div id="auto-rows" class="muted"></div></details><div id="runtime-errors"></div>`;
}
function updateOverview() {
  const total = Object.values(state.metrics).reduce((n, m) => n + m.speed, 0), mainId = state.scenes.find(s => s.id === state.defaultSceneId)?.subscriptionId;
  $('metric-speed').textContent = format(total) + '/s'; $('metric-main').textContent = format(state.subscriptionBytes[mainId] || 0);
  $('metric-other').textContent = format(Object.entries(state.subscriptionBytes).filter(([id]) => id !== mainId).reduce((n, [, bytes]) => n + bytes, 0));
  $('metric-window').textContent = `按连接增量 · ${state.preferences.averageWindow / 1000} 秒窗口`;
  setHtml($('welcome'), state.demo ? '<div class="banner"><div><h2>先看清流量，再决定路线</h2><p>当前为三家模拟订阅，所有数字和连接均为演示数据。</p></div><span class="pill">隔离演示</span></div>' : !state.setup.ready || state.setup.needsUpgradeConfirmation ? `<div class="banner"><div><h2>${state.setup.needsUpgradeConfirmation ? '旧数据已保留，请重新确认接入' : '欢迎使用 FoxFerry'}</h2><p>保留现有订阅，通过专用本地配置接入。</p></div>${button('go-setup','开始接入','','primary')}</div>` : '');
  setHtml($('alerts'), state.alerts.map(a => `<div class="alert"><strong>${esc(sceneLabel(a.sceneId))} · 调度提醒</strong><p>${esc(a.message)}。不回应则保持路线。</p><div class="actions">${button('keep','保持当前',`data-id="${a.id}"`)}${button('choose','选择切换方式',`data-id="${a.sceneId}" data-alert="${a.id}"`,'primary')}</div></div>`).join(''));
  const targets = routeTargets(); $('route-count').textContent = `${state.subscriptions.length} 个订阅 · ${state.rules.length} 条分流`;
  const visible = ui.routesExpanded ? targets : targets.slice(0, ROUTES_PAGE);
  setHtml($('route-more'), targets.length > ROUTES_PAGE ? button('toggle-routes', ui.routesExpanded ? '收起' : `展开全部（${targets.length}）`) : '');
  keyed($('route-list'), visible, t => { const el = document.createElement('article'); el.className = 'panel scene'; el.innerHTML = '<div><h3 data-field="name"></h3><p data-field="mode" class="muted"></p></div><div><h3 data-field="subscription"></h3><p data-field="node" class="muted"></p></div><div><h3 data-field="speed"></h3><p data-field="connections" class="muted"></p></div><div class="actions" data-field="actions"></div>'; return el; }, (el, t) => {
    const s = state.scenes.find(s => s.id === t.sceneId), m = state.metrics[s.id] || {}, node = allNodes().find(n => n.id === s.selected), inherited = !!t.ruleId && s.id === state.defaultSceneId, shared = state.rules.filter(r => r.sceneId === s.id).length > 1;
    const text = (field, value) => { el.querySelector(`[data-field="${field}"]`).textContent = value; };
    text('name',t.name); text('mode',`${!t.ruleId ? '日常默认' : inherited ? '跟随默认线路' : shared ? '共享旧线路' : '独立线路'} · ${s.temporary ? '临时加速' : s.mode === 'auto' ? (s.anyCountry ? '最低延迟自动' : '同国自动') : '手动锁定'} · ${s.anyCountry ? '不限国家' : (s.countryLock || '国家未知')}`);
    text('subscription',subName(s.subscriptionId)); text('node',`${nodeName(s.selected)} · ${node?.countrySource || '未知'}${node?.delay ? ' · ' + node.delay + 'ms' : node?.delayFailed ? ' · 超时' : ''}${node?.udp === false ? ' · UDP 不支持（拒绝回落）' : ''}`);
    text('speed',inherited || (t.ruleId && shared) ? '共享线路' : format(m.speed) + '/s'); text('connections',`${m.connections || 0} 条线路连接 · 旧路线 ${m.oldConnections || 0} 条`);
    setHtml(el.querySelector('[data-field="actions"]'), button(t.ruleId ? 'entry-choose' : 'choose','选择路线',`data-id="${t.ruleId || s.id}"`) + (s.temporary && (!t.ruleId || !inherited && !shared) ? button(t.ruleId ? 'entry-restore' : 'restore','恢复',`data-id="${t.ruleId || s.id}"`) : ''));
  });
  
  updateConnections();
  const checks = (state.autoChecks || []).slice(-12).reverse();
  setHtml($('auto-rows'), checks.map(c => `<p class="muted">${new Date(c.at).toLocaleTimeString()} · ${esc(c.sceneName)} · ${esc(c.decision)}${c.to ? ` → ${esc(c.to)}` : ''}${c.reason ? ` · ${esc(c.reason)}` : ''}${c.current ? ` · 当前 ${esc(c.current)}` : ''}${c.best ? ` · 最快 ${esc(c.best)}` : ''}${c.error ? ` · ${esc(c.error)}` : ''}</p>`).join('') || '<p class="muted">还没有自动检查记录；接入后每一轮延迟检查都会写入这里。</p>');
  setHtml($('application-rows'), Object.entries(state.applicationBytes).map(([app, bytes]) => `<tr><td>${esc(app)}</td><td>${format(bytes)}</td></tr>`).join('') || '<tr><td colspan="2">暂无采样</td></tr>');
  setHtml($('runtime-errors'), state.errors.length ? '<div class="section-head"><h2>运行提示</h2></div><div class="panel">' + state.errors.map(e => `<p class="muted">${new Date(e.at).toLocaleTimeString()} · ${esc(e.message)}</p>`).join('') + '</div>' : '');
  paintTraffic();
  if ($('traffic-details')?.open && (!ui.traffic.requested || Date.now() - ui.traffic.at > 60000)) loadTraffic(ui.traffic.range);
}
function updateConnections() {
  const choices = [['','全部订阅'], ...state.subscriptions.map(s => [s.id,s.name]), ['@unknown','未归属 / 直连']];
  if (ui.connectionSubscription && !choices.some(([id]) => id === ui.connectionSubscription)) choices.push([ui.connectionSubscription,'历史订阅']);
  setHtml($('connection-subscription'), choices.map(([id,name]) => option(id,name,ui.connectionSubscription)).join(''));
  setHtml($('connection-rows'), pager.visible.map(c => `<tr data-id="${esc(c.id)}" data-status="${esc(c.status)}"><td title="${esc(c.process)}">${esc(c.process)}<br><small>${esc(c.network.toUpperCase())}</small></td><td title="${esc(c.line)}">${esc(c.line)}</td><td title="${esc(c.subscription)}">${esc(c.subscription)}</td><td title="${esc(c.node)}">${esc(c.node)}</td><td title="最后一次采样的累计上传与下载">${format(c.bytes)}</td><td title="${esc('首次观测：' + new Date(c.firstSeenAt).toLocaleString() + '\n最后观测：' + new Date(c.lastSeenAt).toLocaleString() + (c.endedAt === null ? '' : '\n采样发现结束：' + new Date(c.endedAt).toLocaleString()))}"><span class="connection-status" tabindex="0" aria-label="${esc(c.status === 'ended' ? '已结束；采样发现结束：' + new Date(c.endedAt).toLocaleString() : '活动中')}">${c.status === 'ended' ? '已结束 ⓘ' : '活动中'}</span><br><small>发现：${new Date(c.firstSeenAt).toLocaleString()}</small></td></tr>`).join('') || '<tr><td colspan="6" class="empty">本次运行尚无观测记录</td></tr>');
  $('connection-mode').textContent = `${pager.paused ? '已暂停 · 快照' : '实时'}${pager.sampledAt ? ' · ' + new Date(pager.sampledAt).toLocaleTimeString() : ''}${pager.dropped ? ` · 更早的已结束记录已清理 ${pager.dropped} 条` : ''}`;
  const active = pager.active;
  $('connection-page-info').textContent = `共 ${pager.total} 条（活动 ${active} · 结束 ${pager.total - active}） · 第 ${pager.page} / ${pager.pages} 页 · 每页 10 条`;
  $('connection-page').max = pager.pages; if (document.activeElement !== $('connection-page')) $('connection-page').value = pager.page;
  document.querySelector('[data-action="connections-prev"]').disabled = pager.page <= 1; document.querySelector('[data-action="connections-next"]').disabled = pager.page >= pager.pages;
  document.querySelector('[data-action="connections-pause"]').disabled = pager.paused; document.querySelector('[data-action="connections-resume"]').disabled = !pager.paused;
}
function rules() {
  const s = state.scenes.find(s => s.id === state.defaultSceneId);
  const shown = ui.rulesExpanded ? state.rules : state.rules.slice(0, RULES_PAGE);
  return `<div class="panel"><div class="section-head"><div><h2>默认线路</h2><p class="muted">${s ? esc(subName(s.subscriptionId)) + ' · ' + esc(nodeName(s.selected)) : '请先添加订阅'}</p></div>${button('edit-default','设置默认线路')}</div><p class="muted">未单独设置的分流，以及其他未匹配的代理流量，都使用此线路。</p></div><div class="section-head"><h2>分流管理</h2><div class="actions">${button('preset','主副分流预设')}${button('add-entry','＋ 添加分流','','primary')}</div></div><div class="panel"><p class="muted">按顺序匹配；同类应用或域名为“或”，同时指定应用和网站为“且”。基础直连保持优先；标记为直连的分流优先于线路规则。</p><table><thead><tr><th>顺序 / 名称</th><th>匹配对象</th><th>线路</th><th>操作</th></tr></thead><tbody>${shown.map((r,i) => `<tr><td>${i+1}. ${esc(r.name)}${r.enabled === false ? '（停用）' : ''}</td><td class="match-target">${[...(r.processPaths || []), ...r.processes, ...r.domains].map(esc).join('<br>')}</td><td>${r.direct === true ? '直连（不消耗订阅流量）' : r.sceneId === state.defaultSceneId ? '跟随默认线路' : (state.rules.filter(x=>x.sceneId===r.sceneId).length>1?'共享旧线路':'独立设置') + ' · ' + esc(subName(state.scenes.find(s => s.id === r.sceneId)?.subscriptionId))}</td><td><div class="rule-actions">${button('up-rule','↑',`data-id="${r.id}" aria-label="上移分流"`)}${button('edit-entry','编辑',`data-id="${r.id}"`)}${r.direct === true ? '' : button('entry-choose','选择路线',`data-id="${r.id}"`)}${button('remove-entry','删除',`data-id="${r.id}"`)}</div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">点击添加分流，选择应用或填写网站即可。</td></tr>'}${state.rules.length > RULES_PAGE ? `<tr><td colspan="4">${button('toggle-rules', ui.rulesExpanded ? '收起' : `展开全部（${state.rules.length} 条分流）`)}</td></tr>` : ''}</tbody></table></div>`;
}

const switchReasons = { 'auto-country': '同国自动', 'auto-any': '最低延迟自动', manual: '手动', temporary: '临时加速', restore: '恢复路线' };
function switchLog(subId) {
  const rows = (state.switches || []).filter(x => x.subscriptionId === subId || x.fromSubscriptionId === subId).slice(-20).reverse();
  const body = rows.length ? `<table class="nodes"><thead><tr><th>时间</th><th>线路</th><th>节点变化</th><th>原因</th></tr></thead><tbody>${rows.map(x => `<tr><td>${new Date(x.at).toLocaleString()}</td><td>${esc(x.sceneName || '')}</td><td>${esc(x.from || '—')} → ${esc(x.to || '—')}</td><td>${esc(switchReasons[x.reason] || x.reason || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">尚未记录到切换：FoxFerry 自动或手动换线后会显示在这里。</p>';
  return `<details class="switch-log" ${ui.openSwitches === subId ? 'open' : ''} data-switch="${subId}"><summary>节点切换记录（${rows.length}）</summary>${body}</details>`;
}
function subscriptions() {  return `<div class="section-head"><h2>统一管理，独立更新</h2><div class="actions">${button('import', '读取 Verge 订阅')}${button('add-sub', '＋ 添加订阅', '', 'primary')}</div></div><p class="muted">Verge 订阅由 Verge 更新；助手添加的订阅默认每日更新。仅支持含 proxies 的 Mihomo YAML。</p>${state.subscriptions.map(s => `<article class="panel subscription"><div class="section-head"><div><h3>${esc(s.name)}</h3><p class="muted">${s.kind === 'verge' ? 'Verge 引用' : s.kind === 'url' ? 'HTTPS 订阅' : '本地文件'} · ${s.nodes.length} 个节点 · 更新于 ${new Date(s.updatedAt).toLocaleString()}</p></div><div class="actions">${button('probe-delays', '查询节点延迟', `data-id="${s.id}"`)}${button('refresh', '更新', `data-id="${s.id}"`)}${button('remove-sub', '移除', `data-id="${s.id}"`, 'danger')}</div></div>${s.error ? `<p class="notice">${esc(s.error)}</p>` : ''}<small>本次观测 ${format(state.subscriptionBytes[s.id] || 0)}</small><details ${ui.openSub === s.id ? 'open' : ''} data-sub="${s.id}"><summary>查看节点与国家来源</summary><table class="nodes"><thead><tr><th>节点</th><th>国家</th><th>来源</th><th>延迟</th><th>检测</th></tr></thead><tbody>${s.nodes.map(n => `<tr><td>${esc(n.name)}</td><td>${esc(n.country || '未知')}</td><td>${esc(n.countrySource)}</td><td>${delayText(n)}</td><td>${button('probe', '检测实际出口', `data-id="${n.id}"`)}</td></tr>`).join('')}</tbody></table><p class="notice">「查询节点延迟」向该订阅每个节点各发一次小请求，延迟高低不代表带宽；「检测实际出口」使用独立测试内核向 Cloudflare 发送少量流量，不改业务组选择；名称标注并非已验证地理位置。</p></details>${switchLog(s.id)}</article>`).join('') || '<div class="panel empty">尚未添加订阅。可先读取 Verge 已导入的订阅。</div>'}`;
}

function setup() {
  return `<div class="panel"><h2>首次接入向导</h2><p class="muted">助手只维护自己的配置。原订阅保留；首次启用由你在 Verge 中完成。</p><div class="steps"><div class="step"><div><h3>发现 Clash Verge 与 Mihomo</h3><p>优先使用运行配置中的 Windows 命名管道。</p><div class="actions">${button('scan', '自动发现', '', 'primary')}${button('pick-dir', '选择配置目录')}${button('pick-core', '选择 Mihomo.exe')}</div><p id="scan-result">${esc(scanResult ? `目录：${scanResult.dir || '未发现'}\n内核：${scanResult.corePath || '未发现'}\n控制接口：${scanResult.controller}` : state.setup.vergeDir || '尚未发现')}</p></div></div><div class="step"><div><h3>读取订阅，添加分流</h3><p>仅只读引用 Verge 导入的节点文件，更新和本地策略独立保存。</p><div class="actions">${button('import', '读取已有订阅')}${button('preset', '主副分流预设')}</div></div></div><div class="step"><div><h3>生成已校验的专用配置</h3><p>在 Verge 中新建「本地」配置，使用下方文件内容；若 Verge 导入为副本，后续更新由助手在运行时应用。不要覆盖原订阅。</p>${button('prepare', '校验并生成', '', 'primary')}<p class="mono">${esc(state.configFile)}</p>${button('open-config', '打开专用配置目录')}<p class="notice">此文件包含节点凭据，仅用于你自己的本地 Verge，请勿分享或提交到仓库。</p></div></div><div class="step"><div><h3>在 Verge 启用后，确认接入</h3><p>启用规则模式；确认端口、TUN、DNS 等仍符合你的设置。其他扩展不得覆盖助手规则。</p><div class="actions">${button('attach', '确认已启用，接入调度', '', 'primary')}${button('pause', '暂停调度')}</div></div></div></div></div>`;
}

function settings() {
  const fields = [['delayInterval', '延迟检查周期', '秒', 1000], ['tolerance', '自动切换容差', 'ms', 1], ['dwell', '自动切换最短驻留', '秒', 1000], ['sampleInterval', '流量采样间隔', 'ms', 1], ['averageWindow', '流量平均窗口', '秒', 1000], ['sustained', '持续超过提醒线', '秒', 1000], ['cooldown', '同线路提醒最短间隔', '秒', 1000], ['idleRate', '临时加速空闲线', 'KiB/s', 1024], ['idleDuration', '连续空闲恢复时间', '秒', 1000], ['updateInterval', '助手订阅更新周期', '小时', 3600000]];
  return `<div id="background-settings" class="panel background-settings">${backgroundControls()}</div><div class="panel"><h2>Clash Verge 联动</h2><p class="muted">更改后自动保存。 <span id="settings-save-status" role="status">${esc(settingsSaveStatus)}</span></p><div class="setting-row"><div><label><input type="checkbox" id="set-follow" ${state.preferences.follow ? 'checked' : ''} ${state.demo ? 'disabled' : ''}>跟随 Clash Verge 启停</label><small>安装版同时登记登录启动助手；后台启动助手会保留，手动退出后本次会话不再拉起。</small></div></div><div class="section-head"><h2>调度参数</h2></div>${fields.map(([id, label, unit, scale]) => `<div class="setting-row"><label for="set-${id}">${label} <small>${unit}</small></label><input type="number" id="set-${id}" data-scale="${scale}" min="0" step="any" value="${state.preferences[id] / scale}"></div>`).join('')}<div class="section-head">${button('reset-scheduling', '恢复默认调度参数')}<span id="scheduling-save-status" role="status" class="muted">${esc(settingsSaveStatus)}</span></div></div>`;
}

function about() {
  return `<div class="about-grid"><section class="panel about-brand"><img src="../../assets/fox-logo.png" alt="FoxFerry 狐狸标志"><div><h2>FoxFerry <small class="version-badge">v${esc(state.appVersion)}</small></h2><p>订阅聚合与分流助手</p><p>FoxFerry 采用 MIT 许可证。</p><button id="repository-button" title="项目仓库" aria-label="项目仓库">GitHub 项目仓库 ↗</button></div></section><section class="panel about-updates"><h2>更新</h2><p class="muted">手动检查本项目的稳定版本。</p><button id="updates-button" class="check-now" title="检查更新" aria-label="检查更新"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7a8 8 0 1 0 1 9M19 2v6h-6" fill="none" stroke="currentColor" stroke-width="2"/></svg>立即检查</button><div id="update-result" class="update-notice" role="status" tabindex="0" hidden><span id="update-text"></span><button id="update-install-button" class="primary" hidden>立即更新</button><button id="release-button" hidden>打开发布页面</button></div></section><section class="panel about-support"><h2>支持 FoxFerry</h2><p>FoxFerry 免费开源。<br>在 GitHub 上点星、报告错误、提出想法或赞助，都是很大的支持。</p><div class="actions"><button id="star-button" class="primary">在 GitHub 上点星</button><button id="issues-button">报告问题 · 提出建议</button><button id="sponsor-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21 3.5 12.5a5.7 5.7 0 0 1 8.5-7.6 5.7 5.7 0 0 1 8.5 7.6Z"/></svg>赞助</button></div></section><section class="panel about-licenses"><h2>许可与第三方声明</h2><p>FoxFerry 采用 MIT 许可证。第三方组件及其署名见「第三方声明」。</p><div class="actions"><button data-license="mit">MIT 许可证</button><button data-license="notice">第三方声明</button></div></section></div>`;
}

function render() {
  if (!state || $('editor').open) return;
  $('app-version').textContent = `v${state.appVersion}`;
  $('page-title').textContent = titles[page]; setStatus();
  document.querySelectorAll('[data-page]').forEach(el => {const active=el.dataset.page===page;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  if (page === 'overview') {
    if (!$('route-list')) { $('content').innerHTML = overview(); $('application-summary').open = ui.summaryOpen; $('application-summary').addEventListener('toggle', () => { ui.summaryOpen = $('application-summary')?.open ?? ui.summaryOpen; }); }
    updateOverview();
  } else {
    $('content').innerHTML = ({ subscriptions, rules, setup, settings, about })[page]();
    if(page==='about')updateNotice.paint();
    if(page==='rules') { const unused=state.scenes.filter(s=>s.id!==state.defaultSceneId&&!state.rules.some(r=>r.sceneId===s.id)); if(unused.length)$('content').insertAdjacentHTML('beforeend',`<details class="panel"><summary>保留的旧线路（${unused.length}）</summary><p class="muted">这些旧线路没有绑定分流。为保留旧数据未自动删除，可在这里调整其订阅和节点。</p>${unused.map(s=>`<div class="setting-row"><span>${esc(s.name)} · ${esc(subName(s.subscriptionId))}</span>${button('edit-legacy','调整线路',`data-id="${s.id}"`)}</div>`).join('')}</details>`); }
  }
}
async function savePolicy(scenes = state.scenes, rules = state.rules, defaultSceneId = state.defaultSceneId) { await call('policy', { scenes, rules, defaultSceneId }); }
function routeFields(s) {
  return `<div class="form-grid"><div><label for="scene-sub">目标订阅</label><select id="scene-sub">${state.subscriptions.map(x=>option(x.id,x.name,s.subscriptionId)).join('')}</select></div><div><label for="scene-mode">选择模式</label><select id="scene-mode">${option('auto','同国自动',s.mode)}${option('manual','手动锁定',s.mode)}</select></div><div><label for="scene-lock">自动锁定国家（两位代码）</label><input id="scene-lock" value="${esc(s.countryLock || '')}"></div><div><label for="scene-countries">允许国家（逗号分隔，留空不限）</label><input id="scene-countries" value="${esc(s.countries.join(','))}"></div></div><label for="scene-node">当前节点</label><select id="scene-node"></select><label for="scene-candidates">候选节点（Ctrl 多选；不选表示全部）</label><select id="scene-candidates" multiple size="4"></select><label for="scene-threshold">速度提醒线（MiB/s，留空关闭）</label><input id="scene-threshold" type="number" min="0.001" step="any" value="${s.threshold ? s.threshold/1048576 : ''}"><p class="muted">临时加速空闲恢复沿用设置中的参数；未知国家不参与自动同国切换。</p>`;
}
function wireRouteFields(s) {
  const fill = () => { const list = state.subscriptions.find(x=>x.id === $('scene-sub').value)?.nodes || []; const current = list.find(n=>n.id === s.selected) || list.find(n=>n.country === $('scene-lock').value && n.country); $('scene-node').innerHTML = option('','拒绝连接（不回退其他订阅）',current?.id || '') + list.map(n=>option(n.id,n.name,current?.id)).join(''); $('scene-candidates').innerHTML = list.map(n=>`<option value="${n.id}" ${s.candidates.includes(n.id) ? 'selected' : ''}>${esc(n.name)}</option>`).join(''); };
  $('scene-sub').addEventListener('change',fill); $('scene-node').addEventListener('change',()=>{const node=allNodes().find(n=>n.id===$('scene-node').value); if(node)$('scene-lock').value=node.country||'';}); fill();
}
function readRouteFields(base) { const lock=$('scene-lock').value.trim().toUpperCase()||null; return { subscriptionId:$('scene-sub').value, mode:$('scene-mode').value, countryLock:lock, countries:$('scene-countries').value.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean), candidates:[...$('scene-candidates').selectedOptions].map(o=>o.value), selected:$('scene-node').value || null, threshold:$('scene-threshold').value ? +$('scene-threshold').value*1048576 : null, anyCountry: lock ? false : base?.anyCountry === true }; }
function editDefault(id=state.defaultSceneId) {
  const s=state.scenes.find(s=>s.id===id); if(!s)throw Error('请先添加订阅'); if(s.temporary)throw Error('请先恢复此线路的临时加速');
  openModal((id===state.defaultSceneId?'<h2>设置默认线路</h2><p class="notice">跟随默认的分流和未匹配代理流量将使用这里的线路；已有独立线路不变。</p>':'<h2>调整保留的旧线路</h2><p class="muted">只调整此条未绑定的旧线路，保留其 ID 与其他设置。</p>')+routeFields(s),()=>savePolicy(state.scenes.map(x=>x.id===s.id ? {...s,...readRouteFields(s)} : x))); wireRouteFields(s);
}
function editEntry(id) {
  const old=state.rules.find(r=>r.id===id), base=state.scenes.find(s=>s.id===(old?.sceneId || state.defaultSceneId)); if(!base)throw Error('请先添加订阅并设置默认线路');
  const r=old || {name:'',processes:[],processPaths:[],domains:[],enabled:true}; const direct=!!old && old.direct===true; const custom=!direct && !!old && r.sceneId!==state.defaultSceneId; const app=!!(r.processes.length || r.processPaths?.length) || !r.domains.length;
  openModal(`<h2>${old ? '编辑' : '添加'}分流</h2><label for="entry-kind">匹配类型</label><select id="entry-kind">${option('app','应用（完整 .exe 路径）',app?'app':'site')}${option('site','网站域名',app?'app':'site')}</select><div id="primary-match"></div><label for="entry-name">名称</label><input id="entry-name" required value="${esc(r.name)}"><details id="entry-advanced" ${custom || (app && r.domains.length) ? 'open' : ''}><summary>高级选项${custom ? ' · 已有独立设置' : ' · 默认跟随日常线路'}</summary><h3 class="advanced-heading">附加匹配条件（与上方条件同时满足）</h3><div id="extra-match"></div>${r.processes.length ? `<label for="entry-processes">已有按进程名匹配（与路径为“或”关系）</label><textarea id="entry-processes">${esc(r.processes.join('\n'))}</textarea>` : '<textarea id="entry-processes" hidden></textarea>'}<label><input id="entry-custom" type="checkbox" ${custom?'checked':''}>为本条分流单独设置线路</label><p id="inherit-note" class="muted">跟随默认线路；日常订阅和节点变化会同步生效。</p><label><input id="entry-direct" type="checkbox" ${direct?'checked':''}>直连（不消耗订阅流量）</label><p id="direct-note" class="muted">直连不使用订阅节点，出口为本地宽带；不消耗订阅额度，但没有代理 IP 和跨区加速。</p><fieldset id="route-fields">${routeFields(base)}</fieldset></details><label><input id="entry-enabled" type="checkbox" ${r.enabled!==false?'checked':''}>启用分流</label>`, async()=>{
    const split=value=>value.split('\n').map(s=>s.trim()).filter(Boolean);
    const paths=split($('entry-paths').value), domains=split($('entry-domains').value).map(s=>s.toLowerCase()), processes=split($('entry-processes').value);
    if($('entry-kind').value==='app'&&!paths.length&&!processes.length)throw Error('请先选择应用 .exe 文件'); if($('entry-kind').value==='site'&&!domains.length)throw Error('请填写网站域名');
    await call('saveRoutingEntry',{id:old?.id,name:$('entry-name').value,processes,processPaths:paths,domains,enabled:$('entry-enabled').checked,direct:$('entry-direct').checked,route:$('entry-custom').checked?{mode:'custom',settings:readRouteFields(base)}:{mode:'default'}});
  });
  const appBox=document.createElement('div'); appBox.innerHTML=`<label for="entry-paths">应用完整路径（每行一个）</label><div class="actions">${button('pick-app','选择应用 .exe')}</div><textarea id="entry-paths" placeholder="C:\\Program Files\\应用\\app.exe">${esc((r.processPaths||[]).join('\n'))}</textarea>`;
  const siteBox=document.createElement('div'); siteBox.innerHTML=`<label for="entry-domains">网站域名（每行一个）</label><textarea id="entry-domains" placeholder="example.com">${esc(r.domains.join('\n'))}</textarea>`;
  const arrange=()=>{const isApp=$('entry-kind').value==='app'; $('primary-match').append(isApp?appBox:siteBox); $('extra-match').append(isApp?siteBox:appBox);}; $('entry-kind').addEventListener('change',arrange); arrange();
  const toggle=()=>{ const isDirect=$('entry-direct').checked; $('entry-custom').disabled=isDirect; $('route-fields').hidden=!$('entry-custom').checked||isDirect; $('route-fields').disabled=!$('entry-custom').checked||isDirect; $('inherit-note').hidden=isDirect||$('entry-custom').checked; $('direct-note').hidden=!isDirect; document.querySelector('#entry-advanced > summary').textContent='高级选项 · '+(isDirect?'直连':($('entry-custom').checked?'单独设置线路':'跟随默认线路')); }; $('entry-custom').addEventListener('change',()=>{ if($('entry-custom').checked)$('entry-direct').checked=false; toggle(); }); $('entry-direct').addEventListener('change',()=>{ if($('entry-direct').checked){$('entry-custom').checked=false;} toggle(); }); toggle(); wireRouteFields(base);
  $('entry-domains').addEventListener('input',()=>{ if(!$('entry-name').value)$('entry-name').value=$('entry-domains').value.trim().split('\n')[0]; });
}
function choose(sceneId, alertId, ruleId) {
  const scene=state.scenes.find(s=>s.id===sceneId); if(!scene)throw Error('线路不存在');
  const name=ruleId?state.rules.find(r=>r.id===ruleId)?.name:sceneLabel(sceneId);
  const autoSame=!alertId && scene.mode==='auto' && !scene.anyCountry, autoAny=!alertId && scene.mode==='auto' && !!scene.anyCountry;
  openModal(`<h2>${esc(name)} · 选择路线</h2><p class="muted">${ruleId?'只修改本条分流；跟随默认或共享旧线路的条目会自动获得独立线路。':'此操作修改该线路，跟随它的分流会一起使用新路线。'}</p><label for="choose-sub">订阅</label><select id="choose-sub">${state.subscriptions.map(s=>option(s.id,s.name,scene.subscriptionId)).join('')}</select><label for="choose-node">节点</label><select id="choose-node"></select><div class="actions choose-actions">${button('choose-probe','查询延迟')}<span id="choose-probe-status" class="muted" role="status"></span></div><label class="switch-row"><span>启用同国自动（按所选节点的国家）</span><input id="choose-same" type="checkbox" role="switch" ${autoSame?'checked':''}></label><label><input id="choose-auto" type="checkbox" ${autoAny?'checked':''}>自动最低延迟（不限国家，定时重探）</label><p class="notice">同国自动与自动最低延迟互斥，且节点频繁跳转会让出口 IP 变化，部分网站和应用可能判定为异常登录并封禁账号；下载、上传与登录态也可能中断。</p><label><input id="choose-temp" type="checkbox" ${alertId?'checked':''}>临时加速，空闲后恢复原路线</label><label><input id="choose-reconnect" type="checkbox">切换并重连本条分流${ruleId?'':' / 线路'}</label><p class="notice">换节点只会改变同国自动锁定的国家，不会退出已开着的自动模式；两项自动模式都不勾选时，按所选节点手动锁定。临时加速与之互斥。默认只切换后续新连接；定向重连可能短暂停顿，TCP/UDP 与下载续传都可能失败。</p>`, async()=>{
    if($('choose-auto').checked){ await call(ruleId?'switchRoutingEntry':'auto', ruleId?{id:ruleId,operation:'auto',anyCountry:true}:{sceneId,anyCountry:true}); message('已启用自动最低延迟：下一轮探测后会切到延迟最低的节点。'); return; }
    if($('choose-same').checked){
      const chosen=allNodes().find(n=>n.id===$('choose-node').value);
      const lock=chosen?.country || scene.countryLock;
      if(!lock) throw Error('同国自动需要已知国家：请选择一个带国家标注的节点，或改用「自动最低延迟」');
      await call(ruleId?'switchRoutingEntry':'auto', ruleId?{id:ruleId,operation:'auto',country:lock}:{sceneId,country:lock});
      message(`已启用同国自动：锁定 ${lock}，只在该国家内选最快节点。`); return;
    }
    const value={nodeId:$('choose-node').value,temporary:$('choose-temp').checked,reconnect:$('choose-reconnect').checked,alertId:alertId||null}; const result=await call(ruleId?'switchRoutingEntry':'switch',ruleId?{...value,id:ruleId}:{...value,sceneId}); if(result?.warning)message(result.warning);
  });
  const fill=()=>{ if(!$('choose-node'))return; const current=$('choose-node').value||scene.selected; $('choose-node').innerHTML=state.subscriptions.find(s=>s.id===$('choose-sub').value)?.nodes.map(n=>option(n.id,`${n.name} · ${n.country||'未知'} (${n.countrySource}) · ${delayText(n)}`,current)).join('')||'<option value="">没有可用节点</option>'; };
  $('choose-sub').addEventListener('change',()=>{ fill(); $('choose-same').checked=false; $('choose-auto').checked=false; }); ui.chooseFill=fill; fill();
  // Changing the node keeps the chosen automatic mode: the node then only selects the country to lock.
  const exclusive=(id,others)=>$(id).addEventListener('change',()=>{ if($(id).checked) for(const other of others) $(other).checked=false; });
  exclusive('choose-auto',['choose-same','choose-temp']); exclusive('choose-same',['choose-auto','choose-temp']); exclusive('choose-temp',['choose-auto','choose-same']);
}
async function act(action,el) {
  const id=el.dataset.id;
  switch(action) {
    case 'go-setup': page='setup'; break;
    case 'add-entry': editEntry(); break;
    case 'toggle-rules': ui.rulesExpanded = !ui.rulesExpanded; render(); break;
    case 'toggle-routes': ui.routesExpanded = !ui.routesExpanded; updateOverview(); break;
    case 'edit-entry': editEntry(id); break;
    case 'edit-default': editDefault(); break;
    case 'edit-legacy': editDefault(id); break;
    case 'remove-entry': await call('removeRoutingEntry',{id}); break;
    case 'pick-app': { const file=await call('pick',{kind:'app'}); if(file){$('entry-paths').value=file; $('entry-processes').value=''; if(!$('entry-name').value)$('entry-name').value=file.split(/[\\/]/).at(-1).replace(/\.exe$/i,'');} break; }
    case 'up-rule': {const rows=[...state.rules],index=rows.findIndex(r=>r.id===id); if(index>0){[rows[index-1],rows[index]]=[rows[index],rows[index-1]]; await savePolicy(state.scenes,rows);} break;}
    case 'choose': choose(id,el.dataset.alert); break;
    case 'entry-choose': {const r=state.rules.find(r=>r.id===id);choose(r.sceneId,null,r.id);break;}
    case 'restore': await call('restore',{sceneId:id}); message('已恢复原路线，旧连接不主动关闭。');break;
    case 'entry-restore': await call('switchRoutingEntry',{id,operation:'restore'});message('已恢复原路线，旧连接不主动关闭。');break;
    case 'auto': await call('auto',{sceneId:id});$('editor').close();break;
    case 'entry-auto': await call('switchRoutingEntry',{id,operation:'auto'});$('editor').close();break;
    case 'keep': await call('keep',{id});break;
    case 'connections-pause': await fetchConnections('pause');break;
    case 'connections-refresh': await fetchConnections('refresh');break;
    case 'connections-resume': await fetchConnections('resume', 1);break;
    case 'connections-prev': await fetchConnections(pager.paused ? 'snapshot' : 'pause', pager.page-1);break;
    case 'connections-next': await fetchConnections(pager.paused ? 'snapshot' : 'pause', pager.page+1);break;
    case 'connections-go': await fetchConnections(pager.paused ? 'snapshot' : 'pause', Number($('connection-page').value));break;
    case 'traffic-range': await loadTraffic(el.dataset.range); break;
    case 'scan': scanResult = await call('scan'); message('发现完成；若路径不符可手动选择。'); break;
    case 'pick-dir': case 'pick-core': { const file = await call('pick', { kind: action === 'pick-dir' ? 'dir' : 'core' }); if (file) scanResult = await call('paths', action === 'pick-dir' ? { vergeDir: file } : { corePath: file }); break; }
    case 'import': { const result = await call('import'); message(`已读取 ${result?.count ?? 3} 个订阅。${result?.errors?.join('；') || ''}`); break; }
    case 'prepare': { const result = await call('prepare'); message(`已校验并生成：${result.file}\n请在 Verge 中新建本地配置，导入并启用一次。`); break; }
    case 'attach': await call('attach'); message('接入完成。请通过实际连接表确认分流。'); page = 'overview'; break;
    case 'pause': await call('pause'); message('已暂停调度，现有代理连接保持。'); break;
    case 'open-config': await call('open-config'); break;
    case 'add-sub': openModal('<h2>添加 Mihomo 订阅</h2><label for="sub-name">名称</label><input id="sub-name" required><label for="sub-url">HTTPS 订阅链接</label><input id="sub-url" type="url" placeholder="https://…"><label for="sub-file">或本地 YAML 文件</label><div class="inline-field"><input id="sub-file" readonly><button type="button" data-action="pick-sub">选择文件</button></div><p class="muted">链接和节点凭据只保存在用户数据目录。</p>', async () => { await call('addSubscription', { name: $('sub-name').value, url: $('sub-url').value || undefined, file: $('sub-file').value || undefined }); }); break;
    case 'pick-sub': { const file = await call('pick', { kind: 'yaml' }); if (file) { $('sub-file').value = file; $('sub-url').value = ''; } break; }
    case 'refresh': await call('refresh', { id }); message('订阅更新完成。'); break;
    case 'probe-delays': {
      const sub=state.subscriptions.find(s=>s.id===id), ids=sub?.nodes.map(n=>n.id)||[];
      if(!ids.length)throw Error('该订阅没有可用节点');
      ui.openSub=id; message(`正在查询 ${ids.length} 个节点的延迟…`);
      const values=Object.values(await call('probeDelays',{ids})||{}), failed=values.filter(v=>v===null).length;
      message(`延迟查询完成：${values.length-failed} 个可用，${failed} 个超时或不可达。`);
      break;
    }
    case 'choose-probe': {
      const list=state.subscriptions.find(s=>s.id===$('choose-sub')?.value)?.nodes||[], label=$('choose-probe-status');
      if(!list.length)throw Error('该订阅没有可用节点');
      if(label)label.textContent=`正在查询 ${list.length} 个节点…`;
      try { await call('probeDelays',{ids:list.map(n=>n.id)}); ui.chooseFill?.(); if(label)label.textContent='延迟已更新'; }
      catch(error){ if(label)label.textContent=`查询失败：${error.message}`; }
      break;
    }
    case 'remove-sub': await call('removeSubscription', { id }); break;
    case 'probe': message('正在通过独立测试内核检测出口…'); { const result = await call('probe', { nodeId: id }); message(`实际出口国家：${result.country}。若与锁定国家不同，相关线路已进入手动模式。`); } break;
    case 'preset': if (!state.subscriptions.length) throw Error('请先添加订阅'); openModal(`<h2>主副订阅预设</h2><label for="preset-main">主订阅（日常）</label><select id="preset-main">${state.subscriptions.map(s => option(s.id, s.name)).join('')}</select><label for="preset-secondary">副订阅（独立下载线路）</label><select id="preset-secondary">${state.subscriptions.map(s => option(s.id, s.name, state.subscriptions[1]?.id)).join('')}</select><p class="notice">补充缺失的日常、IDM、qBittorrent 线路；已有编辑保留。已有线路可单独编辑目标订阅。</p>`, () => call('preset', { main: $('preset-main').value, secondary: $('preset-secondary').value })); break;
    case 'reset-scheduling': { clearTimeout(schedulingTimer); ++schedulingVersion; await call('reset-scheduling'); settingsSaveStatus = '调度参数已恢复默认'; break; }
  }
}
$('cancel').onclick=()=>$('editor').close();
$('status').addEventListener('click',retryAttach);
$('status').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();retryAttach();}});
document.addEventListener('toggle',event=>{const sub=event.target.closest?.('details[data-sub]');if(sub)ui.openSub=sub.open?sub.dataset.sub:'';const log=event.target.closest?.('details[data-switch]');if(log)ui.openSwitches=log.open?log.dataset.switch:'';const traffic=event.target.closest?.('details#traffic-details');if(traffic){ui.trafficOpen=traffic.open;if(traffic.open)loadTraffic(ui.traffic.range);}},true);
$('edit-form').onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;try{await modalSubmit();$('editor').close();render();}catch(e){message(e.message,true);}finally{busy=false;}};
document.addEventListener('click',async event=>{
  const preset=event.target.closest('[data-bg-preset]'); if(preset){backgroundDraft.preset=preset.dataset.bgPreset; backgroundDraft.mode='color'; refreshBackgroundControls(); applyBackground(); saveBackground(); return;}
  const bgAction=event.target.closest('[data-action^="background-"]');
  if(bgAction){
    if (busy) return; busy=true; bgAction.disabled=true;
    try {
      let changed = true;
      if(bgAction.dataset.action==='background-pick'){const picked=await call('pick-background'); if(picked){Object.assign(backgroundDraft,{imageId:picked.imageId,imageName:picked.imageName,mode:'image'});} else changed=false;}
      if(bgAction.dataset.action==='background-remove') Object.assign(backgroundDraft,{imageId:'',imageName:''});
      if(bgAction.dataset.action==='background-reset') backgroundDraft={...backgroundDefault};
      refreshBackgroundControls(); applyBackground(); if(changed)saveBackground();
    } catch(e){message(e.message,true);} finally {busy=false;if(bgAction.isConnected)bgAction.disabled=false;}
    return;
  }
  const nav=event.target.closest('[data-page]'); if(nav){if($('application-summary'))ui.summaryOpen=$('application-summary').open;if(nav.dataset.page!==page)updateNotice.leave();page=nav.dataset.page;$('message').hidden=true;render();refreshView();window.scrollTo(0,0);return;}
  const el=event.target.closest('[data-action]');if(!el||busy)return;busy=true;el.disabled=true;
  try{await act(el.dataset.action,el);render();}catch(e){message(e.message,true);}finally{busy=false;if(el.isConnected){el.disabled=false;if(page==='overview'&&!$('editor').open)updateConnections();}}
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.matches('[data-scale]'))scheduleScheduling();
  if(el.name==='background-mode'){backgroundDraft.mode=el.value;applyBackground();saveBackground();}
  if(el.id==='background-opacity'||el.id==='background-blur'){const key=el.id.slice(11);backgroundDraft[key]=Number(el.value);$(`background-${key}-value`).textContent=el.value+(key==='opacity'?'%':' px');applyBackground();scheduleBackgroundSave();}
  if(el.id==='panel-opacity'||el.id==='panel-blur'){const key=el.id==='panel-opacity'?'panelOpacity':'panelBlur';backgroundDraft[key]=Number(el.value);$(`${el.id}-value`).textContent=el.value+(key==='panelOpacity'?'%':' px');applyBackground();scheduleBackgroundSave();}
  if(el.id==='line-depth'||el.id==='panel-shadow'){const key=el.id==='line-depth'?'lineDepth':'shadow';backgroundDraft[key]=Number(el.value);const out=$(el.id+'-value');if(out)out.textContent=el.value+'%';applyBackground();scheduleBackgroundSave();}
  if(el.id==='background-fit'){backgroundDraft.fit=el.value;applyBackground();saveBackground();}
});
document.addEventListener('change',async event=>{const el=event.target;if(el.id==='connection-subscription'){ui.connectionSubscription=el.value;try{await fetchConnections(pager.paused?'snapshot':'live',1);if(page==='overview')updateConnections();}catch(error){message(error.message,true);}return;}if(['background-opacity','background-blur','panel-opacity','panel-blur','line-depth','panel-shadow'].includes(el.id))saveBackground();if(el.matches('[data-scale]'))scheduleScheduling(true);if(el.id==='set-follow')saveDesktopSetting(el);});
async function fetchConnections(mode = pager.paused ? 'snapshot' : 'live', target = pager.page) {
  if (!Number.isInteger(target) || target < 1) return;
  const request = ++connectionRequest, result = await call('connections', { mode, page:target, subscriptionId:ui.connectionSubscription });
  if (request === connectionRequest) pager.update(result);
}
async function refreshView() {
  if (!state || busy || refreshing || !windowVisible || document.hidden) return;
  refreshing = true;
  try {
    const value = await window.assistant.call('summary', { revision:viewRevision, overview:page === 'overview' });
    if (value.state) state = value.state;
    viewRevision = value.revision;
    Object.assign(state, { status:value.status, paused:value.paused });
    if (page === 'overview') {
      for (const key of ['metrics','subscriptionBytes','applicationBytes','errors','alerts','autoChecks']) state[key] = value[key];
      if (!pager.paused) await fetchConnections();
      render();
    } else setStatus();
  } catch(e) { message(e.message,true); }
  finally { refreshing = false; }
}
let refreshTimer;
function visibilityChanged(visible) {
  visibilityRevision++;
  if (typeof visible === 'boolean') windowVisible = visible;
  clearInterval(refreshTimer);
  if (windowVisible && !document.hidden) { refreshView(); refreshTimer = setInterval(refreshView,1000); }
}
async function syncVisibility() { const revision=visibilityRevision, visible=await call('window-visible'); if(revision===visibilityRevision)visibilityChanged(visible); }
document.addEventListener('visibilitychange', () => { if (document.hidden) visibilityChanged(false); else syncVisibility().catch(error => message(error.message,true)); });
window.assistant.onVisibilityChanged(visibilityChanged);
window.assistant.onStateChanged(() => { viewRevision = undefined; refreshView(); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyBackground,250); });
call('view').then(async value => { state=value; backgroundDraft={...backgroundDefault,...state.preferences.background}; applyBackground(); await fetchConnections(); render(); await syncVisibility(); }).catch(e=>message(e.message,true));

const updateNotice = new UpdateNotice({request:()=>call('check-updates'),installRequest:()=>call('update-install'),isSettings:()=>page==='about'});
window.assistant.onUpdateProgress?.(value=>updateNotice.progress(value));
async function backgroundUpdateCheck(){try{const value=await call('check-updates');if(value?.status==='update'){updateNotice.result=value;updateNotice.paint();}}catch{/* A failed background check stays silent; the About page still offers a manual check. */}}
setTimeout(backgroundUpdateCheck,8000);setInterval(backgroundUpdateCheck,6*60*60*1000);
document.addEventListener('click',async event=>{
 const id=event.target.closest('button')?.id;
 if(id==='updates-button'){await updateNotice.check();return;}
 if(id==='update-install-button'){await updateNotice.startUpdate();return;}
 const linkActions={'repository-button':'open-repository','star-button':'open-repository','sponsor-button':'open-repository','issues-button':'open-issues','release-button':'open-release'};
 if(linkActions[id])try{await call(linkActions[id]);}catch(error){message(error.message,true);}
});
for(const [event,kind,value] of [['mouseover','hover',true],['mouseout','hover',false],['focusin','focus',true],['focusout','focus',false]])document.addEventListener(event,e=>{const box=e.target.closest?.('#update-result');if(box&&!box.contains(e.relatedTarget))updateNotice.hold(kind,value);});
document.addEventListener('click',async event=>{const kind=event.target.closest('[data-license]')?.dataset.license;if(!kind)return;try{$('license-text').textContent=await call('license-text',{kind});$('license-title').textContent=kind==='mit'?'MIT 许可证':'第三方声明';$('license-dialog').showModal();}catch(error){message(error.message,true);}});
$('license-close').addEventListener('click',()=>$('license-dialog').close());
