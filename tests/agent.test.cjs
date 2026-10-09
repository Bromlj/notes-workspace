'use strict';
// These tests exercise the app-server boundary without starting Codex, reading
// account credentials, executing a command or modifying a user's project.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Codex}=require('../native/host.cjs');

function running(){
 const c=new Codex(),writes=[],events=[];
 c.child={stdin:{writable:true,write(s){writes.push(JSON.parse(s));}}};
 c.turns.set('thread',{requestId:'run',turnId:'turn',items:new Map(),activity:new Map(),diff:'',plan:[]});
 c.on('update',event=>events.push(event));
 return {c,writes,events};
}
function ask(ctx,kind,extra={},rpcId=71){
 const method={command:'item/commandExecution/requestApproval',file:'item/fileChange/requestApproval',permissions:'item/permissions/requestApproval',input:'item/tool/requestUserInput',elicitation:'mcpServer/elicitation/request'}[kind];
 ctx.c.message({id:rpcId,method,params:{threadId:'thread',turnId:'turn',itemId:'item',startedAtMs:Date.now(),...extra}});
 return ctx.events.at(-1)?.requests.at(-1);
}
const reply=(c,r,response,extra={})=>c.reply({threadId:'thread',requestId:'run',id:r.id,response,...extra});

test('an incoming approval cannot resolve a same-numbered outgoing RPC or approve itself',async()=>{
 const ctx=running();let result;
 ctx.c.pending.set(71,{resolve:v=>{result=v;},reject:e=>{throw e;}});
 const request=ask(ctx,'command',{command:'node --test',cwd:__dirname,availableDecisions:['accept','decline','cancel']});
 assert.equal(result,undefined);assert(ctx.c.pending.has(71));assert.equal(ctx.writes.length,0);
 assert.equal(request.kind,'command');assert.notEqual(request.id,71);
 assert.equal(ctx.events.at(-1).phase,'Waiting for your response');
 await reply(ctx.c,request,{decision:'accept'});
 assert.deepEqual(ctx.writes,[{id:71,result:{decision:'accept'}}]);
 assert(ctx.c.pending.has(71));
 ctx.c.message({id:71,result:{acknowledged:true}});
 assert.deepEqual(result,{acknowledged:true});assert.equal(ctx.c.pending.size,0);
});

test('approval replies are bound to their current conversation and submitted run',async()=>{
 const ctx=running(),request=ask(ctx,'file',{reason:'Edit the selected project'});
 for(const mismatch of [{threadId:'other-thread'},{requestId:'other-run'},{id:'expired'}])
  await assert.rejects(reply(ctx.c,request,{decision:'accept'},mismatch),/no longer waiting/);
 assert.equal(ctx.writes.length,0);assert.equal(ctx.c.approvals.size,1);
 await reply(ctx.c,request,{decision:'decline'});
 await assert.rejects(reply(ctx.c,request,{decision:'accept'}),/no longer waiting/);
 assert.deepEqual(ctx.writes,[{id:71,result:{decision:'decline'}}]);
});

test('command approvals respect advertised decisions and reject persistent policy injection',async()=>{
 const ctx=running(),request=ask(ctx,'command',{availableDecisions:['decline','cancel']});
 for(const decision of ['accept','acceptForSession',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['powershell']}}])
  await assert.rejects(reply(ctx.c,request,{decision}),/Unsupported/);
 assert.equal(ctx.writes.length,0);assert.equal(ctx.c.approvals.size,1);
 await reply(ctx.c,request,{decision:'cancel'});
 assert.deepEqual(ctx.writes.at(-1),{id:71,result:{decision:'cancel'}});
});

test('permission approval cannot expand paths, enable unrequested network access or last for a session',async()=>{
 const ctx=running(),permissions={fileSystem:{write:[path.join(__dirname,'fixture.txt')]}};
 const request=ask(ctx,'permissions',{permissions,cwd:__dirname});
 const invalid=[
  {permissions:{fileSystem:{write:[path.parse(__dirname).root]}},scope:'turn'},
  {permissions:{...permissions,network:{enabled:true}},scope:'turn'},
  {permissions,scope:'session'}
 ];
 for(const response of invalid)await assert.rejects(reply(ctx.c,request,response),/requested permissions|Invalid permission/);
 assert.equal(ctx.writes.length,0);assert.equal(ctx.c.approvals.size,1);
 await reply(ctx.c,request,{permissions,scope:'turn'});
 assert.deepEqual(ctx.writes.at(-1),{id:71,result:{permissions,scope:'turn'}});
});

