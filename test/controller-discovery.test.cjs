'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { endpointCandidates, resolveController } = require('../src/core.cjs');
const owner = () => randomBytes(32).toString('hex');
const pipe = (kind, key) => `\\\\.\\pipe\\verge-mihomo-${kind}-${key}`;
async function serve(address, { meta = true, status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ method: req.method, path: req.url, auth: req.headers.authorization }); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ meta, version: 'fixture' })); });
  await new Promise((resolve, reject) => { server.once('error', reject); address ? server.listen(address, resolve) : server.listen(0, '127.0.0.1', resolve); });
  return { requests, origin: address ? null : `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
test('controller candidates preserve exact owner/channel, prefer pipes, and never add remote HTTP or global service APIs', () => {
  const key = owner(); const config = { 'external-controller-pipe': pipe('sidecar-release', key), 'external-controller': '127.0.0.1:1234', secret: 'fixture' };
  const result = endpointCandidates(config);
  assert.deepEqual(result.map(c => c.socketPath || c.origin), [pipe('sidecar-release', key), pipe('production', key), 'http://127.0.0.1:1234']);
  assert.equal(result[1].secret, 'fixture');
  assert.equal(endpointCandidates({ ...config, 'external-controller': '192.0.2.1:1234' }).length, 2);
  assert.deepEqual(endpointCandidates({ 'external-controller-pipe': pipe('sidecar-dev', key) }).map(c => c.socketPath), [pipe('sidecar-dev', key), pipe('development', key)]);
  assert.deepEqual(endpointCandidates({ 'external-controller-pipe': pipe('production', key) }).map(c => c.socketPath), [pipe('production', key), pipe('sidecar-release', key)]);
  assert.equal(endpointCandidates({ 'external-controller-pipe': '\\\\.\\pipe\\custom-controller' }).length, 1);
});
test('missing configured sidecar resolves authenticated same-owner service pipe using only GET /version', { skip: process.platform !== 'win32' }, async () => {
  const key = owner(), service = await serve(pipe('production', key));
  try {
    const result = await resolveController({ 'external-controller-pipe': pipe('sidecar-release', key), secret: 'fixture' });
    assert.equal(result.socketPath, pipe('production', key));
    assert.deepEqual(service.requests, [{ method: 'GET', path: '/version', auth: 'Bearer fixture' }]);
  } finally { await service.close(); }
});
test('live declared sidecar is preferred over a live service pipe', { skip: process.platform !== 'win32' }, async () => {
  const key = owner(), sidecar = await serve(pipe('sidecar-release', key)), service = await serve(pipe('production', key));
  try {
    assert.equal((await resolveController({ 'external-controller-pipe': pipe('sidecar-release', key) })).socketPath, pipe('sidecar-release', key));
    assert.equal(service.requests.length, 0);
  } finally { await sidecar.close(); await service.close(); }
});
test('only explicitly configured loopback HTTP is used after missing pipes', { skip: process.platform !== 'win32' }, async () => {
  const server = await serve();
  try { const result = await resolveController({ 'external-controller-pipe': pipe('sidecar-release', owner()), 'external-controller': server.origin }); assert.equal(result.origin, server.origin); assert.equal(server.requests.length, 1); }
  finally { await server.close(); }
});
test('authentication or non-Mihomo responses never trigger another endpoint attempt', { skip: process.platform !== 'win32' }, async () => {
  for (const options of [{ status: 401 }, { meta: false }]) {
    const key = owner(), sidecar = await serve(pipe('sidecar-release', key), options), service = await serve(pipe('production', key));
    try { await assert.rejects(() => resolveController({ 'external-controller-pipe': pipe('sidecar-release', key) })); assert.equal(service.requests.length, 0); }
    finally { await sidecar.close(); await service.close(); }
  }
});
test('missing control pipes produce actionable Chinese errors without leaking raw pipe paths', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(() => resolveController({ 'external-controller-pipe': pipe('sidecar-release', owner()) }), error => /确认 Mihomo 内核正在运行/.test(error.message) && !/ENOENT|\\pipe\\/.test(error.message) && error.code === 'ENOENT');
});
