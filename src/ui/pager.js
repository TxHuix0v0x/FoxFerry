'use strict';
class ConnectionPager {
  constructor() { this.pageSize = 10; this.page = 1; this.paused = false; this.rows = []; this.total = 0; this.active = 0; this.sampledAt = null; }
  update(result) { Object.assign(this, result); }
  get pages() { return Math.max(1, Math.ceil(this.total / this.pageSize)); }
  get visible() { return this.rows; }
}
if (typeof module !== 'undefined') module.exports = { ConnectionPager };