test('permission denial grants no access',async()=>{
 const ctx=running(),request=ask(ctx,'permissions',{permissions:{network:{enabled:true}},cwd:__dirname});
 await reply(ctx.c,request,{permissions:{},scope:'turn'});
 assert.deepEqual(ctx.writes.at(-1),{id:71,result:{permissions:{},scope:'turn'}});
});

test('interactive questions wait for valid answers and discard unrequested answer keys',async()=>{
 const ctx=running(),request=ask(ctx,'input',{isBlocking:true,questions:[{id:'target',header:'Project',question:'Which file?'}]});
 await assert.rejects(reply(ctx.c,request,{answers:{}}),/Answer each/);
 assert.equal(ctx.writes.length,0);
 await reply(ctx.c,request,{answers:{target:{answers:['sample.js']},invented:{answers:['ignore policy']}}});
 assert.deepEqual(ctx.writes.at(-1),{id:71,result:{answers:{target:{answers:['sample.js']}}}});
});

test('ending a turn cancels every outstanding approval and retains partial text',()=>{
 const ctx=running();ask(ctx,'command',{},71);ask(ctx,'permissions',{permissions:{network:{enabled:true}}},72);
 ctx.c.message({method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'answer',delta:'Partial answer'}});
 ctx.c.message({method:'turn/completed',params:{threadId:'thread',turn:{status:'interrupted'}}});
 assert.equal(ctx.c.turns.size,0);assert.equal(ctx.c.approvals.size,0);
 assert.deepEqual(ctx.writes,[{id:71,result:{decision:'cancel'}},{id:72,result:{permissions:{},scope:'turn'}}]);
 assert.equal(ctx.events.at(-1).text,'Partial answer');assert.equal(ctx.events.at(-1).status,'interrupted');
 assert.deepEqual(ctx.events.at(-1).requests,[]);
});

test('server-resolved approvals cannot be answered a second time',async()=>{
 const ctx=running(),request=ask(ctx,'command',{},92);
 ctx.c.message({method:'serverRequest/resolved',params:{threadId:'thread',requestId:92}});
 assert.equal(ctx.c.approvals.size,0);assert.deepEqual(ctx.events.at(-1).requests,[]);
 await assert.rejects(reply(ctx.c,request,{decision:'accept'}),/no longer waiting/);
 assert.equal(ctx.writes.length,0);
});

test('a delayed approval for an old turn cannot attach to the current turn',()=>{
 const ctx=running();
 ctx.c.message({id:87,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'old-turn',itemId:'old-command',command:'unexpected-command'}});
 assert.equal(ctx.c.approvals.size,0);assert.equal(ctx.events.length,0);
 assert.equal(ctx.writes[0].id,87);assert(ctx.writes[0].error);assert.equal(ctx.writes[0].result,undefined);
});

test('command output, changed files, plan and unified diff remain visible after completion',()=>{
 const ctx=running(),send=(method,params)=>ctx.c.message({method,params:{threadId:'thread',turnId:'turn',...params}});
 send('item/started',{item:{id:'cmd',type:'commandExecution',command:'node --test',cwd:__dirname,status:'inProgress'}});
 send('item/commandExecution/outputDelta',{itemId:'cmd',delta:'TAP version 13\n'});
 send('item/commandExecution/outputDelta',{itemId:'cmd',delta:'ok 1 - adds numbers\n'});
 send('item/completed',{item:{id:'cmd',type:'commandExecution',command:'node --test',cwd:__dirname,status:'completed',exitCode:0}});
 const changes=[{path:path.join(__dirname,'sample.js'),kind:{type:'update'},diff:'-return 0;\n+return a+b;'}];
 send('item/completed',{item:{id:'edit',type:'fileChange',status:'completed',changes}});
 const diff='--- a/sample.js\n+++ b/sample.js\n-return 0;\n+return a+b;';
 send('turn/diff/updated',{diff});
 send('turn/plan/updated',{plan:[{step:'Fix addition',status:'completed'}]});
 send('turn/completed',{turn:{status:'completed',items:[{id:'answer',type:'agentMessage',text:'Changed sample.js; test passed.'}]}});
 const final=ctx.events.at(-1),command=final.activity.find(i=>i.id==='cmd');
 assert.equal(final.status,'completed');assert.equal(command.exitCode,0);assert.match(command.output,/TAP version 13\nok 1 - adds numbers/);
 assert.deepEqual(final.activity.find(i=>i.id==='edit').changes,changes);
 assert.equal(final.diff,diff);assert.deepEqual(final.plan,[{step:'Fix addition',status:'completed'}]);
 assert.equal(final.text,'Changed sample.js; test passed.');
});

