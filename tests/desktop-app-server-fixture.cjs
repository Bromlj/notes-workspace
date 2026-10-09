'use strict';
// Runs as an extensionless app-server file through the signed Node executable.
// Only deterministic test data is logged. No network or account tokens are used.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const threads=new Map(),turns=new Map(),approvals=new Map();let threadNumber=0,turnNumber=0,approvalNumber=9000,sandboxReady=process.env.NOTES_FIXTURE_SANDBOX_UNCONFIGURED!=='1';
const log=p=>fs.appendFileSync(path.join(process.cwd(),'fixture-calls.jsonl'),JSON.stringify(p)+'\n');
const write=p=>process.stdout.write(JSON.stringify(p)+'\n');
const respond=(id,result)=>write({id,result});
const notify=(method,params)=>write({method,params});
const finish=(threadId,text,status='completed')=>{const t=turns.get(threadId);if(!t)return;clearTimeout(t.timer);for(const timer of t.noteTimers||[])clearTimeout(timer);turns.delete(threadId);notify('item/completed',{threadId,turnId:t.id,item:{id:t.itemId,type:'agentMessage',text}});notify('turn/completed',{threadId,turn:{id:t.id,status,items:[{id:t.itemId,type:'agentMessage',text}]}});};
function editableNote(input){
 if(!input.includes('[NOTES_WORKSPACE_EDITABLE_NOTE]'))return null;
 const match=/^Authoritative editable note file: (.+)$/m.exec(input);if(!match)throw Error('Editable note marker has no authoritative file.');
 const file=path.resolve(JSON.parse(match[1])),owned=path.resolve(process.cwd(),'..','NoteWork')+path.sep;
 if(!file.toLowerCase().startsWith(owned.toLowerCase())||path.basename(file)!=='note.txt')throw Error('Fixture refuses a note outside its isolated NoteWork directory.');
 return file;
}
function startTurn(p,id){
 const number=++turnNumber,turnId='fixture-turn-'+number,itemId='fixture-message-'+number;
 const input=(p.input||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
 const t={id:turnId,itemId,input};turns.set(p.threadId,t);respond(id,{turn:{id:turnId,status:'inProgress',items:[]}});
 const scenario=/NOTE_EDIT_FIXTURE_(VISIBLE|HIDDEN|CONFLICT|OPTOUT|TAB|UNDO|CRLF|RICH)/.exec(input)?.[1];
 if(scenario){
  const file=editableNote(input);if(!file)throw Error('Opt-in note fixture has no editable note marker.');
  const first='AI '+scenario.toLowerCase()+' revision one 487',latest=scenario==='CRLF'?'Windows first line 487\r\nWindows second line 938\r\n\r\nWindows last line 639\r\n':scenario==='RICH'?'Revised heading 487\nRevised list item 938\nRevised table column\tRevised value 639\n':'AI '+scenario.toLowerCase()+' final revision 487';
  t.noteTimers=[setTimeout(()=>fs.writeFileSync(file,first),450),setTimeout(()=>fs.writeFileSync(file,latest),scenario==='VISIBLE'?1100:2200)];
  t.timer=setTimeout(()=>finish(p.threadId,'Fixture note-edit completed '+scenario),scenario==='VISIBLE'?1500:2700);return;
 }
 setTimeout(()=>{
  if(!turns.has(p.threadId))return;
  notify('turn/plan/updated',{threadId:p.threadId,turnId,plan:[{step:'Return isolated fixture response',status:'inProgress'}]});
  notify('item/agentMessage/delta',{threadId:p.threadId,turnId,itemId,delta:'Fixture streamed response for '+p.threadId+'. '});
  if(input.includes('FIXTURE_APPROVAL')){
   const rpcId=++approvalNumber;approvals.set(rpcId,{threadId:p.threadId});
   write({id:rpcId,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId,itemId:'approval-item-'+number,cwd:p.cwd,command:'node fixture-request.cjs',reason:'Explicit disposable approval test',availableDecisions:['accept','decline','cancel']}});
  }else t.timer=setTimeout(()=>finish(p.threadId,'Fixture completed response for '+p.threadId+'\n'+input),900);
 },150);
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 let m;try{m=JSON.parse(line);}catch{return;}log(m);
 if(!m.method){const a=approvals.get(m.id);if(a){approvals.delete(m.id);finish(a.threadId,'Fixture approval was '+m.result?.decision+'.');}return;}
 const p=m.params||{};
 switch(m.method){
  case 'initialize':respond(m.id,{userAgent:'desktop-e2e-fixture',platformFamily:'windows',platformOs:'windows'});break;
  case 'initialized':break;
  case 'account/read':respond(m.id,{account:process.env.NOTES_FIXTURE_SIGNED_OUT==='1'?null:{type:'chatgpt',email:'fixture@example.invalid',planType:'pro'},requiresOpenaiAuth:true});break;
  case 'account/login/start':respond(m.id,{type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/fixture-only'});break;
  case 'account/login/cancel':respond(m.id,{status:'canceled'});break;
  case 'account/logout':respond(m.id,{});break;
  case 'windowsSandbox/readiness':respond(m.id,{status:sandboxReady?'ready':'notConfigured'});break;
  case 'windowsSandbox/setupStart':respond(m.id,{started:true});setTimeout(()=>{sandboxReady=true;notify('windowsSandbox/setupCompleted',{mode:'elevated',success:true,error:null});},150);break;
  case 'model/list':respond(m.id,{data:[{id:'fixture-codex',model:'fixture-codex',displayName:'Fixture Codex',isDefault:true,inputModalities:['text','image'],defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{id:'fixture-codex-second',model:'fixture-codex-second',displayName:'Fixture Second',isDefault:false,inputModalities:['text','image'],defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null});break;
  case 'configRequirements/read':respond(m.id,{requirements:null});break;
  case 'skills/list':respond(m.id,{data:[{cwd:p.cwds?.[0],skills:[{name:'fixture-skill',description:'Disposable fixture skill',path:path.join(process.cwd(),'SKILL.md'),enabled:true}],errors:[]}]});break;
  case 'mcpServerStatus/list':respond(m.id,{data:[],nextCursor:null});break;
  case 'app/list':respond(m.id,{data:[],nextCursor:null});break;
  case 'thread/start':{const threadId='fixture-thread-'+(++threadNumber);threads.set(threadId,{cwd:p.cwd});respond(m.id,{thread:{id:threadId,cwd:p.cwd,turns:[]}});break;}
  case 'thread/resume':threads.set(p.threadId,{cwd:p.cwd});respond(m.id,{thread:{id:p.threadId,cwd:p.cwd,turns:[]}});break;
  case 'turn/start':startTurn(p,m.id);break;
  case 'turn/steer':respond(m.id,{turnId:p.expectedTurnId});break;
  case 'turn/interrupt':respond(m.id,{});finish(p.threadId,'Fixture stopped.','interrupted');break;
  case 'thread/compact/start':respond(m.id,{});break;
  case 'review/start':startTurn({...p,input:[{type:'text',text:'Fixture review completed'}]},m.id);break;
  default:write({id:m.id,error:{code:-32601,message:'Unsupported desktop fixture method '+m.method}});
 }
});
