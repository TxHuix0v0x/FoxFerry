'use strict';
const net = require('node:net');
const dgram = require('node:dgram');
const assert = require('node:assert/strict');
async function udpSession(port) {
  const socket = net.connect(port, '127.0.0.1'); const udp = dgram.createSocket('udp4');
  let pending = Buffer.alloc(0), waiting;
  socket.on('data', chunk => { pending = Buffer.concat([pending, chunk]); waiting?.(); }); socket.on('error', () => {});
  async function bytes(n) {
    while (pending.length < n) await new Promise((resolve, reject) => { const timer = setTimeout(() => { waiting = null; reject(Error('SOCKS fixture timeout')); }, 3000); waiting = () => { if (pending.length >= n) { clearTimeout(timer); waiting = null; resolve(); } }; });
    const value = pending.subarray(0, n); pending = pending.subarray(n); return value;
  }
  const close = () => { socket.destroy(); try { udp.close(); } catch {} };
  try {
    socket.write(Buffer.from([5, 1, 0])); assert.deepEqual(await bytes(2), Buffer.from([5, 0]));
    socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])); const head = await bytes(4); assert.equal(head[1], 0); assert.equal(head[3], 1);
    const address = await bytes(6); const relayPort = address.readUInt16BE(4);
    return { close, send(targetPort) { const packet = Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255, 65]); return new Promise((r, j) => udp.send(packet, relayPort, '127.0.0.1', e => e ? j(e) : r())); } };
  } catch (e) { close(); throw e; }
}
async function udpBoundary(core, config, state) {
  const echo = dgram.createSocket('udp4'); let leaked = 0, session;
  echo.on('message', () => leaked++); await new Promise(r => echo.bind(0, '127.0.0.1', r));
  try {
    // A local echo sink avoids external traffic; removing LAN bypass exercises the generated final scene/REJECT pair.
    const guarded = { ...config, rules: config.rules.filter(r => !r.includes(',DIRECT')) };
    await core.apply(guarded); session = await udpSession(config['mixed-port']); await session.send(echo.address().port); await new Promise(r => setTimeout(r, 400));
    assert.equal(leaked, 0, 'HTTP-only selected node must not leak UDP to DIRECT'); session.close();
    assert.equal((await core.proxies()).proxies[`N_${state.scenes[0].selected}`].udp, false);
    // Positive control proves the same local UDP path reaches the sink when DIRECT is deliberately selected.
    await core.apply({ ...guarded, rules: ['MATCH,DIRECT'] }); session = await udpSession(config['mixed-port']); await session.send(echo.address().port); await new Promise(r => setTimeout(r, 400)); assert.ok(leaked > 0, 'positive UDP control reaches sink');
    return { unsupportedUDPRejected: true, directPositiveControl: true, destination: 'local-only' };
  } finally { session?.close(); echo.close(); await core.apply(config); }
}
module.exports = { udpBoundary };
