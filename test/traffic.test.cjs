'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TrafficHistory, HOUR } = require('../src/traffic.cjs');

test('traffic history keeps hours for two days, folds older hours into days and retains a year', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-traffic-'));
  const now = new Date(2026, 4, 20, 15, 0, 0).getTime();
  try {
    const traffic = new TrafficHistory(dir);
    await traffic.load(now);
    traffic.add(now, 'main', 1000);
    traffic.add(now, 'download', 500);
    traffic.add(now - 2 * HOUR, 'main', 250);
    traffic.add(now - 60 * HOUR, 'main', 500);
    traffic.add(now - 100 * 24 * HOUR, 'main', 700);
    await traffic.flush(now);
    const reloaded = await new TrafficHistory(dir).load(now);
    const today = reloaded.summary('today', now);
    assert.equal(today.unit, 'hour'); assert.equal(today.total, 1750); assert.equal(today.rows.at(-1).label, '15:00');
    assert.equal(reloaded.hours.has(Math.floor((now - 60 * HOUR) / HOUR)), false, 'older hours are folded into day buckets');
    const d7 = reloaded.summary('d7', now);
    assert.equal(d7.rows.length, 7); assert.equal(d7.total, 2250); assert.equal(d7.rows.at(-1).bytes, 1750); assert.equal(d7.rows.at(-1).date, '2026-05-20');
    assert.equal(reloaded.summary('d30', now).total, 2250);
    const all = reloaded.summary('all', now);
    assert.equal(all.rows.length, 365); assert.equal(all.total, 2950);
    const subs = reloaded.hours.get(Math.floor(now / HOUR));
    assert.deepEqual(subs.subs, { main: 1000, download: 500 });
    reloaded.add(now - 400 * 24 * HOUR, 'main', 999);
    await reloaded.flush(now);
    const third = await new TrafficHistory(dir).load(now);
    assert.equal(third.summary('all', now).total, 2950, 'older than a year is pruned');
    assert.equal(third.hours.size, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
