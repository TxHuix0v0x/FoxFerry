'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler } = require('../src/scheduler.cjs');
const { createDemo } = require('../src/simulation.cjs');
const { nodeName, group } = require('../src/model.cjs');
function fixture() {
  const { state } = createDemo(); let now = 0; const writes = [], closed = [], log = [], events = []; let conns = [];
  const core = { select: async (g, n) => writes.push([g, n]), delay: async name => ({ delay: name === nodeName(state.subscriptions[0].nodes[1].id) ? 10 : 100 }), connections: async () => ({ connections: conns }), close: async id => closed.push(id) };
  const scheduler = new Scheduler({ state: () => state, core, guard: async () => {}, persist: async () => {}, clock: () => now, logSwitch: entry => log.push(entry), logAuto: entry => events.push(entry) });
  return { state, scheduler, core, writes, closed, log, events, time: v => { now = v; }, connections: v => { conns = v; } };
}
test('node switches are recorded with a reason for manual, automatic and temporary routes', async () => {
  const f = fixture(); const scene = f.state.scenes[0];
  await f.scheduler.checkDelays();
  assert.equal(f.log.length, 1); assert.equal(f.log[0].reason, 'auto-country'); assert.ok(f.log[0].to); assert.equal(f.log[0].sceneName, scene.name);
  await f.scheduler.switch(scene.id, f.state.subscriptions[0].nodes[3].id);
  assert.equal(f.log.at(-1).reason, 'manual'); assert.equal(f.log.at(-1).to, f.state.subscriptions[0].nodes[3].name);
  const s = f.state.scenes[1];
  await f.scheduler.switch(s.id, f.state.subscriptions[2].nodes[0].id, { temporary: true });
  await f.scheduler.restore(s.id);
  assert.deepEqual(f.log.slice(-2).map(x => x.reason), ['temporary', 'restore']);
  assert.equal(f.log.at(-1).from, f.state.subscriptions[2].nodes[0].name);
});
test('automatic scheduling stays in subscription + country, respects manual lock, tolerance and dwell', async () => {
  const f = fixture(); const scene = f.state.scenes[0];
  await f.scheduler.checkDelays(); assert.equal(scene.selected, f.state.subscriptions[0].nodes[1].id);
  assert.equal(f.writes.length, 1);
  f.core.delay = async name => ({ delay: name === nodeName(f.state.subscriptions[0].nodes[0].id) ? 1 : 100 });
  f.time(200); await f.scheduler.checkDelays(); assert.equal(f.writes.length, 1);
  f.time(300001); await f.scheduler.checkDelays(); assert.equal(f.writes.length, 2);
  await f.scheduler.switch(scene.id, f.state.subscriptions[0].nodes[3].id); assert.equal(scene.mode, 'manual'); assert.equal(scene.countryLock, null);
  f.time(900000); await f.scheduler.checkDelays(); assert.equal(f.writes.length, 3);
});
test('a clearly faster node overrides the dwell window while a marginal gap keeps waiting', async () => {
  const f = fixture(); const scene = f.state.scenes[0];
  await f.scheduler.checkDelays();
  assert.equal(scene.selected, f.state.subscriptions[0].nodes[1].id);
  f.core.delay = async name => ({ delay: name === nodeName(f.state.subscriptions[0].nodes[0].id) ? 1 : 400 });
  f.time(1000); await f.scheduler.checkDelays();
  assert.equal(scene.selected, f.state.subscriptions[0].nodes[0].id);
  assert.ok(f.events.some(e => e.reason === '明显更快（跳过驻留）'));
});
test('unknown countries never auto switch; missing range alerts do not cross subscription', async () => {
  const f = fixture(); const scene = f.state.scenes[0]; scene.countryLock = null;
  await f.scheduler.checkDelays(); assert.equal(f.writes.length, 0); assert.equal(f.scheduler.alerts[0].kind, 'unavailable');
  await assert.rejects(() => f.scheduler.switch(scene.id, f.state.subscriptions[1].nodes[0].id, { automatic: true }));
});
test('any-country auto probes the whole subscription instead of alerting on a null lock', async () => {
  const f = fixture(); const scene = f.state.scenes[0]; scene.countryLock = null; scene.anyCountry = true;
  await f.scheduler.checkDelays();
  assert.equal(f.scheduler.alerts.length, 0); assert.equal(f.writes.length, 1);
  assert.equal(scene.selected, f.state.subscriptions[0].nodes[1].id);
  assert.equal('anyCountry' in scene, true);
  await f.scheduler.switch(scene.id, f.state.subscriptions[0].nodes[2].id);
  assert.equal('anyCountry' in scene, false); assert.equal(scene.mode, 'manual');
});
test('targeted reconnect closes only selected scene including TCP/UDP; restore keeps old connections', async () => {
  const f = fixture(); const scene = f.state.scenes[1]; const original = scene.selected;
  f.connections([{ id: 'tcp-idm', chains: [group(scene.id)], metadata: { network: 'tcp' } }, { id: 'udp-idm', chains: [group(scene.id)], metadata: { network: 'udp' } }, { id: 'qb', chains: [group('qb')] }]);
  await f.scheduler.switch(scene.id, f.state.subscriptions[2].nodes[0].id, { temporary: true, reconnect: true });
  assert.deepEqual(f.closed, ['tcp-idm', 'udp-idm']); assert.equal(f.state.scenes[0].subscriptionId, 'main');
  await f.scheduler.restore(scene.id); assert.equal(scene.selected, original); assert.equal(scene.subscriptionId, 'download'); assert.equal(scene.temporary, undefined); assert.equal(f.closed.length, 2);
});
test('speed uses per-connection deltas and actual exit; thresholds alert, no response never switches; idle restores', async () => {
  const f = fixture(); f.state.preferences.sustained = 2000; f.state.preferences.idleDuration = 2000;
  const s = f.state.scenes[1]; s.threshold = 100;
  const connection = bytes => [{ id: 'a', download: bytes, upload: 0, chains: [nodeName(s.selected), group(s.id)], metadata: { process: 'IDMan.exe' } }];
  f.connections(connection(1000)); await f.scheduler.sample(); assert.equal(f.scheduler.metrics[s.id].speed, 0);
  for (let i = 1; i <= 4; i++) { f.time(i * 1000); f.connections(connection(1000 + i * 2000)); await f.scheduler.sample(); }
  assert.equal(f.scheduler.metrics[s.id].speed, 2000); assert.equal(f.scheduler.alerts.length, 1); assert.equal(f.writes.length, 0);
  assert.equal(f.scheduler.subscriptionBytes.download, 8000);
  const a = f.scheduler.alerts[0]; f.time(130000); await assert.rejects(() => f.scheduler.switch(s.id, f.state.subscriptions[2].nodes[0].id, { alertId: a.id }));
  await f.scheduler.switch(s.id, f.state.subscriptions[2].nodes[0].id, { temporary: true });
  f.connections([]); f.time(140000); await f.scheduler.sample(); f.time(143000); await f.scheduler.sample(); assert.equal(s.temporary, undefined); assert.equal(s.subscriptionId, 'download');
});
test('failed persistence reverts core selection and scene state', async () => {
  const f = fixture(); const s = f.state.scenes[0]; const previous = s.selected;
  f.scheduler.persist = async () => { throw Error('disk full'); };
  await assert.rejects(() => f.scheduler.switch(s.id, f.state.subscriptions[2].nodes[0].id));
  assert.equal(s.selected, previous); assert.equal(f.writes.at(-1)[1], nodeName(previous));
});
test('latency probes do not block connection sampling; stale results cannot select after scene edits', async () => {
  const f = fixture(); let release;
  const blocked = new Promise(r => { release = r; });
  f.core.delay = async () => { await blocked; return { delay: 1 }; };
  const probing = f.scheduler.checkDelays();
  await f.scheduler.sample(); assert.ok(f.scheduler.metrics.daily);
  f.scheduler.invalidate(); release(); await probing; assert.equal(f.writes.length, 0);
});
test('manual latency probe keeps per-node results, marks failures and ignores unknown ids', async () => {
  const f = fixture(); const [a, b] = f.state.subscriptions[0].nodes; const revision = f.scheduler.delayRevision;
  f.core.delay = async name => { if (name === nodeName(b.id)) throw Error('timeout'); return { delay: 25 }; };
  assert.deepEqual(await f.scheduler.probe([a.id, b.id, a.id, 'missing']), { [a.id]: 25, [b.id]: null });
  assert.equal(f.scheduler.delays[a.id], 25); assert.equal(f.scheduler.delays[b.id], Infinity);
  assert.equal(f.scheduler.delayRevision, revision + 1);
  await assert.rejects(() => f.scheduler.probe([]), /没有可查询的节点/);
});

