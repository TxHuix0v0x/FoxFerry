'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { HostGate } = require('./host.cjs');
// ponytail: 5s poll. Each poll starts a PowerShell process and runs a WMI query (~0.4 s wall), so a
// shorter interval buys faster Verge start/stop following at a proportional background cost. Lower it
// only with a cheaper presence check; raising it past ~15 s makes start following visibly late.
const POLL_MS = 5000;
function watcherPipe(dir) { return `\\\\.\\pipe\\foxferry-${createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0,24)}`; }
function startWatcher({ dir, executable, args, snapshot, readFollow, launch }) {
  const clients = new Set(), gate = new HostGate(); let timer, closed = false, latest;
  const server = net.createServer(socket => {
    let command = ''; socket.on('data',chunk=>{command+=chunk;if(command==='stop\n')stop();else if(command.length>16)socket.destroy();});
    clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    if (latest) socket.write(JSON.stringify(latest) + '\n');
  });
  async function poll() {
    try {
      if (!await readFollow()) { stop(); return; }
      const value = await snapshot(); if(closed)return; latest = value;
      const result = gate.update(value.hosts);
      for (const socket of clients) { if (socket.writableLength > 65536) socket.destroy(); else socket.write(JSON.stringify(value) + '\n'); }
      if (result.launch && !clients.size) launch();
    } catch { /* Unknown state never authorizes a launch or exit. */ }
    if (!closed) timer = setTimeout(poll,POLL_MS);
  }
  function stop() { closed = true; clearTimeout(timer); for (const socket of clients) socket.destroy(); server.close(); }
  server.on('error', error => { if (error.code === 'EADDRINUSE') { closed = true; return; } throw error; });
  server.listen(watcherPipe(dir), () => { timer = setTimeout(poll,POLL_MS); });
  return { stop, server, gate };
}
if (require.main === module) {
  const [dir, executable, ...args] = process.argv.slice(2);
  const { processSnapshot } = require('./discovery.cjs');
  let stamp, follow = false;
  startWatcher({ dir, executable, args, snapshot:() => processSnapshot(true), readFollow:async () => {
    const file = path.join(dir,'state.json'), stat = await fs.promises.stat(file), next = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (next !== stamp) { follow = !!JSON.parse(await fs.promises.readFile(file,'utf8')).preferences.follow; stamp = next; }
    return follow;
  }, launch:() => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable,args,{env,detached:true,windowsHide:true,stdio:'ignore'}); child.on('error',()=>{}); child.unref();
  } });
}
async function waitForWatcher(dir) {
  const until = Date.now()+8000;
  while(true) { try { const socket = await new Promise((resolve,reject)=>{const s=net.connect(watcherPipe(dir));s.once('connect',()=>resolve(s));s.once('error',reject);}); socket.destroy(); return; } catch(error) { if(Date.now()>=until)throw Error('后台联动助手未能启动'); await new Promise(r=>setTimeout(r,100)); } }
}
async function stopWatcher(dir) {
  await new Promise((resolve,reject)=>{const socket=net.connect(watcherPipe(dir));const timer=setTimeout(()=>{socket.destroy();reject(Error('后台联动助手未能停止'));},3000);socket.once('connect',()=>socket.write('stop\n'));socket.once('close',()=>{clearTimeout(timer);resolve();});socket.once('error',error=>{clearTimeout(timer);if(!['ENOENT','ECONNREFUSED'].includes(error.code))reject(error);});});
}
module.exports = { startWatcher, watcherPipe, waitForWatcher, stopWatcher, POLL_MS };
