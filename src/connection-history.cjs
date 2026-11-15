'use strict';
class ConnectionHistory {
  constructor() { this.records = new Map(); this.active = new Set(); this.sampledAt = null; this.ids = []; this.dirty = false; this.snapshot = null; this.bySubscription = new Map(); }
  compareIds(a,b) { return this.records.get(b).firstSeenAt - this.records.get(a).firstSeenAt || a.localeCompare(b); }
  get(id) { return this.records.get(id); }
  observe(rows, now) {
    const current = new Set();
    for (const row of rows) {
      const old = this.records.get(row.id);
      if (!old) { this.ids.push(row.id); this.dirty = true; }
      if (!old || old.subscriptionId !== row.subscriptionId) {
        const previous = old && this.bySubscription.get(old.subscriptionId || '@unknown');
        if (previous) { previous.ids.delete(row.id); previous.sorted = null; }
        const key = row.subscriptionId || '@unknown';
        if (!this.bySubscription.has(key)) this.bySubscription.set(key, { ids:new Set(), sorted:null });
        const bucket = this.bySubscription.get(key); bucket.ids.add(row.id); bucket.sorted = null;
      }
      this.records.set(row.id, { ...row, status: 'active', firstSeenAt: old?.firstSeenAt ?? now, lastSeenAt: now, endedAt: null });
      current.add(row.id);
    }
    for (const id of this.active) if (!current.has(id)) {
      const record = this.records.get(id);
      this.records.set(id, { ...record, status: 'ended', endedAt: now });
    }
    this.active = current; this.sampledAt = now;
  }
  page({ page = 1, mode = 'live', subscriptionId = '' } = {}) {
    if (!Number.isInteger(page) || page < 1 || !['live', 'pause', 'refresh', 'snapshot', 'resume'].includes(mode) || typeof subscriptionId !== 'string' || (subscriptionId && subscriptionId !== '@unknown' && !/^[a-zA-Z0-9_-]{1,64}$/.test(subscriptionId))) throw Error('无效的连接分页请求');
    if (this.dirty) { this.ids.sort((a,b)=>this.compareIds(a,b)); this.dirty = false; }
    const matches = row => !subscriptionId || (row.subscriptionId || '@unknown') === subscriptionId;
    if (mode === 'pause' || mode === 'refresh') {
      const rows = this.ids.map(id => this.records.get(id)), counts = new Map();
      for (const row of rows) { const key = row.subscriptionId || '@unknown', count = counts.get(key) || { total:0, active:0 }; count.total++; if (row.status === 'active') count.active++; counts.set(key,count); }
      this.snapshot = { rows, sampledAt:this.sampledAt, active:this.active.size, counts };
    }
    if (mode === 'live' || mode === 'resume') this.snapshot = null;
    const snapshot = this.snapshot, bucket = this.bySubscription.get(subscriptionId);
    let active = snapshot ? (subscriptionId ? snapshot.counts.get(subscriptionId)?.active || 0 : snapshot.active) : subscriptionId ? 0 : this.active.size;
    if (!snapshot && subscriptionId) for (const id of this.active) if (matches(this.records.get(id))) active++;
    const total = snapshot ? (subscriptionId ? snapshot.counts.get(subscriptionId)?.total || 0 : snapshot.rows.length) : subscriptionId ? bucket?.ids.size || 0 : this.records.size;
    page = Math.min(page, Math.max(1, Math.ceil(total / 10)));
    const start = (page - 1) * 10, rows = []; let index = 0;
    const take = row => { if (matches(row) && index++ >= start) rows.push(row); return rows.length === 10; };
    if (snapshot) { for (const row of snapshot.rows) if (take(row)) break; }
    else {
      if (bucket && !bucket.sorted) bucket.sorted = [...bucket.ids].sort((a,b)=>this.compareIds(a,b));
      for (const id of subscriptionId ? bucket?.sorted || [] : this.ids) if (take(this.records.get(id))) break;
    }
    return { page, total, active, sampledAt:snapshot ? snapshot.sampledAt : this.sampledAt, paused:!!snapshot, rows, subscriptionId };
  }
  // shortcut: complete session history and an explicit paused snapshot grow with the session; retention needs a user decision.
  get rows() { return [...this.records.values()]; }
  clear() { this.records.clear(); this.active.clear(); this.ids = []; this.snapshot = null; this.sampledAt = null; this.dirty = false; this.bySubscription.clear(); }
}
module.exports = { ConnectionHistory };
