'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { parseDocument, stringify } = require('yaml');
const path = require('node:path');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const group = id => `AS_${id}`;
const marker = owner => `ASSISTANT_${owner.replaceAll('-', '')}`;
const nodeName = id => `N_${id}`;
const defaults = { delayInterval: 300000, tolerance: 50, dwell: 300000, sampleInterval: 1000, averageWindow: 5000, sustained: 30000, cooldown: 300000, idleRate: 16384, idleDuration: 120000, updateInterval: 86400000 };
const backgroundDefaults = { mode: 'color', preset: 'white', imageId: '', imageName: '', opacity: 25, blur: 0, fit: 'cover', panelOpacity: 100, panelBlur: 0 };
function initialState() {
  return { version: 2, owner: randomUUID(), subscriptions: [], scenes: [], rules: [], preferences: { ...defaults, follow: false, background: { ...backgroundDefaults } }, setup: { ready: false, vergeDir: '', corePath: '' } };
}
function yaml(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) throw Error('配置超过 16MiB 限制');
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw Error('YAML 解析失败，请检查格式');
  const value = doc.toJS({ maxAliasCount: 50 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('仅支持 Mihomo YAML 对象');
  return value;
}
const countryPatterns = [ ['HK', /香港|Hong\s*Kong|\bHK\b|🇭🇰/i], ['TW', /台湾|台灣|Taiwan|\bTW\b|🇹🇼/i], ['JP', /日本|Japan|Tokyo|\bJP\b|🇯🇵/i], ['SG', /新加坡|Singapore|\bSG\b|🇸🇬/i], ['US', /美国|美國|United States|\bUS\b|🇺🇸/i], ['KR', /韩国|韓國|Korea|\bKR\b|🇰🇷/i], ['DE', /德国|Germany|\bDE\b|🇩🇪/i], ['GB', /英国|United Kingdom|\bUK\b|\bGB\b|🇬🇧/i], ['CA', /加拿大|Canada|\bCA\b|🇨🇦/i], ['AU', /澳大利亚|Australia|\bAU\b|🇦🇺/i] ];
function countryFromName(name) { return countryPatterns.find(([, re]) => re.test(name))?.[0] || null; }
function parseNodes(text, subscriptionId) {
  const doc = yaml(text);
  if (!Array.isArray(doc.proxies) || !doc.proxies.length) throw Error('仅支持包含非空 proxies 列表的 Mihomo YAML；不支持 Base64、URI 或仅 proxy-providers 配置');
  const seen = new Set();
  return doc.proxies.map(p => {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.type !== 'string' || typeof p.server !== 'string' || !Number.isInteger(+p.port) || +p.port < 1 || +p.port > 65535) throw Error('节点缺少 name/type/server/port');
    if (seen.has(p.name)) throw Error('同一订阅内的节点名称必须唯一；跨订阅允许同名');
    seen.add(p.name);
    if (['direct', 'reject', 'dns', 'relay', 'selector', 'url-test', 'fallback', 'load-balance'].includes(p.type.toLowerCase())) throw Error('订阅只允许远端代理节点');
    if (p['dialer-proxy']) throw Error('首版不支持带 dialer-proxy 的链式节点');
    const config = structuredClone(p);
    delete config['proxy-name'];
    return { id: hash(`${subscriptionId}\0${p.type}\0${p.name}`), subscriptionId, name: p.name, nameCountry: countryFromName(p.name), detectedCountry: null, config };
  });
}
function nodes(state) { return state.subscriptions.flatMap(s => s.nodes || []); }
function country(node) { return node?.detectedCountry || node?.nameCountry || null; }
function candidates(state, scene, scoped = true) {
  return nodes(state).filter(n => n.subscriptionId === scene.subscriptionId && (!scene.candidates?.length || scene.candidates.includes(n.id)) && (!scene.countries?.length || scene.countries.includes(country(n))) && (!scoped || scene.anyCountry === true || (!!scene.countryLock && country(n) === scene.countryLock)));
}
function safeText(value, title, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0,()]/.test(value)) throw Error(`${title}为空或含不支持字符`);
  return value.trim();
}
function validateState(s, version = 2) {
  if (s?.version !== version || !/^[a-f0-9-]{36}$/.test(s.owner) || !Array.isArray(s.subscriptions) || !Array.isArray(s.scenes) || !Array.isArray(s.rules)) throw Error('不支持的数据版本或结构');
  for (const list of [s.subscriptions, s.scenes, s.rules]) {
    const ids = new Set();
    for (const item of list) { if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) throw Error('ID 无效或重复'); ids.add(item.id); safeText(item.name, '名称'); }
  }
  for (const scene of s.scenes) {
    if (!s.subscriptions.some(x => x.id === scene.subscriptionId)) throw Error('线路引用的订阅不存在');
    if (!['auto', 'manual'].includes(scene.mode) || !Array.isArray(scene.candidates) || !Array.isArray(scene.countries) || scene.countries.some(c => !/^[A-Z]{2}$/.test(c))) throw Error('线路选择范围无效');
    if (scene.countryLock !== null && !/^[A-Z]{2}$/.test(scene.countryLock)) throw Error('锁定国家无效');
    if (scene.anyCountry !== undefined && typeof scene.anyCountry !== 'boolean') throw Error('自动选线范围无效');
    if (scene.threshold !== null && (!Number.isFinite(scene.threshold) || scene.threshold <= 0)) throw Error('速度提醒线必须大于零或留空');
    if (scene.managedByRuleId && (!s.rules.some(r => r.id === scene.managedByRuleId && r.sceneId === scene.id) || s.rules.filter(r => r.sceneId === scene.id).length !== 1 || scene.id === s.defaultSceneId)) throw Error('独立线路归属无效');
  }
  if (s.scenes.length && !s.scenes.some(x => x.id === s.defaultSceneId)) throw Error('必须指定日常线路');
  for (const rule of s.rules) {
    if (!s.scenes.some(x => x.id === rule.sceneId)) throw Error('规则引用的线路不存在');
    const paths = version === 1 ? [] : rule.processPaths ?? [];
    if (!Array.isArray(rule.processes) || !Array.isArray(rule.domains) || !Array.isArray(paths) || (!rule.processes.length && !rule.domains.length && !paths.length)) throw Error('分流至少填写应用或网站');
    for (const file of paths) if (typeof file !== 'string' || file.length > 32767 || !path.win32.isAbsolute(file) || !/\.exe$/i.test(file) || /[\r\n\0]/.test(file)) throw Error('应用请填写完整的 Windows .exe 路径');
    rule.processes.forEach(x => safeText(x, '应用名'));
    for (const domain of rule.domains) if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(domain) || domain.length > 253) throw Error('网站请填写域名，不含协议、路径和通配符');
  }
  for (const [key, value] of Object.entries(defaults)) if (!Number.isFinite(s.preferences[key]) || s.preferences[key] < (['tolerance','idleRate'].includes(key) ? 0 : 1) || s.preferences[key] > 2147483647) throw Error(`设置 ${key} 数值无效`);
  if (s.preferences.sampleInterval < 250 || s.preferences.averageWindow < s.preferences.sampleInterval) throw Error('采样间隔至少 250ms，平均窗口不得短于采样间隔');
  delete s.preferences.pet; delete s.preferences.position;
  const bg = s.preferences.background;
  if (bg !== undefined && (!bg || typeof bg !== 'object' || Array.isArray(bg) || !['color','image'].includes(bg.mode) || !['white','red','orange','yellow','green','cyan','blue','purple','sage','cool','warm'].includes(bg.preset) || typeof bg.imageId !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(bg.imageId) || typeof bg.imageName !== 'string' || bg.imageName.length > 255 || /[\r\n\0]/.test(bg.imageName) || !Number.isInteger(bg.opacity) || bg.opacity < 0 || bg.opacity > 100 || !Number.isInteger(bg.blur) || bg.blur < 0 || bg.blur > 50 || !['cover','contain','stretch','center'].includes(bg.fit))) throw Error('背景设置无效');
  if (bg !== undefined && (!Number.isInteger(bg.panelOpacity) || bg.panelOpacity < 0 || bg.panelOpacity > 100 || !Number.isInteger(bg.panelBlur) || bg.panelBlur < 0 || bg.panelBlur > 50)) throw Error('面板设置无效');
  return s;
}
function upgradeState(value) {
  if (value?.version === 2) { const next = structuredClone(value); const bg = next.preferences.background; if (bg == null || (typeof bg === 'object' && !Array.isArray(bg))) next.preferences.background = { ...backgroundDefaults, ...bg }; return validateState(next); }
  validateState(value, 1);
  const next = structuredClone(value); next.version = 2; next.preferences.background ??= { ...backgroundDefaults };
  next.rules.forEach(r => { r.processPaths = []; });
  next.setup.needsUpgradeConfirmation = true;
  return validateState(next);
}
function pathPattern(file) { return '^' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\(', '\\x28').replaceAll('\\)', '\\x29').replaceAll(',', '\\x2c') + '$'; }
function expression(rule) {
  const combine = (type, values) => values.length === 1 ? `${type},${values[0]}` : `OR,(${values.map(v => `(${type},${v})`).join(',')})`;
  const parts = [];
  const apps = [...rule.processes.map(p => `PROCESS-NAME,${p}`), ...(rule.processPaths || []).map(p => `PROCESS-PATH-REGEX,${pathPattern(p)}`)];
  if (apps.length) parts.push(apps.length === 1 ? apps[0] : `OR,(${apps.map(p => `(${p})`).join(',')})`);
  if (rule.domains.length) parts.push(combine('DOMAIN-SUFFIX', rule.domains.map(x => x.toLowerCase())));
  return parts.length === 1 ? parts[0] : `AND,(${parts.map(x => `(${x})`).join(',')})`;
}
function baseDirectRules(base) {
  return (base.rules || []).filter(r => typeof r === 'string' && /^(IP-CIDR6?|GEOIP|GEOSITE|RULE-SET|DOMAIN(?:-SUFFIX|-KEYWORD)?),[^,]+,DIRECT(?:,no-resolve)?$/i.test(r));
}
function compile(state, base = {}) {
  validateState(state);
  if (!state.scenes.length) throw Error('请先建立日常线路');
  const all = nodes(state);
  const proxies = all.map(n => ({ ...n.config, name: nodeName(n.id) }));
  const groups = state.scenes.map(scene => {
    const current = all.find(n => n.id === scene.selected && n.subscriptionId === scene.subscriptionId);
    const allowed = candidates(state, scene, false);
    const selected = current && (scene.mode === 'manual' || allowed.some(n => n.id === current.id)) ? nodeName(current.id) : 'REJECT';
    return { name: group(scene.id), type: 'select', proxies: [...new Set([selected, 'REJECT', ...all.map(n => nodeName(n.id))])] };
  });
  // Mihomo skips unsupported UDP policies; matching rejects prevent falling through to other subscriptions or DIRECT.
  const rules = [ 'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve', 'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'IP-CIDR6,::1/128,DIRECT,no-resolve', 'IP-CIDR6,fc00::/7,DIRECT,no-resolve', 'IP-CIDR6,fe80::/10,DIRECT,no-resolve', ...baseDirectRules(base), ...state.rules.filter(r => r.enabled !== false).flatMap(r => [`${expression(r)},${group(r.sceneId)}`, `${expression(r)},REJECT`]), `MATCH,${group(state.defaultSceneId)}`, 'MATCH,REJECT' ];
  const directProviders = Object.fromEntries(baseDirectRules(base).filter(r => r.startsWith('RULE-SET,')).map(r => r.split(',')[1]).map(id => { if (!base['rule-providers']?.[id]) throw Error('基础直连规则引用的规则集缺失'); return [id, base['rule-providers'][id]]; }));
  return { 'x-foxferry': { owner: state.owner, version: 1 }, 'find-process-mode': 'always', ...(Object.keys(directProviders).length ? { 'rule-providers': directProviders } : {}), proxies, 'proxy-groups': [{ name: marker(state.owner), type: 'select', hidden: true, proxies: ['REJECT'] }, ...groups], rules: [...new Set(rules)] };
}
function routingFingerprint(config) { return hash(JSON.stringify([config.rules, config['proxy-groups'], config.proxies, config['rule-providers']])); }
function sceneForConnection(state, connection) { return state.scenes.find(s => connection.chains?.includes(group(s.id))) || null; }
function matchRule(rule, processName, host, processPath = '') { return ((!rule.processes.length && !rule.processPaths?.length) || rule.processes.some(p => p.toLowerCase() === processName.toLowerCase()) || rule.processPaths?.some(p => p.toLowerCase() === processPath.toLowerCase())) && (!rule.domains.length || rule.domains.some(d => host.toLowerCase() === d.toLowerCase() || host.toLowerCase().endsWith(`.${d.toLowerCase()}`))); }
module.exports = { initialState, yaml, stringify, parseNodes, nodes, country, candidates, safeText, validateState, upgradeState, pathPattern, expression, compile, group, marker, nodeName, hash, defaults, backgroundDefaults, routingFingerprint, sceneForConnection, matchRule };
