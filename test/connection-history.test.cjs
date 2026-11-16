'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConnectionHistory } = require('../src/connection-history.cjs');
const { Scheduler } = require('../src/scheduler.cjs');
const { createDemo } = require('../src/simulation.cjs');
const { nodeName, group } = require('../src/model.cjs');
const { Service } = require('../src/service.cjs');
const { Store } = require('../src/store.cjs');

function fixture() {
  const { state } = createDemo(); let now = 1000, response;
  const core = { connections: async () => response };
  const scheduler = new Scheduler({ state: () => state, core, clock: () => now });
  const scene = state.scenes[1];
  const row = bytes => ({ id: 'download-id', chains: [nodeName(scene.selected), group(scene.id)], download: bytes, metadata: { process: 'IDMan.exe', network: 'tcp', host: 'download.test' } });
  return { state, scene, scheduler, core, row, sample: async (rows, at) => { response = { connections: rows }; now = at; await scheduler.sample(); } };
}

test('completed download retains final observed bytes and labels while active metrics drop to zero', async () => {
  const f = fixture(); await f.sample([f.row(100)], 1000); await f.sample([f.row(500)], 2000);
  const before = f.scheduler.history.rows[0]; assert.equal(before.status, 'active');
  await f.sample(null, 3000); const ended = f.scheduler.history.rows[0];
  assert.deepEqual(ended, { ...before, status: 'ended', endedAt: 3000 });
  assert.equal(ended.bytes, 500); assert.equal(ended.firstSeenAt, 1000); assert.equal(ended.lastSeenAt, 2000);
  assert.equal(ended.subscriptionId, 'download'); assert.ok(ended.node); assert.ok(ended.line);
  assert.equal(f.scheduler.connections.length, 0); assert.equal(f.scheduler.metrics[f.scene.id].connections, 0);
  assert.equal(f.scheduler.metrics[f.scene.id].oldConnections, 0); assert.equal(f.scheduler.subscriptionBytes.download, 400);
  await f.sample([], 4000); assert.equal(f.scheduler.history.rows[0].endedAt, 3000);
  f.state.rules = []; f.state.scenes = []; f.state.subscriptions = [];
  await f.sample([], 5000); assert.deepEqual(f.scheduler.history.rows[0], ended);
});

test('invalid or failed observations keep prior data; removed active exit still retains its observed identity', async () => {
  const f = fixture(); await f.sample([f.row(100)], 1000); const before = f.scheduler.history.rows[0];
  f.core.connections = async () => { throw Error('offline'); };
  await assert.rejects(() => f.scheduler.sample(), /offline/); assert.deepEqual(f.scheduler.history.rows[0], before);
  f.core.connections = async () => ({});
  await assert.rejects(() => f.scheduler.sample(), /采样响应无效/); assert.deepEqual(f.scheduler.history.rows[0], before);
  const raw = f.row(300); f.state.subscriptions = []; f.state.scenes = []; f.state.rules = [];
  f.core.connections = async () => ({ connections: [raw] }); await f.scheduler.sample();
  const retained = f.scheduler.history.rows[0];
  for (const key of ['line', 'subscription', 'node', 'subscriptionId', 'sceneId', 'nodeId']) assert.equal(retained[key], before[key]);
  assert.equal(retained.bytes, 300);
  raw.chains = ['DIRECT']; await f.scheduler.sample();
  assert.equal(f.scheduler.history.rows[0].node, 'DIRECT'); assert.equal(f.scheduler.history.rows[0].subscriptionId, undefined);
});

test('same connection ID updates without duplicates, preserves first observation and can become active again', () => {
  const history = new ConnectionHistory(); const original = { id: 'one', bytes: 5 };
  history.observe([original], 1); original.bytes = 99;
  history.observe([], 2); const frozen = history.rows[0];
  history.observe([{ id: 'one', bytes: 10 }], 3);
  assert.equal(history.rows.length, 1); assert.equal(history.rows[0].firstSeenAt, 1);
  assert.equal(history.rows[0].lastSeenAt, 3); assert.equal(history.rows[0].endedAt, null);
  assert.equal(history.rows[0].status, 'active'); assert.equal(frozen.bytes, 5); assert.equal(frozen.status, 'ended');
});

test('ended records are capped so a long session stays bounded, and active connections are never evicted', () => {
  const history = new ConnectionHistory();
  history.observe([{ id: 'long-lived', subscriptionId: 'main' }], 1);
  for (let i = 0; i < 2500; i++) history.observe([{ id: 'long-lived', subscriptionId: 'main' }, { id: `short-${i}`, subscriptionId: i % 2 ? 'main' : 'backup' }], 10 + i);
  history.observe([{ id: 'long-lived', subscriptionId: 'main' }], 3000);
  assert.equal(history.records.get('long-lived').status, 'active');
  assert.equal(history.records.size, 2001); assert.equal(history.dropped, 500);
  assert.ok(!history.records.has('short-0')); assert.ok(history.records.has('short-2499'));
  const page = history.page();
  assert.equal(page.total, 2001); assert.equal(page.dropped, 500); assert.equal(page.rows[0].id, 'short-2499');
  assert.ok(history.page({ subscriptionId: 'backup' }).total <= 1001);
  const reopened = new ConnectionHistory();
  reopened.observe([{ id: 'x' }], 1); reopened.observe([], 2); assert.equal(reopened.endedCount, 1);
  reopened.observe([{ id: 'x' }], 3); assert.equal(reopened.endedCount, 0);
});

test('session survives pause and scheduler replacement, never persists to disk and clears on exit/restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-history-')); let service;
  try {
    service = await new Service(new Store(dir), { demo: true }).init(); clearInterval(service.timer);
    const f = fixture(); service.core.connections = async () => ({ connections: [f.row(123)] });
    await service.scheduler.sample(); const record = service.view().connections[0];
    await service.command('pause'); assert.deepEqual(service.view().connections, [record]);
    service.makeScheduler(); assert.deepEqual(service.view().connections, [record]);
    service.core.connections = async () => ({ connections: [] }); await service.scheduler.sample();
    assert.equal(service.view().connections[0].status, 'ended');
    await service.store.save(service.state);
    assert.ok(!(await fs.readFile(service.store.file, 'utf8')).includes('download-id'));
    await service.close(); assert.deepEqual(service.view().connections, []);
    service = await new Service(new Store(dir), { demo: true }).init(); clearInterval(service.timer);
    assert.deepEqual(service.view().connections, []); assert.equal(service.view().connectionsUpdatedAt, null);
  } finally { await service?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
