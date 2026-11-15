'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { discover } = require('../src/discovery.cjs');
const { Core, validateConfig, exec } = require('../src/core.cjs');
const M = require('../src/model.cjs');
const { createDemo } = require('../src/simulation.cjs');
const { freePort } = require('../src/probe.cjs');
const { Service, ruleSignature, signature } = require('../src/service.cjs');
const { Store } = require('../src/store.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const root = path.resolve(__dirname, '..'); await fs.mkdir(path.join(root, '.local'), { recursive: true }); const dir = await fs.mkdtemp(path.join(root, '.local/core-'));
  const binary = process.env.MIHOMO_BINARY || (await discover()).corePath;
  assert.ok(binary, 'set MIHOMO_BINARY to an existing Mihomo executable');
  const servers = [], sockets = new Set(), providerHits = [], jobs = [], clientFiles = new Set(); let child, log;
  try {
    const { state } = createDemo();
    for (let i = 0; i < 3; i++) {
      const tag = ['main', 'download', 'backup'][i];
      const server = http.createServer((_req, res) => {
        providerHits.push(tag); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Provider': tag }); let count = 0;
        const limit = _req.headers['x-fixture-long'] ? 175 : 35;
        const timer = setInterval(() => { if (++count > limit) { clearInterval(timer); res.end(); } else res.write(Buffer.alloc(16384, i + 65)); }, 40);
        res.on('close', () => clearInterval(timer));
      });
      server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
      server.on('connect', (_req, socket, head) => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head); server.emit('connection', socket); });
      await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
      state.subscriptions[i].nodes = M.parseNodes(M.stringify({ proxies: [{ name: '日本 同名节点', type: 'http', server: '127.0.0.1', port: server.address().port }] }), state.subscriptions[i].id);
    }
    state.scenes.forEach(s => { if (s.id === 'qb') s.subscriptionId = 'backup'; s.selected = state.subscriptions.find(sub => sub.id === s.subscriptionId).nodes[0].id; });
    const exactPath = path.join(dir,'Apps (x86), 中文','chrome.exe');
    state.rules = [{ id: 'chrome', name: 'Chrome 特定网站', processes: [], processPaths: [exactPath], domains: ['download.example.test'], sceneId: 'idm', enabled: true }, { id: 'idm', name: 'IDM', processes: ['IDMan.exe'], domains: [], sceneId: 'idm', enabled: true }, { id: 'qb', name: 'qBittorrent', processes: ['qbittorrent.exe'], domains: [], sceneId: 'qb', enabled: true }];
    const port = await freePort(), controllerPort = await freePort();
    const config = { ...M.compile(state), 'mixed-port': port, 'bind-address': '127.0.0.1', 'allow-lan': false, mode: 'rule', dns: { enable: false }, tun: { enable: false }, 'log-level': 'warning', 'external-controller': `127.0.0.1:${controllerPort}`, secret: 'isolated-test' };
    await validateConfig(binary, config, dir);
    await fs.writeFile(path.join(dir, 'config.yaml'), M.stringify(config));
    log = await fs.open(path.join(dir, 'core.log'), 'w');
    child = spawn(binary, ['-d', dir, '-f', path.join(dir, 'config.yaml')], { windowsHide: true, stdio: ['ignore', log.fd, log.fd] }); child.on('error', () => {});
    const core = new Core({ origin: `http://127.0.0.1:${controllerPort}`, secret: 'isolated-test' });
    let ready = false; for (let i = 0; i < 50; i++) { try { await core.proxies(); ready = true; break; } catch { await sleep(100); } } assert.ok(ready, 'isolated core starts');
    const actualRules = (await core.rules()).rules;
    assert.equal(signature(actualRules), signature(ruleSignature(config)), 'rule ownership compares actual normalized Mihomo rules');
    const verification = new Service({ state, dir }); verification.core = core; await verification.verify(config); verification.makeScheduler();
    let sampledFrame;
    verification.scheduler.core = { connections: async () => { sampledFrame = await core.connections(); return sampledFrame; } };
    const tests = [['chrome.exe', 'download.example.test', 'download', exactPath], ['chrome.exe', 'download.example.test', 'main'], ['msedge.exe', 'download.example.test', 'main'], ['chrome.exe', 'browse.example.test', 'main', exactPath], ['IDMan.exe', 'files.example.test', 'download'], ['qbittorrent.exe', 'files.example.test', 'backup']];
    const clients = [], connections = [], retainedDownloads = [];
    for (const [name, domain, expected, chosenPath] of tests) {
      const clientBinary = process.platform === 'win32' ? chosenPath || path.join(dir, name) : process.execPath;
      await fs.mkdir(path.dirname(clientBinary), {recursive:true}); if(process.platform==='win32')clientFiles.add(clientBinary);
      if (process.platform === 'win32') try { await fs.link(process.execPath, clientBinary); } catch (e) { if (e.code !== 'EEXIST') await fs.copyFile(process.execPath, clientBinary); }
      let finished = false, seen;
      const job = exec(clientBinary, [path.join(__dirname, 'fixture-client.cjs'), String(port), domain], { windowsHide: true, timeout: 20000 }).then(value => { finished = true; return value; }, error => { finished = true; return { error }; });
      jobs.push(job);
      for (let attempt = 0; attempt < 100 && !seen && !finished; attempt++) { await verification.scheduler.sample(); seen = (sampledFrame.connections || []).find(c => (c.metadata.process || '').toLowerCase() === name.toLowerCase() && c.metadata.host === domain); if (!seen) await sleep(100); }
      const observed = seen && verification.view().connections.find(c => c.id === seen.id);
      assert.equal(observed?.status, 'active', JSON.stringify({name,domain,seen:seen?.id,history:verification.view().connections.map(c=>({id:c.id,status:c.status,process:c.process,host:c.host}))})); assert.equal(observed?.subscriptionId, expected);
      const completed = await job; if (completed.error) throw completed.error;
      await verification.scheduler.sample();
      const retained = verification.view().connections.find(c => c.id === seen.id);
      assert.equal(retained.status, 'ended'); assert.equal(retained.subscription, observed.subscription); assert.equal(retained.node, observed.node); assert.equal(retained.bytes, observed.bytes);
      retainedDownloads.push({ process: name, subscriptionId: retained.subscriptionId, status: retained.status, lastObservedBytes: retained.bytes });
      if (process.platform === 'win32') assert.ok(seen, `real process identified: ${name}`);
      if (seen) { connections.push({ process: seen.metadata.process, host: seen.metadata.host, chains: seen.chains, network: seen.metadata.network }); assert.ok(seen.chains.includes(M.nodeName(state.subscriptions.find(s => s.id === expected).nodes[0].id)), `actual exit ${name}/${domain}`); }
      const result = JSON.parse(completed.stdout.trim()); assert.equal(result.provider, expected, `route ${name}/${domain}`); assert.equal(result.bytes, 35 * 16384); clients.push({ process: name, domain, ...result });
    }
    await verification.close(); assert.deepEqual(verification.view().connections, []);
    // Unknown/unsupported protocols must fail validation before any runtime apply.
    const bad = structuredClone(config); bad.proxies[0].type = 'definitely-unsupported'; await assert.rejects(() => validateConfig(binary, bad, dir));
    await core.apply(config); await verification.verify(config);
    const udp = await require('./udp-fixture.cjs').udpBoundary(core, config, state);
    const runtimeDir = path.join(dir, 'verge-fixture'); await fs.mkdir(path.join(runtimeDir, 'profiles'), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'clash-verge.yaml'), M.stringify(config));
    await fs.writeFile(path.join(runtimeDir, 'profiles.yaml'), M.stringify({ current: 'owned', items: [{ uid: 'owned', name: 'Assistant', type: 'local', file: 'owned.yaml' }] }));
    await fs.writeFile(path.join(runtimeDir, 'profiles/owned.yaml'), M.stringify(M.compile(state)));
    const store = new Store(path.join(dir, 'assistant')); await store.load(); state.setup = { ready: true, vergeDir: runtimeDir, corePath: binary }; await store.save(state);
    const service = await new Service(store).init(); clearTimeout(service.timer); service.scheduleSample = () => {}; // This fixture controls every observation explicitly.
    await fs.writeFile(service.file, M.stringify(M.compile(state))); await service.attach();
    const newRules = [...state.rules, { id: 'site', name: '网站分流', processes: [], domains: ['new.example.test'], sceneId: 'qb', enabled: true }];
    await service.command('policy', { scenes: store.state.scenes, rules: newRules, defaultSceneId: state.defaultSceneId });
    assert.ok((await core.rules()).rules.some(r => r.payload === 'new.example.test' && r.proxy === 'AS_qb'));
    assert.ok((await fs.readFile(path.join(runtimeDir, 'profiles/owned.yaml'), 'utf8')).includes('new.example.test'), 'owned Verge copy updated');
    assert.equal((await core.request('GET', '/configs'))['mixed-port'], port, 'runtime proxy port preserved');
    assert.equal((await core.request('GET', '/configs')).tun.enable, false, 'TUN remains disabled');
    const backupNode = store.state.subscriptions[2].nodes[0].id;
    await service.command('switch', { sceneId: 'daily', nodeId: backupNode, temporary: true });
    const persisted = M.yaml(await fs.readFile(service.file, 'utf8'));
    assert.equal(persisted['proxy-groups'].find(g => g.name === 'AS_daily').proxies[0], M.nodeName(backupNode), 'switch persists first choice without reloading core');
    await service.command('restore', { sceneId: 'daily' });
    const beforeIds = new Set(store.state.rules.map(r=>r.id));
    await service.command('saveRoutingEntry',{name:'Live Chrome',processes:[],processPaths:[exactPath],domains:['live.example.test'],route:{mode:'default'}});
    const chromeEntry = store.state.rules.find(r=>!beforeIds.has(r.id));
    await service.command('saveRoutingEntry',{name:'Live Edge',processes:['msedge.exe'],processPaths:[],domains:['live.example.test'],route:{mode:'default'}});
    const edgeEntry = store.state.rules.find(r=>r.name==='Live Edge');
    const longClient = file => { const job=exec(file,[path.join(__dirname,'fixture-client.cjs'),String(port),'live.example.test','long'],{windowsHide:true,timeout:20000}).then(value=>value,error=>({error}));jobs.push(job);return job; };
    const chromeJob=longClient(exactPath),edgeJob=longClient(path.join(dir,'msedge.exe'));let own,sibling;
    for(let attempt=0;attempt<60;attempt++){const snapshot=(await core.connections()).connections||[];own=snapshot.find(c=>c.metadata.process==='chrome.exe'&&c.metadata.host==='live.example.test');sibling=snapshot.find(c=>c.metadata.process==='msedge.exe'&&c.metadata.host==='live.example.test');if(own&&sibling)break;await sleep(100);}
    assert.ok(own&&sibling,'both shared-route clients are active');assert.ok(own.chains.includes('AS_daily')&&sibling.chains.includes('AS_daily'));
    await sleep(200); await service.scheduler.sample();
    const sampled = service.view().connections.find(c => c.id === sibling.id);
    assert.equal(sampled.status, 'active'); assert.equal(sampled.subscriptionId, 'main'); assert.ok(sampled.bytes > 0);
    await service.command('switchRoutingEntry',{id:chromeEntry.id,nodeId:backupNode,reconnect:true,temporary:true});
    let remaining=[];for(let attempt=0;attempt<20;attempt++){remaining=(await core.connections()).connections||[];if(!remaining.some(c=>c.id===own.id))break;await sleep(50);}
    assert.ok(!remaining.some(c=>c.id===own.id),'only matching Chrome connection closed');assert.ok(remaining.some(c=>c.id===sibling.id),'Edge shared-route connection remains alive');
    assert.ok((await chromeJob).error,'targeted client observes actual interruption');const edgeResult=await edgeJob;assert.ok(!edgeResult.error);assert.equal(JSON.parse(edgeResult.stdout).bytes,175*16384);assert.equal(JSON.parse(edgeResult.stdout).provider,'main');
    await service.scheduler.sample();
    const ended = service.view().connections.find(c => c.id === sibling.id);
    assert.equal(ended.status, 'ended'); assert.equal(ended.bytes, sampled.bytes); assert.equal(ended.node, sampled.node); assert.equal(ended.subscription, sampled.subscription);
    assert.equal(service.view().connections.find(c => c.id === own.id).status, 'ended');
    assert.ok(!service.scheduler.connections.some(c => c.id === sibling.id));
    await service.command('switchRoutingEntry',{id:chromeEntry.id,operation:'restore'});
    await service.command('removeRoutingEntry',{id:chromeEntry.id});await service.command('removeRoutingEntry',{id:edgeEntry.id});
    const savedFile = await fs.readFile(service.file, 'utf8'); const savedState = JSON.stringify(store.state); const apply = service.core.apply.bind(service.core); let failOnce = true;
    service.core.apply = async cfg => { if (failOnce) { failOnce = false; throw Error('injected apply failure'); } return apply(cfg); };
    await assert.rejects(() => service.command('policy', { scenes: store.state.scenes, rules: state.rules, defaultSceneId: state.defaultSceneId }));
    assert.equal(await fs.readFile(service.file, 'utf8'), savedFile, 'dedicated config rolled back'); assert.equal(JSON.stringify(store.state), savedState, 'policy unchanged after failure');
    assert.ok((await core.rules()).rules.some(r => r.payload === 'new.example.test' && r.proxy === 'AS_qb'), 'live core rollback restored valid rules');
    await service.attach();
    assert.deepEqual(service.view().connections.find(c => c.id === sibling.id), ended, 'history survives reattach and removal of original entries');
    assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(sibling.id), 'observations never enter saved state');
    const tampered = { ...config, rules: ['MATCH,DIRECT'] }; await core.apply(tampered);
    await assert.rejects(() => service.command('switch', { sceneId: 'daily', nodeId: store.state.scenes[0].selected }), /规则/);
    await service.close();
    assert.deepEqual(service.view().connections, [], 'history cleared on exit');
    const version = await core.request('GET', '/version');
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({ testedAt: new Date().toISOString(), version, clients, connections, retainedDownloads, udp, sharedReconnect:{targetInterrupted:true,siblingCompletedBytes:175*16384}, retainedDownload:{id:ended.id,status:ended.status,lastObservedBytes:ended.bytes,subscription:ended.subscription,node:ended.node}, providerHits, assertions: ['isolated binary -t', 'exact full path plus domain routing', 'same-name executable at another path stays on default', 'same-name nodes', 'normalized rule ownership', 'unsupported protocol rejected', 'unsupported UDP rejects rather than falling through', 'shared route fork reconnect interrupts only matching live TCP client', 'shared sibling completes full download', 'ended download retains sampled exit and bytes through reconnect until exit', 'temporary fork restores original route', 'payload reload without global close', 'first attach with isolated Verge database', 'owned imported copy update', 'proxy port and TUN preserved', 'injected runtime failure rolls back disk/state/core', 'rule override blocks further switching'] }, null, 2));
    console.log(`Real Mihomo integration passed (${version.version}). Artifacts: ${dir}`);
  } finally { await Promise.all(jobs); if (child?.exitCode === null) { child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), sleep(2000)]); } await log?.close(); for (const s of sockets) s.destroy(); await Promise.all(servers.map(s => new Promise(r => s.close(r)))); for (const file of clientFiles) try { await fs.rm(file, { force: true }); } catch { console.warn('保留尚未释放的测试客户端'); } }
})().catch(e => { console.error(e); process.exitCode = 1; });
