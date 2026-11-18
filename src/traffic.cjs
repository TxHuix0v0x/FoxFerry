'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./store.cjs');
const HOUR = 60 * 60 * 1000;
const KEEP_DAYS = 365;
const KEEP_HOURS = 48;
const pad = value => String(value).padStart(2, '0');
const dayOf = ts => { const d = new Date(ts); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / HOUR); };
// Hourly buckets cover today and the last 24 hours; older hours are folded into per-day buckets
// so a full year of history stays small enough to flush every couple of minutes.
class TrafficHistory {
  constructor(dir) { this.file = path.join(dir, 'traffic.json'); this.hours = new Map(); this.days = new Map(); this.dirty = false; this.saving = null; }
  normalize(row) { return { h: row.h, total: Math.max(0, Number(row.total) || 0), subs: row.subs && typeof row.subs === 'object' ? row.subs : {} }; }
  async load(now = Date.now()) {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const row of value?.hours || []) if (Number.isInteger(row.h) && row.h > 0) this.hours.set(row.h, this.normalize(row));
      for (const row of value?.days || []) if (Number.isInteger(row.h) && row.h > 0) this.days.set(row.h, this.normalize(row));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.rollup(now); this.prune(now);
    return this;
  }
  add(now, subscriptionId, bytes) {
    if (!(bytes > 0)) return;
    const key = Math.floor(now / HOUR);
    const row = this.hours.get(key) || { h: key, total: 0, subs: {} };
    row.total += bytes;
    if (subscriptionId) row.subs[subscriptionId] = (row.subs[subscriptionId] || 0) + bytes;
    this.hours.set(key, row); this.dirty = true;
  }
  fold(target, row) { target.total += row.total; for (const [id, bytes] of Object.entries(row.subs)) target.subs[id] = (target.subs[id] || 0) + bytes; }
  rollup(now) {
    const cutoff = Math.floor(now / HOUR) - KEEP_HOURS;
    for (const [key, row] of [...this.hours]) {
      if (key >= cutoff) continue;
      const dayKey = dayOf(key * HOUR);
      const day = this.days.get(dayKey) || { h: dayKey, total: 0, subs: {} };
      this.fold(day, row); this.days.set(dayKey, day); this.hours.delete(key); this.dirty = true;
    }
  }
  prune(now) {
    this.rollup(now);
    const min = dayOf(now) - (KEEP_DAYS - 1) * 24;
    for (const key of this.days.keys()) if (key < min) this.days.delete(key);
  }
  dayTotal(dayKey) {
    let total = this.days.get(dayKey)?.total || 0;
    for (let hour = 0; hour < 24; hour++) total += this.hours.get(dayKey + hour)?.total || 0;
    return total;
  }
  async flush(now = Date.now()) {
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false; this.prune(now);
    const value = {
      version: 2,
      hours: [...this.hours.values()].sort((a, b) => a.h - b.h),
      days: [...this.days.values()].sort((a, b) => a.h - b.h)
    };
    this.saving = atomicWrite(this.file, JSON.stringify(value)).catch(error => { this.dirty = true; throw error; }).finally(() => { this.saving = null; });
    await this.saving;
  }
  summary(range = 'd7', now = Date.now()) {
    const current = Math.floor(now / HOUR), today = dayOf(now);
    const label = (key, unit) => { const d = new Date(key * HOUR); return unit === 'hour' ? `${pad(d.getHours())}:00` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    if (range === 'today' || range === 'day24') {
      const count = range === 'today' ? current - today + 1 : 24;
      const rows = [];
      for (let index = 0; index < count; index++) {
        const key = range === 'today' ? today + index : current - (count - 1) + index;
        rows.push({ key, value: this.hours.get(key)?.total || 0 });
      }
      return { range, unit: 'hour', total: rows.reduce((sum, row) => sum + row.value, 0), rows: rows.map(row => ({ label: label(row.key, 'hour'), bytes: row.value })) };
    }
    const days = range === 'd14' ? 14 : range === 'd30' ? 30 : range === 'all' ? KEEP_DAYS : 7;
    const rows = [];
    for (let index = days - 1; index >= 0; index--) {
      const dayKey = today - index * 24;
      rows.push({ key: dayKey, value: this.dayTotal(dayKey) });
    }
    return { range, unit: 'day', total: rows.reduce((sum, row) => sum + row.value, 0), rows: rows.map(row => { const date = new Date(row.key * HOUR); return { label: label(row.key, 'day'), date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, bytes: row.value }; }) };
  }
}
module.exports = { TrafficHistory, HOUR, KEEP_DAYS, KEEP_HOURS };
