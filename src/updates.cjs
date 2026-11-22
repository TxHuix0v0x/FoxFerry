'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
function version(text) {
  const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text);
  if(!m)throw Error('发布版本号格式无效');return {n:m.slice(1,4).map(BigInt),pre:m[4]?.split('.')};
}
function compare(a,b) {
  const x=version(a),y=version(b);for(let i=0;i<3;i++)if(x.n[i]!==y.n[i])return x.n[i]>y.n[i]?1:-1;
  if(!x.pre||!y.pre)return x.pre? -1:y.pre?1:0;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){const p=x.pre[i],q=y.pre[i];if(p===q)continue;if(p===undefined)return -1;if(q===undefined)return 1;const pn=/^\d+$/.test(p),qn=/^\d+$/.test(q);if(pn&&qn)return BigInt(p)>BigInt(q)?1:-1;if(pn!==qn)return pn?-1:1;return p>q?1:-1;}return 0;
}
function repository(metadata) {
  const raw=typeof metadata.repository==='string'?metadata.repository:metadata.repository?.url;
  if(!raw)throw Error('项目仓库尚未配置，暂不能打开仓库或检查更新');
  const u=new URL(raw.replace(/^git\+/,''));const match=/^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u.pathname);
  if(u.protocol!=='https:'||u.hostname!=='github.com'||u.port||u.username||u.password||u.search||u.hash||!match||['.','..'].includes(match[2]))throw Error('项目仓库配置无效');
  return {url:`https://github.com/${match[1]}/${match[2]}`,slug:`${match[1]}/${match[2]}`};
}
function releaseUrl(raw,repo) {
  const u=new URL(raw);if(u.origin!=='https://github.com'||u.username||u.password||u.search||u.hash||!u.pathname.startsWith(new URL(repo.url).pathname+'/releases/tag/')||!u.pathname.split('/releases/tag/')[1])throw Error('发布链接不属于本项目');return u.href;
}
function assetUrl(raw,repo) {
  const u=new URL(raw);if(u.protocol!=='https:'||u.hostname!=='github.com'||u.port||u.username||u.password||u.search||u.hash||!u.pathname.startsWith(new URL(repo.url).pathname+'/releases/download/'))throw Error('更新下载链接无效');return u.href;
}
const INSTALLER=/^FoxFerry-\d+\.\d+\.\d+-x64-setup\.exe$/;
function createUpdater(metadata,current,request=fetch) {
  let pending,lastUrl,download;
  async function run(){lastUrl=undefined;download=undefined;try{
    const repo=repository(metadata);const response=await request(`https://api.github.com/repos/${repo.slug}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':`FoxFerry/${current}`},signal:AbortSignal.timeout(8000),redirect:'error'});
    if(response.status===404)return {status:'unavailable',message:'尚无发布版本或仓库不可访问'};
    if(response.status===429||response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||response.headers.get('retry-after')))throw Error('GitHub 请求限流，请稍后重试');
    if(!response.ok)throw Error(`仓库不可访问（HTTP ${response.status}）`);
    const reader=response.body.getReader();let text='',size=0;const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('发布响应过大');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel();}
    const release=JSON.parse(text);if(release.draft||release.prerelease)return {status:'unavailable',message:'尚无稳定发布版本'};
    const latest=release.tag_name;version(latest);if(version(latest).pre)return {status:'unavailable',message:'尚无稳定发布版本'};
    if(compare(latest,current)<=0)return {status:'current',current,latest,message:`已是最新版本（当前 ${current}，稳定版 ${latest}）`};
    lastUrl=releaseUrl(release.html_url,repo);
    const candidate=(release.assets||[]).find(asset=>INSTALLER.test(asset?.name||'')&&Number(asset.size)>0);
    if(candidate)try{download={name:candidate.name,size:Number(candidate.size),url:assetUrl(candidate.browser_download_url,repo)};}catch{download=undefined;}
    return {status:'update',current,latest,message:`有新版本：当前 ${current}，最新 ${latest}`,downloadable:!!download};
  }catch(error){return {status:'error',message:error.name==='TimeoutError'||error.name==='AbortError'?'网络超时，请稍后重试':error instanceof SyntaxError?'发布响应格式无效，请稍后重试':error instanceof TypeError?'网络连接失败，请检查网络后重试':error.message};}}
  async function downloadTo(dir,{onProgress=()=>{}}={}){
    const info=await run();
    if(info.status!=='update'||!download)throw Error('请先检查并确认有可下载的新版本');
    await fs.mkdir(dir,{recursive:true});
    const target=path.join(dir,download.name),partial=`${target}.part`;
    const response=await request(download.url,{headers:{'User-Agent':`FoxFerry/${current}`},signal:AbortSignal.timeout(600000)});
    if(!response?.ok||!response.body)throw Error(`更新下载失败（HTTP ${response?.status||'未知'}）`);
    const total=Number(response.headers?.get?.('content-length'))||download.size;
    const handle=await fs.open(partial,'w');
    let received=0;
    try{
      const reader=response.body.getReader();
      while(true){const {done,value}=await reader.read();if(done)break;received+=value.length;await handle.write(Buffer.from(value));onProgress(received,total);}
    }finally{await handle.close();}
    if(!received||(total&&received!==total)){await fs.rm(partial,{force:true});throw Error('更新下载不完整，请重试');}
    await fs.rename(partial,target);
    return {path:target,size:received,name:download.name};
  }
  return {check(){if(!pending)pending=run().finally(()=>{pending=null;});return pending;},downloadTo,repository(){return repository(metadata).url;},release(){if(!lastUrl)throw Error('请先检查并确认有新版本');return releaseUrl(lastUrl,repository(metadata));}};
}
async function cleanupInstallers(dir,current){
  let names=[];try{names=await fs.readdir(dir);}catch{return [];}
  const removed=[];
  for(const name of names){
    const match=/^FoxFerry-(\d+\.\d+\.\d+)-x64-setup\.exe$/.exec(name);
    try{
      if(name.endsWith('.part')||(match&&compare(current,match[1])>=0)){await fs.rm(path.join(dir,name),{force:true});removed.push(name);}
    }catch{/* Locked or missing files are retried on the next start. */}
  }
  return removed;
}
module.exports={compare,repository,releaseUrl,assetUrl,createUpdater,cleanupInstallers};
