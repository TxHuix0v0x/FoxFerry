'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path');
const {compare,repository,releaseUrl,assetUrl,createUpdater,cleanupInstallers}=require('../src/updates.cjs');
const metadata={repository:'https://github.com/test-fixture/foxferry-test'};
test('semantic comparison and restricted URLs',()=>{
  assert.equal(compare('v0.2.10','0.2.9'),1);assert.equal(compare('0.2.4-beta.2','0.2.4-beta.10'),-1);assert.equal(compare('0.2.4','0.2.4-beta.1'),1);
  assert.throws(()=>repository({}));assert.throws(()=>repository({repository:'https://evil.test/a/b'}));
  for(const url of ['https://github.com/other/repo/releases/tag/v1','https://github.com@test.invalid/test-fixture/foxferry-test/releases/tag/v1','file:///secret'])assert.throws(()=>releaseUrl(url,repository(metadata)));
});
test('in-app download stores the installer, reports progress and rejects foreign links',async()=>{
  const repo=metadata.repository,body=Buffer.from('DATA');
  const installer=`${repo}/releases/download/v0.2.10/FoxFerry-0.2.10-x64-setup.exe`;
  const release={tag_name:'v0.2.10',draft:false,prerelease:false,html_url:`${repo}/releases/tag/v0.2.10`,assets:[{name:'FoxFerry-0.2.10-x64-setup.exe',size:body.length,browser_download_url:installer}]};
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/download')){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':body.length});res.end(body);return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(release));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ff-update-'));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=(url,options)=>fetch(String(url).includes('/releases/download/')?`${base}/download`:base,options);
    const updater=createUpdater(metadata,'0.2.9',request);
    const found=await updater.check();assert.equal(found.downloadable,true);
    const progress=[];const file=await updater.downloadTo(dir,{onProgress:(received,total)=>progress.push([received,total])});
    assert.equal(file.name,'FoxFerry-0.2.10-x64-setup.exe');
    assert.equal(await fs.readFile(file.path,'utf8'),'DATA');
    assert.deepEqual(progress.at(-1),[4,4]);
    assert.equal(assetUrl(installer,repository(metadata)),installer);
    assert.throws(()=>assetUrl('https://evil.test/FoxFerry-0.2.10-x64-setup.exe',repository(metadata)),/下载链接无效/);
    const evil=structuredClone(release);evil.assets[0].browser_download_url='https://evil.test/FoxFerry-0.2.10-x64-setup.exe';
    const checked=await createUpdater(metadata,'0.2.9',async url=>String(url).includes('/releases/download/')?new Response('x'):new Response(JSON.stringify(evil),{headers:{'Content-Type':'application/json'}})).check();
    assert.equal(checked.downloadable,false);
    await assert.rejects(()=>createUpdater(metadata,'0.2.10',request).downloadTo(dir),/请先检查/);
  }finally{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('pending installers are removed once their version is running', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-clean-'));
  try {
    for (const name of ['FoxFerry-0.3.2-x64-setup.exe', 'FoxFerry-0.3.3-x64-setup.exe', 'partial.part', 'notes.txt']) await fs.writeFile(path.join(dir, name), 'x');
    const removed = await cleanupInstallers(dir, '0.3.3');
    assert.deepEqual(removed.sort(), ['FoxFerry-0.3.2-x64-setup.exe', 'FoxFerry-0.3.3-x64-setup.exe', 'partial.part'].sort());
    assert.deepEqual((await fs.readdir(dir)).sort(), ['notes.txt']);
    await fs.writeFile(path.join(dir, 'FoxFerry-0.3.4-x64-setup.exe'), 'x');
    assert.deepEqual(await cleanupInstallers(dir, '0.3.3'), []);
    assert.ok((await fs.readdir(dir)).includes('FoxFerry-0.3.4-x64-setup.exe'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('local HTTP: update, no downgrade, drafts, missing, limits, offline, timeout, deduplication',async()=>{
  let status=200,release={tag_name:'v0.2.10',draft:false,prerelease:false,html_url:metadata.repository+'/releases/tag/v0.2.10'},calls=0;
  const server=http.createServer((req,res)=>{calls++;res.writeHead(status,{'Content-Type':'application/json','x-ratelimit-remaining':'0'});res.end(JSON.stringify(release));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const request=(_url,options)=>fetch(`http://127.0.0.1:${server.address().port}`,options);
    const updater=createUpdater(metadata,'0.2.9',request);
    const p=updater.check();assert.equal(updater.check(),p);assert.equal((await p).status,'update');assert.equal(calls,1);assert.equal(updater.release(),release.html_url);
    assert.equal((await createUpdater(metadata,'0.3.0',request).check()).status,'current');
    release.prerelease=true;assert.equal((await updater.check()).status,'unavailable');assert.throws(()=>updater.release());release.prerelease=false;
    release.draft=true;assert.equal((await updater.check()).status,'unavailable');release.draft=false;
    status=404;assert.equal((await updater.check()).status,'unavailable');status=429;assert.match((await updater.check()).message,/限流/);
    for(const failure of [new TypeError('offline'),Object.assign(Error(),{name:'TimeoutError'})])assert.equal((await createUpdater(metadata,'0.2.9',async()=>{throw failure;}).check()).status,'error');
    assert.equal((await createUpdater({},'0.2.9',()=>{throw Error('must not connect');}).check()).status,'error');
  }finally{await new Promise(r=>server.close(r));}
});
