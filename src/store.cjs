'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { initialState, validateState, upgradeState } = require('./model.cjs');
async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}
class Store {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'state.json'); this.queue = Promise.resolve(); }
  async load() {
    let raw;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('用户数据读取失败，已保留原文件；请备份并检查 state.json'); await this.save(initialState()); return this.state; }
    try {
      const value = JSON.parse(raw), next = upgradeState(value);
      if (value.version === 1) {
        this.backupFile = path.join(this.dir, 'backups', `state-v1-${Date.now()}-${randomUUID()}.json`);
        await atomicWrite(this.backupFile, raw); await this.save(next); this.migrated = true;
      } else this.state = next;
    } catch { throw Error('用户数据读取或升级失败，已保留原数据及可用备份；请检查 state.json'); }
    return this.state;
  }
  async save(value) {
    const snapshot = structuredClone(validateState(value));
    const job = this.queue.then(async () => { await atomicWrite(this.file, JSON.stringify(snapshot, null, 2)); this.state = snapshot; });
    this.queue = job.catch(() => {});
    return job;
  }
}
function redact(message) { return String(message).replace(/https?:\/\/[^\s"'<>]+/gi, '[网址已隐藏]').replace(/(password|secret|token|authorization|uuid)\s*[=:]\s*[^\s,}]+/gi, '$1=[已隐藏]').replace(/Command failed:[^\r\n]*/gi, '系统命令执行失败'); }
module.exports = { Store, atomicWrite, redact };
