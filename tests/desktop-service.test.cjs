'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createService,loginURL}=require('../desktop/codex-service.cjs');
const {Codex}=require('../native/host.cjs');

class FixtureCodex extends EventEmitter {
  constructor(){super();this.turns=new Map();this.attachments=new Map();this.calls=[];this.account=null;this.loginResult={type:'chatgpt',loginId:'pending-id',authUrl:'https://auth.openai.com/oauth/authorize?state=transient'};}
  async start(){this.calls.push('start');}
  async rpc(method,params){this.calls.push({method,params});if(method==='account/read')return {account:this.account};if(method==='account/login/start')return this.loginResult;if(method==='windowsSandbox/readiness')return {status:this.sandboxReadiness||'notConfigured'};if(method==='windowsSandbox/setupStart')return {started:true};return {};}
  async send(data){this.calls.push({send:data});return {threadId:'thread',turnId:'turn'};}
  async review(data){this.calls.push({review:data});return {threadId:'thread',turnId:'review'};}
  async catalog(){return {models:[],accountType:'chatgpt'};}
  close(){this.closed=true;}
}
function fixture(){const codex=new FixtureCodex();return {codex,service:createService({codexInstance:codex})};}

test('desktop service only exposes fixed connector actions',async()=>{
  const {codex,service}=fixture();
  for(const action of ['account/logout','exec','rpc','constructor'])assert.equal((await service.invoke(action,{method:'turn/start'})).ok,false);
  assert.deepEqual(codex.calls,[]);
  assert.equal((await service.invoke('updates',null)).ok,false);
});
test('duplicate submissions cannot be resent as a send or review',async()=>{
  const {codex,service}=fixture();
  assert.equal((await service.invoke('send',{requestId:'id'})).ok,true);
  assert.equal((await service.invoke('send',{requestId:'id'})).ok,false);
  assert.equal((await service.invoke('review',{requestId:'id'})).ok,false);
  assert.equal(codex.calls.filter(x=>x.send).length,1);
});
test('updates preserve completion and list missing ids without creating jobs',async()=>{
  const {codex,service}=fixture();
  await service.invoke('send',{requestId:'run'});
  codex.emit('update',{requestId:'run',status:'completed',text:'Done'});
  const result=await service.invoke('updates',{ids:['run','absent','run']});
  assert.equal(result.updates.length,1);assert.equal(result.updates[0].text,'Done');assert.equal(result.updates[0].status,'completed');assert.deepEqual(result.missing,['absent']);
  assert.equal((await service.invoke('updates',{ids:new Array(101).fill('run')})).ok,false);
  assert.equal((await service.invoke('send',{requestId:undefined})).ok,false);
});
test('account status excludes email and identity tokens',async()=>{
  const {codex,service}=fixture();codex.account={type:'chatgpt',email:'private@example.invalid',planType:'plus',accessToken:'secret'};
  assert.deepEqual(await service.accountStatus(),{ok:true,available:true,signedIn:true,accountType:'chatgpt',planType:'plus',loginPending:false,error:null});
  codex.account={type:'apiKey'};assert.equal((await service.accountStatus()).signedIn,false);
  codex.account=null;assert.equal((await service.accountStatus()).signedIn,false);
});
test('ChatGPT login uses the documented managed browser flow and cannot be started twice',async()=>{
  const {codex,service}=fixture();let changed=0;service.on('accountChanged',()=>changed++);
  const result=await service.login();assert.equal(result.ok,true);assert.equal(result.authUrl,codex.loginResult.authUrl);
  assert.deepEqual(codex.calls.find(x=>x.method==='account/login/start').params,{type:'chatgpt',useHostedLoginSuccessPage:true,appBrand:'codex'});
  assert.equal((await service.login()).ok,false);
  codex.emit('loginCompleted',{loginId:'stale',success:true});assert.equal(service.pendingLogin,'pending-id');
  codex.emit('loginCompleted',{loginId:'pending-id',success:true});assert.equal(service.pendingLogin,null);assert.equal(changed,1);
});
test('login URL accepts only official HTTPS authentication origins',()=>{
  assert.equal(loginURL('https://chatgpt.com/auth/login'),'https://chatgpt.com/auth/login');
  for(const url of ['http://auth.openai.com/','file:///C:/private','https://auth.openai.com.evil.invalid/','https://user:pass@auth.openai.com/','https://auth.openai.com:444/','https://example.invalid/','javascript:alert(1)'])assert.throws(()=>loginURL(url));
});
test('unrecognized browser login address cancels the pending login',async()=>{
  const {codex,service}=fixture();codex.loginResult.authUrl='https://example.invalid/';
  assert.equal((await service.login()).ok,false);assert.equal(service.pendingLogin,null);
  assert.deepEqual(codex.calls.find(x=>x.method==='account/login/cancel').params,{loginId:'pending-id'});
});
test('account switches are blocked while work is active and signed-in login is a no-op',async()=>{
  const {codex,service}=fixture();codex.turns.set('thread',{});
  assert.equal((await service.login()).ok,false);assert.equal((await service.logout()).ok,false);assert.deepEqual(codex.calls,[]);
  codex.turns.clear();codex.account={type:'chatgpt'};assert.equal((await service.login()).signedIn,true);assert.equal(codex.calls.some(x=>x.method==='account/login/start'),false);
});
test('host handles auth notifications without a turn and redacts unused fields',()=>{
  const codex=new Codex(),events=[];codex.models=['old'];codex.on('accountUpdated',event=>events.push(event));codex.on('loginCompleted',event=>events.push(event));
  codex.message({method:'account/updated',params:{authMode:'chatgpt',planType:'plus',email:'private@example.invalid',accessToken:'secret'}});
  codex.message({method:'account/login/completed',params:{loginId:'id',success:true,error:null,accessToken:'secret'}});
  assert.equal(codex.models,null);assert.deepEqual(events,[{authMode:'chatgpt',planType:'plus'},{loginId:'id',success:true,error:null}]);
});
test('Windows sandbox setup uses only the official elevated path and reports completion',async()=>{
  const {codex,service}=fixture();
  assert.deepEqual(await service.sandboxStatus(),{ok:true,status:'notConfigured',pending:false,error:null});
  assert.deepEqual(await service.setupSandbox(),{ok:true,started:true,pending:true});
  assert.deepEqual(codex.calls.find(x=>x.method==='windowsSandbox/setupStart').params,{mode:'elevated'});
  assert.deepEqual(await service.setupSandbox(),{ok:true,started:false,pending:true});
  assert.equal(codex.calls.filter(x=>x.method==='windowsSandbox/setupStart').length,1);
  codex.sandboxReadiness='ready';codex.emit('sandboxSetupCompleted',{mode:'elevated',success:true,error:null});
  assert.deepEqual(await service.sandboxStatus(),{ok:true,status:'ready',pending:false,error:null});
});
test('Windows sandbox setup does not interrupt work or fall back to reduced isolation',async()=>{
  const {codex,service}=fixture();codex.turns.set('thread',{});
  assert.equal((await service.setupSandbox()).ok,false);assert.deepEqual(codex.calls,[]);
  codex.turns.clear();await service.setupSandbox();codex.emit('sandboxSetupCompleted',{mode:'elevated',success:false,error:'User cancelled Windows setup.'});
  assert.equal((await service.sandboxStatus()).error,'User cancelled Windows setup.');
  assert.equal(codex.calls.some(x=>x.params?.mode==='unelevated'),false);
  await service.setupSandbox();codex.emit('disconnect','Disconnected');assert.equal(service.sandboxPending,false);
  assert.match((await service.sandboxStatus()).error,/disconnected during sandbox setup/);
});
test('host reports sandbox setup completion without requiring a running conversation',()=>{
  const codex=new Codex(),events=[];codex.on('sandboxSetupCompleted',event=>events.push(event));
  codex.message({method:'windowsSandbox/setupCompleted',params:{mode:'elevated',success:false,error:'Cancelled',internal:'ignored'}});
  assert.deepEqual(events,[{mode:'elevated',success:false,error:'Cancelled'}]);
});
