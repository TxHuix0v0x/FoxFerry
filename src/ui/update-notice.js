'use strict';
class UpdateNotice {
  constructor({request,isSettings,document:doc=globalThis.document,now=Date.now,setTimer=(fn,delay)=>setTimeout(fn,delay),clearTimer=id=>clearTimeout(id)}) { Object.assign(this,{request,isSettings,doc,now,setTimer,clearTimer});this.token=0;this.busy=false;this.result=null;this.remaining=0;this.held={}; }
  leave(){this.token++;this.clearTimer(this.timer);this.timer=null;this.busy=false;this.result=null;this.remaining=0;this.held={};this.paint();}
  paint(){const box=this.doc?.getElementById('update-result'),button=this.doc?.getElementById('updates-button');if(button){button.disabled=this.busy;button.setAttribute('aria-busy',String(this.busy));}if(!box)return;box.hidden=!this.result;this.doc.getElementById('update-text').textContent=this.result?.message||'';this.doc.getElementById('release-button').hidden=this.result?.status!=='update';}
  hold(kind,value){this.pause();this.held[kind]=value;this.resume();}
  pause(){if(this.timer){this.remaining=Math.max(0,this.remaining-(this.now()-this.started));this.clearTimer(this.timer);this.timer=null;}}
  resume(){if(!this.result||Object.values(this.held).some(Boolean))return;if(!this.remaining){if(!['checking','update'].includes(this.result.status))this.leave();return;}this.started=this.now();this.timer=this.setTimer(()=>this.leave(),this.remaining);}
  async check(){if(this.busy||!this.isSettings())return;this.leave();const token=this.token;this.busy=true;this.result={status:'checking',message:'正在检查更新…'};this.paint();let result;try{result=await this.request();}catch(error){result={status:'error',message:'检查失败：'+error.message};}if(token!==this.token||!this.isSettings())return;this.busy=false;this.result=result;this.remaining=result.status==='update'?0:result.status==='error'?8000:5000;const box=this.doc?.getElementById('update-result');this.held={hover:!!box?.matches(':hover'),focus:!!box?.contains(this.doc?.activeElement)};this.paint();this.resume();}
}
if(typeof module!=='undefined')module.exports={UpdateNotice};
