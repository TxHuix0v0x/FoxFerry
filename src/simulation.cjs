'use strict';
const { initialState, parseNodes, stringify, compile, group, nodeName, marker } = require('./model.cjs');
function createDemo(owner) {
  const state = initialState(); state.owner = owner || state.owner; state.setup.ready = true;
  state.subscriptions = ['main', 'download', 'backup'].map((id, i) => ({ id, name: ['主订阅 · 日常', '副订阅 · 下载', '备用订阅'][i], kind: 'file', updatedAt: Date.now(), nodes: parseNodes(stringify({ proxies: ['日本 01', '日本 02', '香港 01', '未知节点'].map((name, j) => ({ name, type: 'socks5', server: '127.0.0.1', port: 31000 + i * 10 + j, udp: true })) }), id) }));
  state.scenes = [['daily', '日常浏览', 'main'], ['idm', 'IDM 下载', 'download'], ['qb', 'qBittorrent 下载', 'download']].map(([id, name, subscriptionId]) => ({ id, name, subscriptionId, selected: state.subscriptions.find(s => s.id === subscriptionId).nodes[0].id, countryLock: 'JP', mode: 'auto', candidates: [], countries: [], threshold: id === 'idm' ? 2000000 : null }));
  state.defaultSceneId = 'daily';
  state.rules = [['chrome', 'Chrome 指定网站', ['chrome.exe'], ['example.com'], 'daily'], ['edge', 'Edge 指定网站', ['msedge.exe'], ['example.org'], 'daily'], ['idm', 'IDM 独立下载', ['IDMan.exe'], [], 'idm'], ['qb', 'qBittorrent 独立下载', ['qbittorrent.exe'], [], 'qb']].map(([id, name, processes, domains, sceneId]) => ({ id, name, processes, domains, sceneId, enabled: true }));
  let current = structuredClone(state), selections = {}, removed = new Set(), total = 0;
  const core = {
    rebuild(next) { current = structuredClone(next); for (const s of current.scenes) selections[group(s.id)] = s.selected ? nodeName(s.selected) : 'REJECT'; },
    async proxies() { return { proxies: Object.fromEntries(compile(current)['proxy-groups'].map(g => [g.name, { type: 'Selector', all: g.proxies, now: selections[g.name] || g.proxies[0] }])) }; },
    async connections() {
      total += 700000;
      return { downloadTotal: total * 3, uploadTotal: 0, connections: current.scenes.filter(s => !removed.has(s.id)).map((s, i) => ({ id: s.id, chains: [selections[group(s.id)], group(s.id)], download: total * [1, 5, 2][i % 3], upload: 0, metadata: { process: ['chrome.exe', 'IDMan.exe', 'qbittorrent.exe'][i % 3], host: 'example.com', network: i === 2 ? 'udp' : 'tcp' } })) };
    },
    async select(g, name) { selections[g] = name; },
    async delay(name) { return { delay: name.endsWith(current.subscriptions[0].nodes[1].id) ? 34 : 82 }; },
    async close(id) { removed.add(id); },
    async request(method, route) { if (route === '/configs') return { mode: 'rule' }; if (route === '/version') return { version: 'simulation', meta: true }; return {}; },
    async apply() {},
  };
  core.rebuild(state);
  return { state, core };
}
module.exports = { createDemo };
