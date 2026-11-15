'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const tls = require('node:tls');
const { spawn } = require('node:child_process');
const { atomicWrite } = require('./store.cjs');
const { stringify } = require('./model.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const server = net.createServer(); await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); }); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
function trace(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'www.cloudflare.com:443', timeout: 10000 });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('出口检测超时')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(Error('测试代理连接失败')); return; }
      const secure = tls.connect({ socket, servername: 'www.cloudflare.com' });
      secure.setTimeout(10000, () => secure.destroy(Error('出口检测超时')));
      secure.on('error', reject); let response = '';
      secure.once('secureConnect', () => secure.write('GET /cdn-cgi/trace HTTP/1.1\r\nHost: www.cloudflare.com\r\nConnection: close\r\n\r\n'));
      secure.on('data', b => { response += b; if (response.length > 65536) secure.destroy(Error('测试响应过大')); });
      secure.on('end', () => { const found = response.match(/(?:\r?\n)loc=([A-Z]{2})(?:\r?\n|$)/); if (/^HTTP\/1\.[01] 200 /.test(response) && found) resolve(found[1]); else reject(Error('无法确认实际出口国家')); });
    }); req.end();
  });
}
async function probeCountry(node, binary, dataDir) {
  if (!binary || !path.isAbsolute(binary)) throw Error('请先选择本机 Mihomo');
  const stage = await fs.mkdtemp(path.join(dataDir, 'probe-')); let child;
  try {
    const port = await freePort();
    const config = { 'mixed-port': port, 'bind-address': '127.0.0.1', 'allow-lan': false, mode: 'rule', ipv6: false, 'log-level': 'silent', dns: { enable: false }, tun: { enable: false }, proxies: [{ ...node.config, name: 'EXIT_PROBE' }], rules: ['MATCH,EXIT_PROBE'] };
    const file = path.join(stage, 'config.yaml'); await atomicWrite(file, stringify(config));
    child = spawn(binary, ['-d', stage, '-f', file], { windowsHide: true, stdio: 'ignore' });
    let failed = false; child.on('error', () => { failed = true; }); child.on('exit', () => { failed = true; });
    for (let attempt = 0; attempt < 40; attempt++) { if (failed) throw Error('独立出口测试内核无法启动'); try { await new Promise((r, j) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(); }); s.once('error', j); }); return await trace(port); } catch (e) { if (attempt === 39 || e.code !== 'ECONNREFUSED') throw e; await sleep(100); } }
  } finally {
    if (child && child.exitCode === null && !child.killed) { child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]); }
    await fs.rm(stage, { recursive: true, force: true });
  }
}
module.exports = { freePort, probeCountry };