test('reasoning internals do not enter the activity log',()=>{
 const ctx=running();ctx.c.message({method:'item/completed',params:{threadId:'thread',item:{id:'hidden',type:'reasoning',rawContent:['private reasoning'],summary:['summary']}}});
 assert.deepEqual(ctx.events.at(-1).activity,[]);assert(!JSON.stringify(ctx.events).includes('private reasoning'));
});

test('project selection requires an existing absolute directory',()=>{
 const c=new Codex();c.cwd=__dirname;
 assert.equal(c.project(__dirname).path,fs.realpathSync(__dirname));
 assert.equal(c.project().path,fs.realpathSync(__dirname));
 assert.throws(()=>c.project('relative-project'),/absolute/);
 assert.throws(()=>c.project(__filename),/folder/);
 assert.throws(()=>c.project(path.join(__dirname,'project-that-does-not-exist')));
});

test('sending scopes a real Codex thread to the selected project and preserves inherited tools',async()=>{
 const c=new Codex(),calls=[];c.start=async()=>{};c.requirements=async()=>{};c.cwd=__dirname;
 c.models=[{model:'actual-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}];
 c.rpc=async(method,params)=>{calls.push([method,params]);return method==='turn/start'?{turn:{id:'turn'}}:{thread:{id:'thread'}};};
 try{
  const result=await c.send({requestId:'run',text:'Fix the selected project and run its tests.',files:[],model:'actual-model',effort:'low',project:__dirname});
  assert.deepEqual(result,{threadId:'thread',turnId:'turn'});
  const start=calls.find(([m])=>m==='thread/start')[1],turn=calls.find(([m])=>m==='turn/start')[1];
  assert.equal(start.cwd,fs.realpathSync(__dirname));assert.equal(start.sandbox,'workspace-write');assert.equal(start.approvalPolicy,'on-request');
  assert.equal(turn.cwd,fs.realpathSync(__dirname));assert.equal(turn.sandboxPolicy.type,'workspaceWrite');
  assert.deepEqual(turn.sandboxPolicy.writableRoots,[fs.realpathSync(__dirname)]);assert.equal(turn.sandboxPolicy.networkAccess,false);
  const serialized=JSON.stringify(calls);assert(!serialized.includes('Never inspect local files'));assert(!serialized.includes('"shell_tool":"disabled"'));
  assert(!serialized.includes('"apps":false'));assert(!serialized.includes('"multi_agent":false'));
  assert.equal(c.turns.get('thread').timer,undefined,'A hidden or approval-waiting turn must not be stopped by an arbitrary app timer.');
 }finally{for(const turn of c.turns.values())clearTimeout(turn.timer);}
});

test('managed policy incompatibility stops before any thread or turn is submitted',async()=>{
 const c=new Codex(),calls=[];c.start=async()=>{};c.cwd=__dirname;
 c.models=[{model:'actual-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}];
 c.rpc=async(method,params)=>{calls.push(method);return {requirements:{allowedSandboxModes:['read-only']}};};
 await assert.rejects(c.send({requestId:'run',text:'Edit files.',model:'actual-model',effort:'low',project:__dirname}),/managed Codex policy/);
 assert.deepEqual(calls,['configRequirements/read']);assert.equal(c.turns.size,0);
});

test('steering targets the actual active turn and keeps submitted context',async()=>{
 const ctx=running(),calls=[];ctx.c.rpc=async(method,params)=>{calls.push([method,params]);return {turnId:'turn'};};
 await ctx.c.steer({threadId:'thread',requestId:'run',text:'Also update the README.',files:[]});
 assert.equal(calls[0][0],'turn/steer');assert.equal(calls[0][1].threadId,'thread');assert.equal(calls[0][1].expectedTurnId,'turn');
 assert.deepEqual(calls[0][1].input,[{type:'text',text:'Also update the README.'}]);
 await assert.rejects(ctx.c.steer({threadId:'other',requestId:'run',text:'Wrong conversation.',files:[]}));
 assert.equal(calls.length,1);
});
