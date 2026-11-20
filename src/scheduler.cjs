'use strict';
const { randomUUID } = require('node:crypto');
const { nodes, candidates, country, group, nodeName } = require('./model.cjs');
const { ConnectionHistory } = require('./connection-history.cjs');
class Scheduler {
  constructor({ state, core, guard, persist, notify = () => {}, clock = Date.now, serialize = work => work(), history = new ConnectionHistory(), logSwitch = () => {}, logAuto = () => {}, traffic = null }) {
    Object.assign(this, { state, core, guard, persist, notify, clock, serialize, history, logSwitch, logAuto, traffic });
    this.reset();
  }
  reset() { this.epoch = randomUUID(); this.previous = new Map(); this.metrics = {}; this.subscriptionBytes = {}; this.applicationBytes = {}; this.memory = new Map(); this.alerts = []; this.connections = []; this.lastSample = null; this.lastDelay = null; this.delays = {}; this.delayRevision = 0; this.autoChecks = []; }
  noteAuto(scene, decision, detail = {}) {
    const entry = { at: this.clock(), sceneId: scene.id, sceneName: scene.name, mode: scene.mode, decision, ...detail };
    this.autoChecks.push(entry);
    if (this.autoChecks.length > 60) this.autoChecks.shift();
    try { this.logAuto?.(entry); } catch { /* Diagnostics must never break scheduling. */ }
  }
  invalidate() { this.epoch = randomUUID(); this.alerts = []; }
  runtime(id) { if (!this.memory.has(id)) this.memory.set(id, { samples: [], high: null, idle: null, alerted: null, switched: null }); return this.memory.get(id); }
  async sample() {
    const state = this.state(); const now = this.clock();
    for (const id of Object.keys(this.metrics)) if (!state.scenes.some(s => s.id === id)) { delete this.metrics[id]; this.memory.delete(id); }
    const data = await this.core.connections(); const elapsed = this.lastSample === null ? null : now - this.lastSample;
    if (!data || !Object.hasOwn(data, 'connections') || (data.connections !== null && !Array.isArray(data.connections))) throw Error('连接采样响应无效，已保留上次记录');
    const next = new Map(); const delta = {};
    // State saves replace arrays; switches only mutate selection, so these lookup keys remain valid.
    if (this.indexSubscriptions !== state.subscriptions || this.indexScenes !== state.scenes || this.indexRules !== state.rules) {
      this.indexSubscriptions = state.subscriptions; this.indexScenes = state.scenes; this.indexRules = state.rules;
      this.nodeIndex = new Map(nodes(state).map((n, i) => [nodeName(n.id), { node: n, order: i }]));
      this.sceneIndex = new Map(state.scenes.map((s, i) => [group(s.id), { scene: s, order: i }]));
      this.subIndex = new Map(state.subscriptions.map(s => [s.id, s.name]));
      this.ruleIndex = new Map();
      for (const r of state.rules) { const refs = this.ruleIndex.get(r.sceneId) || []; refs.push(r); this.ruleIndex.set(r.sceneId, refs); }
    }
    const counts = new Map();
    this.connections = (data.connections || []).map(c => {
      let matchedScene, matchedNode;
      for (const name of c.chains || []) {
        const line = this.sceneIndex.get(name), node = this.nodeIndex.get(name);
        if (line && (!matchedScene || line.order < matchedScene.order)) matchedScene = line;
        if (node && (!matchedNode || node.order < matchedNode.order)) matchedNode = node;
      }
      const scene = matchedScene?.scene, actual = matchedNode?.node;
      const cached = this.history.get(c.id);
      const previousExit = cached?.nodeId && c.chains?.includes(nodeName(cached.nodeId)) ? cached : null;
      const previousLine = cached?.sceneId && c.chains?.includes(group(cached.sceneId)) ? cached : null;
      if (scene) { const count = counts.get(scene.id) || { connections: 0, oldConnections: 0 }; count.connections++; if ((actual?.id || previousExit?.nodeId) !== scene.selected) count.oldConnections++; counts.set(scene.id, count); }
      const subscriptionId = actual?.subscriptionId || previousExit?.subscriptionId;
      const total = Math.max(0, Number(c.download) || 0) + Math.max(0, Number(c.upload) || 0);
      const old = this.previous.get(c.id); const increment = old && total >= old.total ? total - old.total : 0;
      next.set(c.id, { total });
      if (scene) delta[scene.id] = (delta[scene.id] || 0) + increment;
      if (subscriptionId) this.subscriptionBytes[subscriptionId] = (this.subscriptionBytes[subscriptionId] || 0) + increment;
      const app = c.metadata?.process || c.metadata?.processPath?.split(/[\\/]/).at(-1) || '未识别应用';
      this.applicationBytes[app] = (this.applicationBytes[app] || 0) + increment;
      if (increment > 0) this.traffic?.add(now, subscriptionId, increment);
      const refs = this.ruleIndex.get(scene?.id) || [];
      const exit = actual || previousExit ? 'proxy' : c.chains?.includes('DIRECT') ? 'direct' : c.chains?.includes('REJECT') ? 'reject' : 'unknown';
      return { id: c.id, sceneId: scene?.id || previousLine?.sceneId, nodeId: actual?.id || previousExit?.nodeId, subscriptionId, exit, process: app, network: c.metadata?.network || 'unknown', host: c.metadata?.host || '', bytes: total, temporary: !!scene && (actual?.id || previousExit?.nodeId) !== scene.selected,
        line: scene ? scene.id === state.defaultSceneId ? '默认线路' : refs.length === 1 ? refs[0].name : scene.name + (refs.length > 1 ? '（共享旧线路）' : '') : previousLine?.line || '其他 / 直连',
        subscription: actual ? this.subIndex.get(actual.subscriptionId) || '未归属' : previousExit?.subscription || (exit === 'direct' ? '直连' : '未归属'),
        node: actual?.name || previousExit?.node || (exit === 'direct' ? 'DIRECT' : exit === 'reject' ? 'REJECT' : '未归属') };
    });
    this.previous = next; this.lastSample = now;
    this.history.observe(this.connections, now);
    for (const scene of state.scenes) {
      const mem = this.runtime(scene.id);
      if (elapsed > 0) mem.samples.push({ at: now, bytes: delta[scene.id] || 0, duration: elapsed });
      mem.samples = mem.samples.filter(s => now - s.at < state.preferences.averageWindow);
      const duration = mem.samples.reduce((n, s) => n + s.duration, 0);
      const speed = duration > 0 ? mem.samples.reduce((n, s) => n + s.bytes, 0) * 1000 / duration : 0;
      const oldMetric = this.metrics[scene.id];
      this.metrics[scene.id] = { speed, bytes: (oldMetric?.bytes || 0) + (delta[scene.id] || 0), oldConnections: counts.get(scene.id)?.oldConnections || 0, connections: counts.get(scene.id)?.connections || 0 };
      if (scene.threshold && speed > scene.threshold) {
        mem.high ??= now;
        if (now - mem.high >= state.preferences.sustained && (mem.alerted === null || now - mem.alerted >= state.preferences.cooldown)) this.alert(scene, 'speed', '持续速度超过提醒线；这不代表节点已满载');
      } else mem.high = null;
      if (scene.temporary) {
        if (speed < state.preferences.idleRate) mem.idle ??= now; else mem.idle = null;
        if (mem.idle !== null && now - mem.idle >= state.preferences.idleDuration) await this.restore(scene.id);
      }
    }
    this.alerts = this.alerts.filter(a => a.expires > now && a.epoch === this.epoch);
  }
  alert(scene, kind, message, suggested = null) {
    if (this.alerts.some(a => a.sceneId === scene.id && a.kind === kind && a.expires > this.clock())) return;
    const alert = { id: randomUUID(), sceneId: scene.id, kind, message, suggested, epoch: this.epoch, selected: scene.selected, expires: this.clock() + 120000 };
    this.alerts.push(alert); this.runtime(scene.id).alerted = this.clock(); this.notify(alert);
  }
  async probe(ids) {
    const state = this.state(), known = new Set(nodes(state).map(n => n.id));
    const list = [...new Set(Array.isArray(ids) ? ids : [])].filter(id => known.has(id)).slice(0, 200);
    if (!list.length) throw Error('没有可查询的节点');
    const epoch = this.epoch;
    // Manual probes run wider and fail faster than periodic checks so a full subscription answers quickly.
    for (let index = 0; index < list.length; index += 20) {
      if (this.cancelled || epoch !== this.epoch) break;
      await Promise.all(list.slice(index, index + 20).map(async id => { try { const result = await this.core.delay(nodeName(id), undefined, 2500); this.delays[id] = Number.isFinite(result.delay) && result.delay > 0 ? result.delay : Infinity; } catch { this.delays[id] = Infinity; } }));
    }
    this.delayRevision++;
    await this.applyAuto(epoch);
    return Object.fromEntries(list.map(id => [id, Number.isFinite(this.delays[id]) ? this.delays[id] : null]));
  }
  // Shared by the periodic check and manual probes: a manual query applies the same automatic decision.
  async applyAuto(epoch = this.epoch) {
    await this.serialize(async () => {
      if (this.cancelled || epoch !== this.epoch) return;
      const state = this.state(), now = this.clock();
      for (const scene of state.scenes) {
        if (scene.mode !== 'auto') { this.noteAuto(scene, '手动线路，不参与自动检查'); continue; }
        if (scene.temporary) { this.noteAuto(scene, '临时加速中，暂停自动选线'); continue; }
        const pool = candidates(state, scene).filter(n => Number.isFinite(this.delays[n.id]));
        const best = pool.sort((a, b) => this.delays[a.id] - this.delays[b.id])[0];
        const detail = { lock: scene.anyCountry ? '不限国家' : scene.countryLock || '国家未知', candidates: pool.length };
        if (!best) { this.noteAuto(scene, '无可用候选', detail); this.alert(scene, 'unavailable', scene.anyCountry ? '当前订阅没有可用候选（候选节点或允许国家筛选后为空）；保持原路线，可手动选择其他订阅或节点' : '当前订阅及锁定国家没有可用候选；保持原路线，可手动选择其他订阅或国家'); continue; }
        const currentDelay = this.delays[scene.selected] ?? Infinity;
        const mem = this.runtime(scene.id);
        const currentText = Number.isFinite(currentDelay) ? `${currentDelay}ms` : '超时';
        if (best.id === scene.selected) { this.noteAuto(scene, '保持：当前已是最快', { ...detail, current: currentText }); continue; }
        if (currentDelay !== Infinity) {
          if (mem.switched !== null && now - mem.switched < state.preferences.dwell) { this.noteAuto(scene, '等待驻留期', { ...detail, current: currentText, best: `${this.delays[best.id]}ms ${best.name}` }); continue; }
          if (currentDelay - this.delays[best.id] <= state.preferences.tolerance) { this.noteAuto(scene, '保持：差值在容差内', { ...detail, current: currentText, best: `${this.delays[best.id]}ms ${best.name}` }); continue; }
        }
        try {
          await this.switch(scene.id, best.id, { automatic: true });
          this.noteAuto(scene, '已切换', { ...detail, current: currentText, to: best.name, reason: currentDelay === Infinity ? '当前节点超时' : '更快节点' });
        } catch (error) {
          this.noteAuto(scene, '切换失败', { ...detail, error: String(error?.message || error) });
          throw error;
        }
      }
    });
  }
  async checkDelays() {
    const state = this.state(); const now = this.clock();
    const epoch = this.epoch;
    this.lastDelay = now;
    // Limit concurrent probes; latency checks are not bandwidth tests.
    const pending = [...new Set(state.scenes.filter(s => s.mode === 'auto' && !s.temporary).flatMap(s => candidates(state, s).map(n => n.id)))];
    this.noteAuto({ id: 'check', name: '延迟检查', mode: 'auto' }, `开始探测 ${pending.length} 个节点`);
    for (let index = 0; index < pending.length; index += 4) {
      if (this.cancelled || epoch !== this.epoch) return;
      await Promise.all(pending.slice(index, index + 4).map(async id => { try { const result = await this.core.delay(nodeName(id)); this.delays[id] = Number.isFinite(result.delay) && result.delay > 0 ? result.delay : Infinity; } catch { this.delays[id] = Infinity; } }));
    }
    this.delayRevision++;
    const failed = pending.filter(id => this.delays[id] === Infinity).length;
    this.noteAuto({ id: 'check', name: '延迟检查', mode: 'auto' }, `探测完成：${pending.length - failed} 个可用 / ${failed} 个超时`);
    await this.applyAuto(epoch);
  }
  async switch(sceneId, nodeId, { automatic = false, reconnect = false, temporary = false, alertId = null } = {}) {
    const state = this.state(); const scene = state.scenes.find(s => s.id === sceneId); const node = nodes(state).find(n => n.id === nodeId);
    if (!scene || !node) throw Error('线路或节点已不存在');
    if (alertId) this.checkAlert(alertId, sceneId);
    if (automatic && (scene.mode !== 'auto' || scene.temporary || !candidates(state, scene).some(n => n.id === nodeId))) throw Error('自动调度不能越过订阅及国家锁定范围');
    await this.guard();
    const before = structuredClone(scene);
    const previous = scene.selected ? nodeName(scene.selected) : 'REJECT';
    await this.core.select(group(scene.id), nodeName(nodeId));
    try {
      if (temporary && !scene.temporary) scene.temporary = { selected: scene.selected, subscriptionId: scene.subscriptionId, countryLock: scene.countryLock, mode: scene.mode, candidates: [...scene.candidates], countries: [...scene.countries], anyCountry: scene.anyCountry === true };
      if (!temporary && !automatic) delete scene.temporary;
      scene.selected = nodeId; scene.subscriptionId = node.subscriptionId;
      if (!automatic) { scene.mode = 'manual'; scene.countryLock = country(node); delete scene.anyCountry; if (before.subscriptionId !== node.subscriptionId) scene.candidates = []; }
      await this.persist(state);
    } catch (error) {
      Object.assign(scene, before);
      try { await this.core.select(group(scene.id), previous); } catch { throw Error('选择保存失败，内核回退也失败；调度已暂停，请重新核对线路'); }
      throw error;
    }
    this.runtime(sceneId).switched = this.clock(); this.runtime(sceneId).idle = null; this.invalidate();
    this.logSwitch({ at: this.clock(), sceneId, sceneName: scene.name, subscriptionId: node.subscriptionId, fromSubscriptionId: before.subscriptionId || null, from: nodes(state).find(n => n.id === before.selected)?.name || null, to: node.name, reason: automatic ? (scene.anyCountry ? 'auto-any' : 'auto-country') : temporary ? 'temporary' : 'manual' });
    const failed = [];
    if (reconnect) {
      await this.guard();
      const fresh = await this.core.connections();
      for (const c of fresh.connections || []) if (c.chains?.includes(group(sceneId))) {
        await this.guard();
        try { await this.core.close(c.id); } catch { failed.push(c.id); }
      }
    }
    return { failed, warning: reconnect ? '已定向重连，TCP/UDP 均可能中断；应用不一定支持续传' : '仅后续新连接使用新路线；旧连接保留' };
  }
  checkAlert(id, sceneId) {
    const alert = this.alerts.find(a => a.id === id);
    const scene = this.state().scenes.find(s => s.id === sceneId);
    if (!alert || !scene || alert.sceneId !== sceneId || alert.epoch !== this.epoch || alert.expires <= this.clock() || alert.selected !== scene.selected) throw Error('提醒已过期或线路已变化，请重新选择');
    return alert;
  }
  keep(id) { const alert = this.alerts.find(a => a.id === id); if (!alert) throw Error('提醒已过期'); this.checkAlert(id, alert.sceneId); this.alerts = this.alerts.filter(a => a.id !== id); }
  async restore(id) {
    const state = this.state(); const scene = state.scenes.find(s => s.id === id);
    if (!scene?.temporary) throw Error('线路未处于临时加速');
    await this.guard();
    const saved = scene.temporary; const target = nodes(state).find(n => n.id === saved.selected);
    if (!target) { this.alert(scene, 'restore', '原节点已移除，无法恢复；请手动选择，当前临时路线保留'); return; }
    await this.core.select(group(id), nodeName(target.id));
    const before = structuredClone(scene);
    Object.assign(scene, saved); delete scene.temporary;
    try { await this.persist(state); } catch (e) { Object.assign(scene, before); await this.core.select(group(id), nodeName(before.selected)); throw e; }
    this.runtime(id).idle = null; this.invalidate();
    this.logSwitch({ at: this.clock(), sceneId: id, sceneName: scene.name, subscriptionId: target.subscriptionId, fromSubscriptionId: before.subscriptionId || null, from: nodes(state).find(n => n.id === before.selected)?.name || null, to: target.name, reason: 'restore' });
  }
}
module.exports = { Scheduler };