test('a manual latency probe applies the same automatic decision as the periodic check', async () => {
  const f = fixture(); const scene = f.state.scenes[0]; const [, target] = f.state.subscriptions[0].nodes;
  f.core.delay = async name => ({ delay: name === nodeName(target.id) ? 5 : 300 });
  await f.scheduler.probe(f.state.subscriptions[0].nodes.map(n => n.id));
  assert.equal(scene.selected, target.id);
  assert.equal(f.log.at(-1).reason, 'auto-country');
  assert.equal(f.writes.length, 1);
});
test('a timed-out selected node is replaced even inside the dwell window', async () => {
  const f = fixture(); const scene = f.state.scenes[0]; const [failed, healthy] = f.state.subscriptions[0].nodes;
  assert.equal(scene.selected, failed.id);
  f.scheduler.runtime(scene.id).switched = 0; f.time(1000);
  f.core.delay = async name => { if (name === nodeName(failed.id)) throw new Error('timeout'); return { delay: 20 }; };
  await f.scheduler.checkDelays();
  assert.equal(scene.selected, healthy.id);
  assert.equal(f.log.at(-1).reason, 'auto-country');
  assert.ok(f.events.some(e => e.decision === '已切换' && e.reason === '当前节点超时'));
});
test('manual selection preserves same-subscription candidate edits and choosing permanent ends acceleration', async () => {
  const f = fixture(); const s = f.state.scenes[0]; s.candidates = [s.selected]; s.countries = ['JP'];
  await f.scheduler.switch(s.id, f.state.subscriptions[0].nodes[1].id); assert.equal(s.candidates.length, 1); assert.deepEqual(s.countries, ['JP']);
  await f.scheduler.switch(s.id, f.state.subscriptions[2].nodes[0].id, { temporary: true }); assert.ok(s.temporary);
  await f.scheduler.switch(s.id, f.state.subscriptions[1].nodes[0].id); assert.equal(s.temporary, undefined);
});
