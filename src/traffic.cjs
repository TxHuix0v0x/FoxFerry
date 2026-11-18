'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./store.cjs');
const HOUR = 60 * 60 * 1000;
const KEEP_HOURS = 30 * 24;
const pad = value => String(value).padStart(2, '0');
// Hour buckets keep the last 30 days; day views are aggregated on read so the file stays small.
class TrafficHistory {
  constructor(dir) { this.file = path.join(dir, 'traffic.json'); this.hours = new Map(); this.dirty = false; this.saving = null; }
  async load(now = Date.now()) {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const row of value?.hours || []) if (Number.isInteger(row.h) && row.h > 0) this.hours.set(row.h, { h: row.h, total: Math.max(0, Number(row.total) || 0), subs: row.subs && typeof row.subs === 'object' ? row.subs : {} });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.prune(now);
    return this;
  }
  prune(now) { const min = Math.floor(now / HOUR) - KEEP_HOURS; for (const key of this.hours.keys()) if (key < min) this.hours.delete(key); }
  add(now, subscriptionId, bytes) {
    if (!(bytes > 0)) return;
    const key = Math.floor(now / HOUR);
    const row = this.hours.get(key) || { h: key, total: 0, subs: {} };
    row.total += bytes;
    if (subscriptionId) row.subs[subscriptionId] = (row.subs[subscriptionId] || 0) + bytes;
    this.hours.set(key, row); this.dirty = true;
  }
  async flush(now = Date.now()) {
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false; this.prune(now);
    const value = { version: 1, hours: [...this.hours.values()].sort((a, b) => a.h - b.h) };
    this.saving = atomicWrite(this.file, JSON.stringify(value)).catch(error => { this.dirty = true; throw error; }).finally(() => { this.saving = null; });
    await this.saving;
  }
  summary(range = 'd7', now = Date.now()) {
    const current = Math.floor(now / HOUR);
    const startOfDay = Math.floor(new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime() / HOUR);
    const label = (key, unit) => { const d = new Date(key * HOUR); return unit === 'hour' ? `${pad(d.getHours())}:00` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const rows = [];
    if (range === 'today' || range === 'day24') {
      const count = range === 'today' ? current - startOfDay + 1 : 24;
      for (let index = 0; index < count; index++) {
        const key = range === 'today' ? startOfDay + index : current - (count - 1) + index;
        rows.push({ key, value: this.hours.get(key)?.total || 0 });
      }
      return { range, unit: 'hour', total: rows.reduce((sum, row) => sum + row.value, 0), rows: rows.map(row => ({ label: label(row.key, 'hour'), bytes: row.value })) };
    }
    const days = range === 'd14' ? 14 : range === 'd30' || range === 'all' ? 30 : 7;
    for (let index = days - 1; index >= 0; index--) {
      const dayStart = startOfDay - index * 24; let total = 0;
      for (let hour = 0; hour < 24; hour++) total += this.hours.get(dayStart + hour)?.total || 0;
      rows.push({ key: dayStart, value: total });
    }
    return { range, unit: 'day', total: rows.reduce((sum, row) => sum + row.value, 0), rows: rows.map(row => ({ label: label(row.key, 'day'), bytes: row.value })) };
  }
}
module.exports = { TrafficHistory, HOUR, KEEP_HOURS };
