'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store, atomicWrite, redact } = require('../src/store.cjs');
const { HostGate } = require('../src/host.cjs');
const { endpoint, Core } = require('../src/core.cjs');
test('atomic persistence serializes writes and refuses corrupt existing data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-store-'));
  try { const store = new Store(dir); await store.load(); const a = structuredClone(store.state); a.preferences.tolerance = 80; await Promise.all([store.save(a), store.save({ ...a, preferences: { ...a.preferences, follow: true } })]); assert.equal((await new Store(dir).load()).preferences.follow, true); await atomicWrite(store.file, 'broken'); await assert.rejects(() => new Store(dir).load()); assert.equal(await fs.readFile(store.file, 'utf8'), 'broken'); } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('follow gate ignores tray visibility and manual exit, launches only new process session, handles unknown and restart', () => {
  const gate = new HostGate(); const roots = [{ key: 'pid1:start1' }];
  assert.ok(gate.update(roots).launch); assert.ok(!gate.update(roots).launch); assert.ok(!gate.update(roots).exited);
  assert.ok(!gate.update([]).exited); assert.ok(gate.update([]).exited); assert.ok(gate.update([{ key: 'pid1:start2' }]).launch);
});
test('controller prefers named pipe, refuses remote host and redacts secrets', () => {
  assert.equal(endpoint({ 'external-controller-pipe': '\\\\.\\pipe\\test', 'external-controller': '127.0.0.1:1234' }).socketPath, '\\\\.\\pipe\\test');
  assert.throws(() => endpoint({ 'external-controller': 'evil.example:80' }));
  assert.equal(endpoint({ 'external-controller': '0.0.0.0:1234' }).origin, 'http://127.0.0.1:1234');
  assert.ok(!redact('https://example.com/?token=private secret=private').includes('private'));
});
test('HTTP and named pipe API transport authenticate, encode IDs, fail errors, never clear all connections', async () => {
  for (const pipe of [false, ...(process.platform === 'win32' ? [true] : [])]) {
    const requests = []; const server = http.createServer((req, res) => { requests.push([req.method, req.url, req.headers.authorization]); if (req.url === '/error') { res.writeHead(401); res.end(); } else { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); } });
    const address = pipe ? `\\\\.\\pipe\\assistant-test-${process.pid}-${Date.now()}` : undefined;
    await new Promise(r => pipe ? server.listen(address, r) : server.listen(0, '127.0.0.1', r));
    try { const core = new Core({ ...(pipe ? { socketPath: address } : { origin: `http://127.0.0.1:${server.address().port}` }), secret: 'fixture' }); await core.select('场景 /', 'node'); await core.close('id/one'); await assert.rejects(() => core.request('GET', '/error')); assert.equal(requests[1][1], '/connections/id%2Fone'); assert.equal(requests[0][2], 'Bearer fixture'); assert.ok(!requests.some(([method, url]) => method === 'DELETE' && url === '/connections')); } finally { await new Promise(r => server.close(r)); }
  }
});
