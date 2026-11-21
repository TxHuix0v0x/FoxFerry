'use strict';
const { randomUUID } = require('node:crypto');
const M = require('./model.cjs');
const fields = ['subscriptionId', 'selected', 'countryLock', 'mode', 'candidates', 'countries', 'threshold', 'anyCountry'];
function entry(state, id) { const rule = state.rules.find(r => r.id === id); if (!rule) throw Error('分流不存在'); return rule; }
function independent(state, rule) { return rule.sceneId !== state.defaultSceneId && state.rules.filter(r => r.sceneId === rule.sceneId).length === 1; }
function ownScene(state, rule) {
  const source = state.scenes.find(s => s.id === rule.sceneId);
  if (!source) throw Error('请先设置默认线路');
  if (independent(state, rule)) { if (source.temporary) throw Error('请先恢复临时加速，再编辑线路'); return source; }
  const copy = { ...structuredClone(source), id: randomUUID(), name: rule.name, managedByRuleId: rule.id };
  delete copy.temporary; state.scenes.push(copy); rule.sceneId = copy.id; return copy;
}
function cleanup(state) { state.scenes = state.scenes.filter(s => !s.managedByRuleId || state.rules.some(r => r.sceneId === s.id)); }
function saveEntry(state, value) {
  if (!state.defaultSceneId) throw Error('请先添加订阅并设置默认线路');
  if (value.direct !== undefined && typeof value.direct !== 'boolean') throw Error('直连标记无效');
  let rule = value.id ? entry(state, value.id) : null;
  if (!rule) { rule = { id: randomUUID(), sceneId: state.defaultSceneId }; state.rules.push(rule); }
  for (const key of ['name', 'processes', 'processPaths', 'domains', 'enabled']) rule[key] = key === 'enabled' ? value[key] !== false : value[key] ?? (key === 'name' ? '' : []);
  if (value.direct === true) rule.direct = true; else delete rule.direct;
  // A direct entry keeps its scene reference so switching back restores the previous route settings.
  if (rule.direct === true) { /* DIRECT needs no route */ }
  else if (value.route?.mode === 'default') rule.sceneId = state.defaultSceneId;
  else if (value.route?.mode === 'custom') {
    const scene = ownScene(state, rule); scene.name = rule.name;
    for (const key of fields) if (value.route.settings?.[key] !== undefined) scene[key] = structuredClone(value.route.settings[key]);
  } else throw Error('请选择跟随默认线路或单独设置');
  cleanup(state); return M.validateState(state);
}
function removeEntry(state, id) { entry(state, id); state.rules = state.rules.filter(r => r.id !== id); cleanup(state); return M.validateState(state); }
module.exports = { entry, independent, ownScene, saveEntry, removeEntry, fields };
