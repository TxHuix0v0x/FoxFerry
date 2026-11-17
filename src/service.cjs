'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const M = require('./model.cjs');
const { ownerOf } = require('./identity.cjs');
const { Core, endpoint, readYaml, validateConfig } = require('./core.cjs');
const { discover, vergeSubscriptions, selectedAssistant, ownedProfile, kernelIdentity } = require('./discovery.cjs');
const { addSubscription, refresh } = require('./subscriptions.cjs');
const { atomicWrite, redact } = require('./store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { ConnectionHistory } = require('./connection-history.cjs');
const R = require('./routing.cjs');
const { version: appVersion } = require('../package.json');
function ruleSignature(config) {
  const types = { 'PROCESS-NAME': 'ProcessName', 'PROCESS-PATH-REGEX': 'ProcessPathRegex', 'DOMAIN-SUFFIX': 'DomainSuffix', 'DOMAIN': 'Domain', 'DOMAIN-KEYWORD': 'DomainKeyword', 'IP-CIDR': 'IPCIDR', 'IP-CIDR6': 'IPCIDR', 'GEOIP': 'GeoIP', 'GEOSITE': 'GeoSite', 'RULE-SET': 'RuleSet', 'MATCH': 'Match' };
  const split = value => { let depth = 0, start = 0; const parts = []; for (let i = 0; i < value.length; i++) { if (value[i] === '(') depth++; else if (value[i] === ')') depth--; else if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; } } parts.push(value.slice(start)); return parts; };
  const payloadFormat = (type, value) => {
    if (['GEOIP', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(type)) return value.toLowerCase();
    if (!['AND', 'OR'].includes(type)) return value;
    const sub = split(value.slice(1, -1)).map(part => { const [t, ...rest] = split(part.slice(1, -1)); return `(${types[t] || t},${payloadFormat(t, rest.join(','))})`; });
    return `(${sub.join(type === 'AND' ? ' && ' : ' || ')})`;
  };
  return config.rules.map(rule => {
    const first = rule.indexOf(','); const type = rule.slice(0, first); const tail = rule.slice(first + 1).replace(/,no-resolve$/, '');
    const last = tail.lastIndexOf(',');
    return { type: types[type] || type, payload: type === 'MATCH' ? '' : payloadFormat(type, tail.slice(0, last)), proxy: type === 'MATCH' ? tail : tail.slice(last + 1) };
  });
}
const signature = rules => JSON.stringify(rules.map(r => ({ type: r.type, payload: r.payload, proxy: r.proxy })));
class Service {
  constructor(store, { notify = () => {}, demo = false } = {}) {
    this.store = store; this.demo = demo; this.notify = notify; this.status = '尚未接入，请完成首次向导'; this.queue = Promise.resolve(); this.paused = true; this.errors = []; this.discovery = null; this.expected = null; this.tickBusy = false;
    this.file = path.join(store.dir, 'assistant-owned.yaml'); this.lastObserve = 0; this.lastRefresh = 0;
    this.connectionHistory = new ConnectionHistory();
  }
  get state() { return this.store.state; }
  serial(work) { const job = this.queue.then(work); this.queue = job.catch(() => {}); return job; }
  async init() {
    await this.store.load();
    if (this.state.setup.needsUpgradeConfirmation) this.status = '数据已升级，原有分流已保留；请在首次接入中重新确认';
    this.journal = path.join(this.store.dir, 'transaction.json');
    try {
      const pending = JSON.parse(await fs.readFile(this.journal, 'utf8'));
      if (pending.previousState?.owner !== this.state.owner) throw Error('事务归属不符，请备份用户数据目录');
      if (pending.id && this.state.setup.lastTransaction === pending.id) {
        await fs.rm(this.journal);
      } else {
      pending.previousState = M.upgradeState(pending.previousState);
      await atomicWrite(this.file, pending.previousFile);
      if (pending.profile) {
        const profileRoot = path.resolve(pending.previousState.setup.vergeDir, 'profiles') + path.sep;
        if (!path.resolve(pending.profile).startsWith(profileRoot)) throw Error('事务配置路径无效');
        const current = await readYaml(pending.profile);
        if (ownerOf(current) === this.state.owner || current['proxy-groups']?.some(g => g.name === M.marker(this.state.owner))) await atomicWrite(pending.profile, pending.previousProfile);
      }
      pending.previousState.setup.ready = false; await this.store.save(pending.previousState);
      await fs.rm(this.journal); this.status = '检测到中断事务，已恢复本地有效配置；请在 Verge 重新启用专用配置后接入';
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (this.demo) {
      const { createDemo } = require('./simulation.cjs');
      const { state, core } = createDemo(this.state.owner); state.preferences = structuredClone(this.state.preferences); await this.store.save(state); this.core = core; this.expected = M.compile(this.state); this.paused = false; this.status = '模拟环境 · 未接入真实 Mihomo'; this.makeScheduler();
    }
    this.scheduleSample();
    return this;
  }
  scheduleSample() {
    if (this.timer && !this.closed && !this.paused && this.core && this.scheduledInterval === this.state.preferences.sampleInterval) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.paused || !this.core) return;
    this.scheduledInterval = this.state.preferences.sampleInterval;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickBusy = true;
      this.serial(() => this.tick()).catch(e => this.fail(e)).finally(() => { this.tickBusy = false; this.scheduleSample(); });
    }, this.state.preferences.sampleInterval);
  }
  makeScheduler() { if (this.scheduler) { this.scheduler.cancelled = true; this.scheduler.invalidate(); } this.scheduler = new Scheduler({ state: () => this.state, core: this.core, guard: () => this.guard(), persist: s => this.persistSelection(s), notify: a => this.notify(a), serialize: work => this.serial(work), history: this.connectionHistory }); }
  async persistSelection(state) {
    if (this.demo) return this.store.save(state);
    const previousState = JSON.parse(await fs.readFile(this.store.file, 'utf8'));
    const old = await fs.readFile(this.file, 'utf8'), profile = await ownedProfile(this.discovery.dir, state.owner);
    if (!profile) throw Error('已切换到其他配置，拒绝保存路线');
    const previousProfile = await fs.readFile(profile, 'utf8'), generated = structuredClone(this.expected);
    for (const scene of state.scenes) {
      const g = generated['proxy-groups'].find(g => g.name === M.group(scene.id));
      const selected = scene.selected ? M.nodeName(scene.selected) : 'REJECT';
      if (!g?.proxies.includes(selected)) throw Error('线路候选已变更，请重新接入');
      g.proxies = [selected, ...g.proxies.filter(n => n !== selected)];
    }
    const next = structuredClone(state), id = randomUUID(); next.setup.lastTransaction = id;
    await atomicWrite(this.journal, JSON.stringify({ id, previousState, previousFile: old, profile, previousProfile }));
    try {
      await atomicWrite(this.file, M.stringify(generated)); await atomicWrite(profile, M.stringify(generated));
      await this.store.save(next); this.expected = generated;
    } catch (e) {
      try { await atomicWrite(this.file, old); await atomicWrite(profile, previousProfile); await this.store.save(previousState); await fs.rm(this.journal); } catch { this.fail(Error('路线持久化回退失败，已暂停；下次启动会尝试恢复本地快照')); }
      throw e;
    }
    try { await fs.rm(this.journal); } catch { this.errors.push({ at: Date.now(), message: '路线已保存，事务标记待重启清理' }); }
  }
  fail(error) { this.paused = true; this.status = redact(error.message || '运行失败'); clearTimeout(this.timer); this.scheduler?.invalidate(); this.errors = [...this.errors.slice(-9), { at: Date.now(), message: this.status }]; }
  async scan() {
    if (this.demo) return { demo: true, dir: '模拟配置', corePath: '模拟内核', running: true, controller: '模拟接口' };
    this.discovery = await discover(this.state.setup);
    const d = this.discovery;
    return { dir: d.dir, corePath: d.corePath, running: !!d.processes.length, controller: d.controller?.socketPath ? /verge-mihomo-(production|development)-/.test(d.controller.socketPath) ? 'Windows 服务命名管道（已验证）' : 'Windows 命名管道（已验证）' : d.controller ? '本机 HTTP（已验证）' : d.controllerError || '未发现' };
  }
  async importVerge() {
    if (this.demo) return;
    if (!this.discovery?.dir) await this.scan();
    if (!this.discovery?.dir) throw Error('未发现 Verge 配置目录，请手动选择');
    const { imported, errors } = await vergeSubscriptions(this.discovery.dir, this.state.owner);
    const next = structuredClone(this.state);
    const found = new Set(imported.map(s => s.id));
    next.subscriptions = next.subscriptions.map(s => s.kind === 'verge' && !found.has(s.id) ? { ...s, nodes: [], error: 'Verge 中已移除或文件不可读' } : s);
    for (const sub of imported) {
      const index = next.subscriptions.findIndex(s => s.id === sub.id);
      if (index < 0) next.subscriptions.push(sub);
      else {
        const old = next.subscriptions[index];
        for (const node of sub.nodes) { const prev = old.nodes.find(n => n.id === node.id && JSON.stringify(n.config) === JSON.stringify(node.config)); if (prev) { node.detectedCountry = prev.detectedCountry; node.detectedAt = prev.detectedAt; } }
        next.subscriptions[index] = sub;
      }
    }
    if (!next.scenes.length && next.subscriptions.length) this.preset(next, next.subscriptions[0].id, next.subscriptions[1]?.id || next.subscriptions[0].id);
    await this.commit(next); return { count: imported.length, errors };
  }
  preset(state, mainId, secondaryId) {
    for (const id of [mainId, secondaryId]) if (!state.subscriptions.some(s => s.id === id)) throw Error('请选择有效主副订阅');
    const scene = (id, name, subscriptionId) => {
      const node = state.subscriptions.find(s => s.id === subscriptionId)?.nodes.find(n => M.country(n));
      return { id, name, subscriptionId, selected: node?.id || null, countryLock: M.country(node), mode: 'auto', candidates: [], countries: [], threshold: null };
    };
    // Existing edited scenes and rules are preserved; presets only fill missing stable IDs.
    const standard = [scene('daily', '日常浏览', mainId), scene('idm', 'IDM 下载', secondaryId), scene('qb', 'qBittorrent 下载', secondaryId)];
    for (const s of standard) if (!state.scenes.some(x => x.id === s.id)) state.scenes.push(s);
    for (const [id, processName] of [['idm', 'IDMan.exe'], ['qb', 'qbittorrent.exe']]) if (!state.rules.some(r => r.id === `preset_${id}`)) state.rules.push({ id: `preset_${id}`, name: state.scenes.find(s => s.id === id).name, processes: [processName], domains: [], sceneId: id, enabled: true });
    state.defaultSceneId ||= 'daily';
  }
  async commit(next) {
    M.validateState(next);
    for (const scene of next.scenes) if (scene.selected && (!M.nodes(next).some(n => n.id === scene.selected && n.subscriptionId === scene.subscriptionId) || (scene.mode === 'auto' && !M.candidates(next, scene, false).some(n => n.id === scene.selected)))) scene.selected = null;
    if (!next.scenes.length) { await this.store.save(next); return; }
    const base = this.demo ? {} : this.discovery?.config || {};
    const generated = M.compile(next, base);
    const changed = !this.expected || M.routingFingerprint(generated) !== M.routingFingerprint(this.expected);
    if (!changed || !this.state.setup.ready || this.demo) {
      await this.store.save(next);
      if (this.demo) { this.expected = generated; this.core.rebuild(next); }
      this.scheduler?.invalidate(); return;
    }
    await this.guard();
    const runtime = await readYaml(path.join(this.discovery.dir, 'clash-verge.yaml'));
    const currentGeneral = await this.core.request('GET', '/configs');
    const merged = this.mergeRuntime(runtime, generated, currentGeneral);
    await validateConfig(next.setup.corePath, merged, this.store.dir, this.discovery.dir);
    await this.guard();
    const old = await fs.readFile(this.file, 'utf8');
    const profile = await ownedProfile(this.discovery.dir, this.state.owner);
    if (!profile) throw Error('专用配置已切换，拒绝更新');
    const previousProfile = await fs.readFile(profile, 'utf8');
    const rollbackRuntime = this.mergeRuntime(runtime, this.expected, currentGeneral);
    const previousState = structuredClone(this.state), transactionId = randomUUID();
    next.setup.lastTransaction = transactionId;
    await atomicWrite(`${this.file}.previous`, old);
    await atomicWrite(this.journal, JSON.stringify({ id: transactionId, previousState, previousFile: old, profile, previousProfile }));
    try {
      await atomicWrite(this.file, M.stringify(generated));
      await atomicWrite(profile, M.stringify(generated));
      await this.guard();
      await this.core.apply(merged);
      await this.verify(generated);
      for (const s of next.scenes) await this.core.select(M.group(s.id), s.selected && M.nodes(next).some(n => n.id === s.selected) ? M.nodeName(s.selected) : 'REJECT');
      await this.store.save(next); this.expected = generated; this.scheduler.invalidate();
    } catch (error) {
      let restored = true;
      try { await atomicWrite(this.file, old); await atomicWrite(profile, previousProfile); if (!await selectedAssistant(this.discovery.dir, this.state.owner)) throw Error('当前配置已切换'); await this.core.apply(rollbackRuntime); for (const s of previousState.scenes) await this.core.select(M.group(s.id), s.selected && M.nodes(previousState).some(n => n.id === s.selected) ? M.nodeName(s.selected) : 'REJECT'); await this.store.save(previousState); await fs.rm(this.journal); } catch { restored = false; }
      this.fail(Error(restored ? '配置应用失败，已恢复上一有效配置；请确认后重新接入' : '配置应用失败且回退未成功，调度已停止；请在 Verge 中启用原订阅'));
      throw Error(this.status);
    }
    try { await fs.rm(this.journal); } catch { this.errors.push({ at: Date.now(), message: '配置已生效，事务标记待清理；重启会识别已提交事务' }); }
  }
  mergeRuntime(runtime, generated, general = {}) {
    const value = { ...runtime, ...generated };
    for (const key of ['port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port', 'allow-lan', 'bind-address', 'ipv6', 'mode', 'log-level']) if (general[key] !== undefined) value[key] = general[key];
    if (general.tun) value.tun = { ...runtime.tun, ...general.tun };
    return value;
  }
  async prepare() {
    if (this.demo) return { file: this.file, demo: true };
    if (!this.discovery) await this.scan();
    if (!this.discovery?.config) throw Error('请先启动 Clash Verge，并发现运行配置');
    const generated = M.compile(this.state, this.discovery.config);
    await validateConfig(this.state.setup.corePath || this.discovery.corePath, this.mergeRuntime(this.discovery.config, generated), this.store.dir, this.discovery.dir);
    try { const previous = M.yaml(await fs.readFile(this.file, 'utf8')); if (ownerOf(previous) !== this.state.owner) throw Error('专用配置归属不符，拒绝覆盖'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await atomicWrite(this.file, M.stringify(generated)); this.expected = generated;
    const next = structuredClone(this.state); next.setup = { ...next.setup, vergeDir: this.discovery.dir, corePath: next.setup.corePath || this.discovery.corePath }; await this.store.save(next);
    return { file: this.file };
  }
  async verify(expected) {
    const [{ proxies }, { rules }, general] = await Promise.all([this.core.proxies(), this.core.rules(), this.core.request('GET', '/configs')]);
    if (general.mode !== 'rule' || !proxies[M.marker(this.state.owner)]) throw Error('当前未启用助手配置或不是规则模式，调度已暂停');
    if (this.state.rules.some(r => r.enabled !== false && (r.processes.length || r.processPaths?.length)) && general['find-process-mode'] === 'off') throw Error('内核进程识别已关闭，应用分流不可用，调度已暂停');
    if (this.verifiedExpected !== expected) { this.verifiedExpected = expected; this.expectedSignature = signature(ruleSignature(expected)); this.expectedGroups = expected['proxy-groups'].map(g => ({ name:g.name, members:new Set(g.proxies), length:g.proxies.length })); }
    if (rules.some(r => r.extra?.disabled) || signature(rules) !== this.expectedSignature) throw Error('运行规则与助手不一致，可能已被扩展覆盖，调度已暂停');
    for (const g of this.expectedGroups) { const all = proxies[g.name]?.all; if (!Array.isArray(all) || all.length !== g.length || new Set(all).size !== g.members.size || all.some(n => !g.members.has(n))) throw Error('运行策略组被修改，调度已暂停'); }
    const capabilities = Object.fromEntries(M.nodes(this.state).map(n => [n.id, proxies[M.nodeName(n.id)]?.udp]));
    if (JSON.stringify(capabilities) !== JSON.stringify(this.capabilities)) this.capabilities = capabilities;
    return proxies;
  }
  async guard({ cached = false } = {}) {
    if (this.demo) return;
    if (this.paused || !this.core || !this.expected) throw Error('调度尚未接入或已暂停');
    await this.checkKernel(false);
    if (!await selectedAssistant(this.discovery.dir, this.state.owner, { cached })) throw Error('Verge 已切换到其他订阅，调度已暂停');
    const proxies = await this.verify(this.expected);
    const nodeIds = new Set(M.nodes(this.state).map(n => n.id));
    for (const s of this.state.scenes) {
      const expected = s.selected && nodeIds.has(s.selected) ? M.nodeName(s.selected) : 'REJECT';
      if (proxies[M.group(s.id)]?.now !== expected) throw Error('线路选择在其他界面发生变化，请重新确认接入');
    }
  }
  async attach() {
    if (this.demo) return;
    await this.scan();
    if (!this.discovery.controller) throw Error(this.discovery.controllerError || '未发现内核控制接口');
    const expected = M.yaml(await fs.readFile(this.file, 'utf8'));
    if (ownerOf(expected) !== this.state.owner) throw Error('专用配置归属不符');
    if (!await selectedAssistant(this.discovery.dir, this.state.owner, this.file)) throw Error('请先在 Verge 中导入并启用专用本地配置');
    this.core = new Core(this.discovery.controller); this.expected = expected; this.kernelStamp = await kernelIdentity(); this.kernelChecked = Date.now();
    await this.verify(expected);
    // First attach adopts only nodes already selected inside the explicitly activated assistant profile.
    const { proxies } = await this.core.proxies(); const next = structuredClone(this.state);
    for (const s of next.scenes) { const active = M.nodes(next).find(n => M.nodeName(n.id) === proxies[M.group(s.id)]?.now); if (active) { s.selected = active.id; s.subscriptionId = active.subscriptionId; s.countryLock = M.country(active); } else s.selected = null; }
    next.setup.ready = true; delete next.setup.needsUpgradeConfirmation; await this.store.save(next); this.makeScheduler(); this.paused = false; this.status = '调度运行中';
  }
  async checkKernel(force) {
    if (this.demo || (this.kernelChecked && !force && Date.now() - this.kernelChecked < 10000)) return;
    const stamp = await kernelIdentity(force); this.kernelChecked = Date.now();
    if (this.kernelStamp !== undefined && stamp !== this.kernelStamp) { this.scheduler?.invalidate(); this.fail(Error('检测到内核重启，旧提醒已失效；请重新确认接入')); throw Error(this.status); }
    this.kernelStamp = stamp;
  }
  async tick() {
    if (!this.core || this.paused) return;
    const now = Date.now();
    await this.guard({ cached: true });
    await this.scheduler.sample();
    if (!this.delayJob && (this.scheduler.lastDelay === null || now - this.scheduler.lastDelay >= this.state.preferences.delayInterval)) {
      this.delayJob = this.scheduler.checkDelays().catch(e => this.fail(e)).finally(() => { this.delayJob = null; });
    }
    if (!this.demo && now - this.lastObserve >= 30000) {
      this.lastObserve = now;
      try {
        await this.scan(); const before = JSON.stringify(this.state.subscriptions); const draft = structuredClone(this.state); const { imported } = await vergeSubscriptions(this.discovery.dir, this.state.owner); for (const sub of draft.subscriptions.filter(s => s.kind === 'verge')) { const fresh = imported.find(s => s.id === sub.id); if (!fresh) sub.nodes = []; else { sub.nodes = fresh.nodes; sub.metadata = fresh.metadata; } } if (JSON.stringify(draft.subscriptions) !== before) await this.commit(draft);
      } catch (error) {
        // A transient process/PowerShell failure in the observation step must not pause routing.
        this.errors = [...this.errors.slice(-9), { at: now, message: `进程与配置发现失败，保持上次结果：${redact(error.message)}` }];
      }
    }
    if (!this.demo && now - this.lastRefresh >= 60000) { this.lastRefresh = now; for (const sub of this.state.subscriptions.filter(s => s.kind !== 'verge' && now - s.updatedAt >= this.state.preferences.updateInterval)) { try { const next = structuredClone(this.state); next.subscriptions[next.subscriptions.findIndex(s => s.id === sub.id)] = await refresh(sub); await this.commit(next); } catch { this.errors = [...this.errors.slice(-9), { at: now, message: `订阅 ${sub.name} 更新失败，保留缓存节点` }]; } } }
  }
  view({ history = true } = {}) {
    const state = { ...this.state };
    state.subscriptions = state.subscriptions.map(s => ({ id: s.id, name: s.name, kind: s.kind, updatedAt: s.updatedAt, error: s.error, metadata: s.metadata, nodes: s.nodes.map(n => ({ id: n.id, name: n.name, subscriptionId: n.subscriptionId, udp: this.capabilities?.[n.id], country: M.country(n), countrySource: n.detectedCountry ? '出口检测' : n.nameCountry ? '名称标注' : '未知', delay: Number.isFinite(this.scheduler?.delays[n.id]) ? this.scheduler.delays[n.id] : null, delayFailed: this.scheduler?.delays[n.id] === Infinity })) }));
    return { ...state, appVersion, demo: this.demo, paused: this.paused, status: this.status, errors: this.errors, metrics: this.scheduler?.metrics || {}, subscriptionBytes: this.scheduler?.subscriptionBytes || {}, applicationBytes: this.scheduler?.applicationBytes || {}, ...(history ? { connections: this.connectionHistory.rows } : {}), connectionsUpdatedAt: this.connectionHistory.sampledAt, alerts: this.scheduler?.alerts.filter(a => a.expires > Date.now()) || [], configFile: this.file };
  }
  summary({ revision, overview = true } = {}) {
    const changed = this.viewState !== this.state || this.viewDelays !== this.scheduler?.delayRevision || this.viewCapabilities !== this.capabilities;
    if (changed) { this.viewState = this.state; this.viewDelays = this.scheduler?.delayRevision; this.viewCapabilities = this.capabilities; this.viewRevision = (this.viewRevision || 0) + 1; }
    const result = { revision: this.viewRevision, paused: this.paused, status: this.status };
    if (revision !== this.viewRevision) result.state = this.view({ history: false });
    if (overview) Object.assign(result, { metrics: this.scheduler?.metrics || {}, subscriptionBytes: this.scheduler?.subscriptionBytes || {}, applicationBytes: this.scheduler?.applicationBytes || {}, errors: this.errors, alerts: this.scheduler?.alerts.filter(a => a.expires > Date.now()) || [] });
    return result;
  }
  async command(action, value = {}) {
    if (action === 'view') return this.view({ history: false });
    if (action === 'summary') return this.summary(value);
    if (action === 'connections') return this.connectionHistory.page(value);
    // Manual latency probes are user-triggered and can take a while; keep them out of the serial queue.
    if (action === 'probeDelays') {
      try {
        if (this.paused || !this.core || !this.scheduler) throw Error('请先接入调度，再查询节点延迟');
        if (this.probing) throw Error('正在查询节点延迟，请稍候');
        this.probing = true;
        return { result: await this.scheduler.probe(value?.ids), state: this.view({ history: false }) };
      } catch (e) { throw Error(redact(e.message)); } finally { this.probing = false; }
    }
    return this.serial(async () => {
      try {
        let result;
        switch (action) {
          case 'scan': result = await this.scan(); break;
          case 'paths': { const next = structuredClone(this.state); if (value.vergeDir) next.setup.vergeDir = value.vergeDir; if (value.corePath) next.setup.corePath = value.corePath; await this.store.save(next); result = await this.scan(); break; }
          case 'import': result = await this.importVerge(); break;
          case 'addSubscription': { if (this.demo) throw Error('模拟模式请使用内置订阅'); const next = structuredClone(this.state); next.subscriptions.push(await addSubscription(value)); if (!next.scenes.length) this.preset(next, next.subscriptions[0].id, next.subscriptions[0].id); await this.commit(next); break; }
          case 'refresh': { if (this.demo) break; const next = structuredClone(this.state); const index = next.subscriptions.findIndex(s => s.id === value.id); if (index < 0) throw Error('订阅不存在'); if (next.subscriptions[index].kind === 'verge') result = await this.importVerge(); else { next.subscriptions[index] = await refresh(next.subscriptions[index]); await this.commit(next); } break; }
          case 'removeSubscription': { const next = structuredClone(this.state); if (next.scenes.some(s => s.subscriptionId === value.id || s.temporary?.subscriptionId === value.id)) throw Error('请先修改引用此订阅的线路'); next.subscriptions = next.subscriptions.filter(s => s.id !== value.id); await this.commit(next); break; }
          case 'preset': { const next = structuredClone(this.state); this.preset(next, value.main, value.secondary); await this.commit(next); break; }
          case 'policy': { const next = structuredClone(this.state); next.scenes = value.scenes; next.rules = value.rules; next.defaultSceneId = value.defaultSceneId; await this.commit(next); break; }
          case 'saveRoutingEntry': await this.commit(R.saveEntry(structuredClone(this.state), value)); break;
          case 'removeRoutingEntry': await this.commit(R.removeEntry(structuredClone(this.state), value.id)); break;
          case 'switchRoutingEntry': result = await this.switchEntry(value); break;
          case 'preferences': { const next = structuredClone(this.state); for (const key of [...Object.keys(M.defaults), 'follow', 'background']) if (value[key] !== undefined) next.preferences[key] = value[key]; await this.store.save(next); break; }
          case 'reset-scheduling': { const next = structuredClone(this.state); Object.assign(next.preferences, M.defaults); await this.store.save(next); break; }
          case 'prepare': result = await this.prepare(); break;
          case 'attach': await this.attach(); break;
          case 'pause': this.paused = true; this.status = '用户已暂停调度'; this.scheduler?.invalidate(); break;
          case 'switch': if (this.paused) throw Error('请先接入调度'); await this.checkKernel(true); result = await this.scheduler.switch(value.sceneId, value.nodeId, value); break;
          case 'restore': if (this.paused) throw Error('请先接入调度'); await this.scheduler.restore(value.sceneId); break;
          case 'auto': { if (this.paused) throw Error('请先接入调度'); await this.guard(); const next = structuredClone(this.state); const s = next.scenes.find(s => s.id === value.sceneId); if (!s || s.temporary) throw Error('请先结束临时加速'); s.mode = 'auto'; if (value.anyCountry) s.anyCountry = true; else { delete s.anyCountry; if (value.country) s.countryLock = value.country; else if (!s.countryLock) s.countryLock = M.country(M.nodes(next).find(n => n.id === s.selected)); } await this.store.save(next); this.scheduler.invalidate(); this.scheduler.lastDelay = null; break; }
          case 'keep': this.scheduler.keep(value.id); break;
          case 'probe': result = await this.probe(value.nodeId); break;
          default: throw Error('不支持的操作');
        }
        if (!this.tickBusy) this.scheduleSample();
        return { result, state: this.view({ history: false }) };
      } catch (e) { throw Error(redact(e.message)); }
    });
  }
  async switchEntry(value) {
    if (this.paused) throw Error('请先接入调度');
    await this.checkKernel(true); await this.guard();
    const rule = R.entry(this.state, value.id), operation = value.operation || 'manual';
    if (!['manual', 'auto', 'restore'].includes(operation)) throw Error('不支持的线路操作');
    if (R.independent(this.state, rule)) {
      if (operation === 'manual') return this.scheduler.switch(rule.sceneId, value.nodeId, value);
      if (operation === 'restore') return this.scheduler.restore(rule.sceneId);
      const next = structuredClone(this.state), scene = next.scenes.find(s => s.id === rule.sceneId);
      if (scene.temporary) throw Error('请先恢复临时加速');
      scene.mode = 'auto'; if (value.anyCountry) scene.anyCountry = true; else { delete scene.anyCountry; if (value.country) scene.countryLock = value.country; }
      await this.store.save(next); this.scheduler.invalidate(); this.scheduler.lastDelay = null; return;
    }
    if (operation === 'restore') throw Error('本条分流尚未设置独立临时线路');
    const previous = structuredClone(this.state), next = structuredClone(this.state);
    const scene = R.ownScene(next, R.entry(next, rule.id));
    let connections = [];
    if (value.alertId) this.scheduler.checkAlert(value.alertId, rule.sceneId);
    if (operation === 'manual') {
      const node = M.nodes(next).find(n => n.id === value.nodeId); if (!node) throw Error('节点已不存在');
      if (value.temporary) scene.temporary = Object.fromEntries(R.fields.filter(k => k !== 'threshold').map(k => [k, structuredClone(scene[k])]));
      if (scene.subscriptionId !== node.subscriptionId) scene.candidates = [];
      Object.assign(scene, { selected: node.id, subscriptionId: node.subscriptionId, countryLock: M.country(node), mode: 'manual' });
      if (value.reconnect) connections = (await this.core.connections()).connections || [];
    } else { scene.mode = 'auto'; if (value.anyCountry) scene.anyCountry = true; else { delete scene.anyCountry; if (value.country) scene.countryLock = value.country; } }
    await this.commit(next);
    const failed = [];
    if (value.reconnect) {
      const belongs = c => c.chains?.includes(M.group(rule.sceneId)) && previous.rules.find(r => r.enabled !== false && M.matchRule(r, c.metadata?.process || '', c.metadata?.host || '', c.metadata?.processPath || ''))?.id === rule.id;
      const ids = new Set(connections.filter(belongs).map(c => c.id));
      for (const c of (await this.core.connections()).connections || []) if (ids.has(c.id) && belongs(c)) { await this.guard(); try { await this.core.close(c.id); } catch { failed.push(c.id); } }
    }
    return { failed, warning: value.reconnect ? '仅定向重连本条分流；无法识别归属的旧连接保留' : '已为本条建立独立线路，仅后续新连接使用；旧连接保留' };
  }
  async probe(nodeId) {
    if (this.demo) return { country: 'JP', source: '模拟出口检测' };
    const node = M.nodes(this.state).find(n => n.id === nodeId);
    if (!node) throw Error('节点不存在');
    const { probeCountry } = require('./probe.cjs');
    const detected = await probeCountry(node, this.state.setup.corePath, this.store.dir);
    const next = structuredClone(this.state); const n = M.nodes(next).find(n => n.id === nodeId); n.detectedCountry = detected; n.detectedAt = Date.now();
    // Country changes invalidate same-country scheduling until the user confirms the lock again.
    for (const s of next.scenes) if (s.selected === nodeId && s.countryLock !== detected) s.mode = 'manual';
    await this.store.save(next); this.scheduler?.invalidate(); return { country: detected };
  }
  async close() { this.closed = true; clearTimeout(this.timer); if (this.scheduler) this.scheduler.cancelled = true; await this.delayJob; await this.queue; await this.store.queue; this.connectionHistory.clear(); }
}
module.exports = { Service, ruleSignature, signature };
