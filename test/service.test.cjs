'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Service, ruleSignature } = require('../src/service.cjs');
const { Store, atomicWrite } = require('../src/store.cjs');
const { createDemo } = require('../src/simulation.cjs');
const M = require('../src/model.cjs');
const { selectedAssistant, vergeSubscriptions } = require('../src/discovery.cjs');
test('nested AND/OR rule signatures follow actual Mihomo normalized API shape', () => {
  const rules = ['AND,((OR,((PROCESS-NAME,chrome.exe),(PROCESS-NAME,msedge.exe))),(OR,((DOMAIN-SUFFIX,a.test),(DOMAIN-SUFFIX,b.test)))),AS_daily'];
  assert.deepEqual(ruleSignature({ rules }), [{ type: 'AND', payload: '((OR,((ProcessName,chrome.exe) || (ProcessName,msedge.exe))) && (OR,((DomainSuffix,a.test) || (DomainSuffix,b.test))))', proxy: 'AS_daily' }]);
});
test('source discovery excludes owned profile and scripts, prevents traversal, retains three subscriptions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-source-'));
  try {
    await fs.mkdir(path.join(dir, 'profiles')); const { state } = createDemo(); const items = [];
    for (const s of state.subscriptions) { await fs.writeFile(path.join(dir, 'profiles', `${s.id}.yaml`), M.stringify({ proxies: s.nodes.map(n => n.config) })); items.push({ uid: s.id, name: s.name, type: 'remote', file: `${s.id}.yaml`, url: 'https://secret.example/?token=private' }); }
    await fs.writeFile(path.join(dir, 'profiles/owned.yaml'), M.stringify(M.compile(state))); items.push({ uid: 'owned', name: 'Assistant', type: 'local', file: 'owned.yaml' }); items.push({ uid: 'escape', name: 'bad', type: 'local', file: '../../bad.yaml' }); items.push({ uid: 'script', name: 'script', type: 'script', file: 'a.js' });
    await fs.writeFile(path.join(dir, 'profiles.yaml'), M.stringify({ current: 'owned', items }));
    const result = await vergeSubscriptions(dir, state.owner); assert.equal(result.imported.length, 3); assert.equal(result.errors.length, 1); assert.ok(!JSON.stringify(result.imported).includes('private')); assert.ok(await selectedAssistant(dir, state.owner));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('restart recovers interrupted transaction locally and requires explicit reattach', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-recover-')); let service;
  try {
    const store = new Store(dir); await store.load(); const { state } = createDemo(store.state.owner); state.setup.vergeDir = path.join(dir, 'verge');
    const profile = path.join(state.setup.vergeDir, 'profiles/owned.yaml'); const old = M.stringify(M.compile(state)); await store.save(state); await atomicWrite(profile, old); await atomicWrite(path.join(dir, 'assistant-owned.yaml'), 'interrupted');
    await atomicWrite(path.join(dir, 'transaction.json'), JSON.stringify({ previousState: state, previousFile: old, profile, previousProfile: old }));
    service = await new Service(store).init(); clearInterval(service.timer);
    assert.ok(service.paused); assert.ok(!store.state.setup.ready); assert.equal(await fs.readFile(service.file, 'utf8'), old); assert.equal(await fs.readFile(profile, 'utf8'), old); await assert.rejects(() => fs.access(path.join(dir, 'transaction.json')));
  } finally { await service?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('renderer view contains no credential config, file paths or source URL', async () => {
  const { state } = createDemo(); state.subscriptions[0].nodes[0].config.password = 'private-password'; state.subscriptions[0].url = 'https://private.example/?token=private-token'; state.subscriptions[0].file = 'secret-file';
  const view = new Service({ state, dir: '/fixture' }).view(); const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('private-password')); assert.ok(!serialized.includes('private-token')); assert.ok(!serialized.includes('secret-file'));
});
test('committed transaction with delayed journal cleanup is retained on restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-committed-')); let service;
  try {
    const store = new Store(dir); await store.load(); const { state } = createDemo(store.state.owner); const previousState = structuredClone(state); state.setup.lastTransaction = 'committed-1'; await store.save(state);
    await atomicWrite(path.join(dir, 'assistant-owned.yaml'), 'committed config');
    await atomicWrite(path.join(dir, 'transaction.json'), JSON.stringify({ id: 'committed-1', previousState, previousFile: 'old config' }));
    service = await new Service(store).init(); clearInterval(service.timer);
    assert.equal(await fs.readFile(service.file, 'utf8'), 'committed config'); assert.equal(store.state.setup.lastTransaction, 'committed-1'); assert.ok(store.state.setup.ready);
  } finally { await service?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('auto lowest latency clears the country scope and probe results reach the view', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-probe-')); let service;
  try {
    service = await new Service(new Store(dir), { demo: true }).init(); clearInterval(service.timer);
    const scene = service.state.scenes[0]; scene.mode = 'manual'; scene.countryLock = 'JP'; scene.countries = ['JP']; scene.candidates = [scene.selected];
    await service.store.save(service.state);
    await service.command('auto', { sceneId: scene.id, anyCountry: true });
    const next = service.state.scenes.find(s => s.id === scene.id);
    assert.equal(next.mode, 'auto'); assert.equal(next.anyCountry, true); assert.deepEqual(next.countries, ['JP']); assert.deepEqual(next.candidates, [scene.selected]);
    await service.command('auto', { sceneId: scene.id, country: 'US' });
    const scoped = service.state.scenes.find(s => s.id === scene.id);
    assert.equal(scoped.countryLock, 'US'); assert.equal('anyCountry' in scoped, false);
    const ids = service.state.subscriptions[0].nodes.map(n => n.id);
    const probed = await service.command('probeDelays', { ids });
    assert.ok(Object.values(probed.result).every(v => typeof v === 'number' && v > 0));
    assert.ok(probed.state.subscriptions[0].nodes[0].delay > 0); assert.equal(probed.state.subscriptions[0].nodes[0].delayFailed, false);
    service.core.delay = async () => { throw Error('timeout'); };
    const failed = await service.command('probeDelays', { ids });
    assert.equal(failed.state.subscriptions[0].nodes[0].delay, null); assert.equal(failed.state.subscriptions[0].nodes[0].delayFailed, true);
    await service.command('pause');
    await assert.rejects(() => service.command('probeDelays', { ids }), /请先接入调度/);
  } finally { await service?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
