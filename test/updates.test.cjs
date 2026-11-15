'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {compare,repository,releaseUrl,createUpdater}=require('../src/updates.cjs');
const metadata={repository:'https://github.com/test-fixture/foxferry-test'};
test('semantic comparison and restricted URLs',()=>{
  assert.equal(compare('v0.2.10','0.2.9'),1);assert.equal(compare('0.2.4-beta.2','0.2.4-beta.10'),-1);assert.equal(compare('0.2.4','0.2.4-beta.1'),1);
  assert.throws(()=>repository({}));assert.throws(()=>repository({repository:'https://evil.test/a/b'}));
  for(const url of ['https://github.com/other/repo/releases/tag/v1','https://github.com@test.invalid/test-fixture/foxferry-test/releases/tag/v1','file:///secret'])assert.throws(()=>releaseUrl(url,repository(metadata)));
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
