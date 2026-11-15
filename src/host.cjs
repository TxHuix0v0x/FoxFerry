'use strict';
// Adapted from codex-maid-widget DesktopLaunchGate (MIT); process identity survives tray minimization.
class HostGate {
  constructor() { this.seen = new Set(); this.absent = 0; }
  update(processes) {
    if (!processes.length) { this.absent++; if (this.absent < 2) return { launch: false, exited: false }; const exited = this.seen.size > 0; this.seen.clear(); return { launch: false, exited }; }
    this.absent = 0;
    const next = new Set(processes.map(p => p.key));
    const launch = [...next].some(k => !this.seen.has(k)); this.seen = next;
    return { launch, exited: false };
  }
}
module.exports = { HostGate };
