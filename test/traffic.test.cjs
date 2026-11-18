'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TrafficHistory } = require('../src/traffic.cjs');

test('traffic history aggregates hours into days, prunes older than 30 days and survives reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-traffic-'));
  const now = new Date(2026, 4, 20, 15, 0, 0).getTime(), hour = 60 * 60 * 1000;
  try {
    const traffic = new TrafficHistory(dir);
    await traffic.load(now);
    traffic.add(now, 'main', 1000);
    traffic.add(now, 'download', 500);
    traffic.add(now - 2 * hour, 'main', 250);
    await traffic.flush(now);
    const reloaded = await new TrafficHistory(dir).load(now);
    assert.equal(reloaded.summary('d7', now).total, 1750);
    const today = reloaded.summary('today', now);
    assert.equal(today.unit, 'hour'); assert.equal(today.total, 1750); assert.equal(today.rows.at(-1).label, '15:00');
    const days = reloaded.summary('d7', now);
    assert.equal(days.unit, 'day'); assert.equal(days.rows.length, 7); assert.equal(days.rows.at(-1).bytes, 1750); assert.equal(days.rows[0].bytes, 0);
    assert.equal(days.rows.at(-1).date, '2026-05-20');
    const subs = reloaded.hours.get(Math.floor(now / hour));
    assert.deepEqual(subs.subs, { main: 1000, download: 500 });
    reloaded.add(now - 31 * 24 * hour, 'main', 999);
    await reloaded.flush(now);
    const third = await new TrafficHistory(dir).load(now);
    assert.equal(third.summary('d30', now).total, 1750);
    assert.equal(third.hours.size, 2);
    assert.equal(third.summary('all', now).rows.length, 30);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
