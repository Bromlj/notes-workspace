'use strict';

// Main-process-only adapter. The renderer gets the fixed application commands
// in worker-runtime, never this Codex object or a general JSON-RPC transport.
const {EventEmitter}=require('node:events');
const {Codex}=require('../native/host.cjs');

function loginURL(value){
  if(typeof value!=='string'||value.length>20000)throw Error('Codex returned an invalid sign-in address.');
  let url;try{url=new URL(value);}catch{throw Error('Codex returned an invalid sign-in address.');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||!['auth.openai.com','chatgpt.com'].includes(url.hostname))throw Error('Codex returned an unrecognized sign-in address.');
  return url.href;
}
function requestID(value){if(typeof value!=='string'||!value||value.length>128)throw Error('Invalid request identifier.');return value;}

class CodexService extends EventEmitter {
  constructor(options={}){
    super();
    this.codex=options.codexInstance||new Codex({dataRoot:options.dataRoot,codexPath:options.codexPath,version:options.version||'5.1.1'});
    this.updates=new Map();this.revision=0;this.pendingLogin=null;this.loginError=null;this.sandboxPending=false;this.sandboxError=null;
    this.codex.on('update',event=>this.record(event));
    this.codex.on('disconnect',()=>{this.pendingLogin=null;if(this.sandboxPending)this.sandboxError='Codex disconnected during sandbox setup. Check again before starting work.';this.sandboxPending=false;this.emit('accountChanged');this.emit('sandboxChanged');});
    this.codex.on('accountUpdated',()=>this.emit('accountChanged'));
    this.codex.on('loginCompleted',event=>{
      if(this.pendingLogin&&event.loginId!==this.pendingLogin)return;
      this.pendingLogin=null;this.loginError=event.success?null:event.error||'Sign-in was not completed.';
      this.emit('accountChanged');
    });
    this.codex.on('sandboxSetupCompleted',event=>{
      if(event.mode!=='elevated')return;
      this.sandboxPending=false;this.sandboxError=event.success?null:event.error||'Windows sandbox setup did not complete.';
      this.emit('sandboxChanged');
    });
  }
  record(event){
    this.updates.set(event.requestId,{...event,at:++this.revision});
    if(this.updates.size>100){for(const [id,update]of this.updates){if(update.status!=='working'){this.updates.delete(id);if(this.updates.size<=100)break;}}}
    this.emit('update',event);
  }
  async invoke(action,data={}){
    try{
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid connector request.');
      let result;
      switch(action){
        case 'catalog':result=await this.codex.catalog();break;
        case 'send':case 'review':{
          const id=requestID(data.requestId);
          if(this.updates.has(id))throw Error('This request was already submitted. It will not be sent again.');
          this.record({requestId:id,status:'working',phase:action==='review'?'Starting review':'Starting',text:''});
          try{result=await this.codex[action](data);}catch(error){this.record({requestId:id,status:'failed',text:'',error:error.message});throw error;}
          break;
        }
        case 'stop':result=await this.codex.stop(data.threadId,data.requestId);break;
        case 'project':await this.codex.start();result=this.codex.project(data.path);break;
        case 'reply':result=await this.codex.reply(data);break;
        case 'steer':result=await this.codex.steer(data);break;
        case 'capabilities':result=await this.codex.capabilities(data.project);break;
        case 'compact':result=await this.codex.compact(data.threadId);break;
        case 'upload':result=await this.codex.upload(data.file);break;
        case 'removeUpload':this.codex.attachments.delete(data.fileId);result={};break;
        case 'updates':{
          if(!Array.isArray(data.ids)||data.ids.length>100)throw Error('Invalid update identifiers.');
          const ids=[...new Set(data.ids.map(requestID))];
          result={updates:ids.map(id=>this.updates.get(id)).filter(Boolean),missing:ids.filter(id=>!this.updates.has(id))};break;
        }
        default:throw Error('Unsupported connector action.');
      }
      return {ok:true,...result};
    }catch(error){return {ok:false,error:String(error?.message||error).slice(0,4000)};}
  }
  async accountStatus(){
    try{
      await this.codex.start();
      const {account}=await this.codex.rpc('account/read',{});
      return {ok:true,available:true,signedIn:account?.type==='chatgpt',accountType:account?.type||null,planType:account?.type==='chatgpt'?account.planType||null:null,loginPending:!!this.pendingLogin,error:this.loginError};
    }catch(error){return {ok:true,available:false,signedIn:false,accountType:null,planType:null,loginPending:false,error:String(error?.message||error).slice(0,1000)};}
  }
  async login(){
    try{
      if(this.codex.turns.size)throw Error('Finish or stop the active requests before changing the Codex account.');
      await this.codex.start();
      const {account}=await this.codex.rpc('account/read',{});
      if(account?.type==='chatgpt')return {ok:true,signedIn:true,loginPending:false};
      if(this.pendingLogin)throw Error('A sign-in is already open. Finish it in your browser or cancel it first.');
      this.loginError=null;
      const result=await this.codex.rpc('account/login/start',{type:'chatgpt',useHostedLoginSuccessPage:true,appBrand:'codex'});
      if(result.type!=='chatgpt'||typeof result.loginId!=='string'||!result.loginId)throw Error('Codex did not start the ChatGPT sign-in flow.');
      this.pendingLogin=result.loginId;
      let authUrl;
      try{authUrl=loginURL(result.authUrl);}catch(error){await this.cancelLogin();throw error;}
      // Main opens this validated HTTPS URL with shell.openExternal and strips
      // it from its renderer response. It contains transient OAuth state.
      return {ok:true,signedIn:false,loginPending:true,authUrl};
    }catch(error){return {ok:false,error:String(error?.message||error).slice(0,1000)};}
  }
  async cancelLogin(){
    try{
      const loginId=this.pendingLogin;if(!loginId)return {ok:true,loginPending:false};
      await this.codex.rpc('account/login/cancel',{loginId});
      this.pendingLogin=null;this.loginError=null;this.emit('accountChanged');
      return {ok:true,loginPending:false};
    }catch(error){return {ok:false,error:String(error?.message||error).slice(0,1000)};}
  }
  async logout(){
    try{
      if(this.codex.turns.size)throw Error('Finish or stop the active requests before signing out.');
      await this.codex.start();if(this.pendingLogin)await this.cancelLogin();
      await this.codex.rpc('account/logout',{});this.codex.models=null;this.loginError=null;this.emit('accountChanged');
      return {ok:true,signedIn:false};
    }catch(error){return {ok:false,error:String(error?.message||error).slice(0,1000)};}
  }
  async sandboxStatus(){
    try{
      await this.codex.start();
      const result=await this.codex.rpc('windowsSandbox/readiness',{});
      if(!['ready','notConfigured','updateRequired'].includes(result.status))throw Error('Codex returned an unrecognized Windows sandbox status.');
      return {ok:true,status:result.status,pending:this.sandboxPending,error:this.sandboxError};
    }catch(error){return {ok:true,status:'unknown',pending:this.sandboxPending,error:String(error?.message||error).slice(0,2000)};}
  }
  async setupSandbox(){
    try{
      if(this.codex.turns.size)throw Error('Finish or stop active requests before setting up the Windows sandbox.');
      if(this.sandboxPending)return {ok:true,started:false,pending:true};
      await this.codex.start();this.sandboxError=null;this.sandboxPending=true;
      // Only the official elevated setup path is exposed. No renderer-selected
      // mode, helper executable, shell command or permission override is used.
      const result=await this.codex.rpc('windowsSandbox/setupStart',{mode:'elevated'});
      if(result.started!==true)this.sandboxPending=false;
      return {ok:true,started:result.started===true,pending:this.sandboxPending};
    }catch(error){this.sandboxPending=false;this.sandboxError=String(error?.message||error).slice(0,2000);return {ok:false,error:this.sandboxError};}
  }
  close(){this.codex.close();}
}
function createService(options){return new CodexService(options);}
module.exports={createService,CodexService,loginURL};
