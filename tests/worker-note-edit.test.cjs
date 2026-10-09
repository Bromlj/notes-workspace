'use strict';
// Exercise the actual extension worker through the production desktop adapter.
// Native Codex and the renderer protocol are fixtures; no account is accessed.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createRuntime,ORIGIN}=require('../desktop/worker-runtime.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=7000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error('Timed out: '+label);await pause(20);}}
async function fixture(initial){
  const folder=fs.mkdtempSync(path.join(__dirname,'worker-note-edit-'));
  const dataFile=path.join(folder,'notes.json');if(initial)fs.writeFileSync(dataFile,JSON.stringify(initial));
  const tab={id:1,windowId:1,url:ORIGIN+'/editor.html',active:true,mutedInfo:{muted:false},autoDiscardable:false};
  const calls=[],messages=[],latest=new Map(),seen=new Map();let clock=0,visible=false,doc,latch=null,proposalMode='accept',delayUntil=0,delivery=Promise.resolve();
  const windows={async get(id){return id===1?tab:null;},async list(){return [tab];},async create(){return tab;},async update(id,changes){Object.assign(tab,changes);return tab;},async remove(){},async openSettings(){},async save(){return 1;}};
  const native=async(action,data)=>{
    calls.push({action,data});
    if(action==='catalog')return {ok:true,defaultProject:folder,models:[{model:'fixture',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
    if(action==='send')return {ok:true,threadId:'fixture-thread',turnId:'fixture-turn'};
    if(action==='updates'){const updates=data.ids.map(id=>latest.get(id)).filter(Boolean);for(const update of updates)seen.set(update.requestId,update.at);return {ok:true,updates,missing:[]};}
    return {ok:true};
  };
  const runtime=createRuntime({uiRoot:path.join(__dirname,'..','extension'),dataFile,native,windows});
  function receive(message){
    messages.push(message);let result={ok:true};
    if(message.type==='AI_MODE')visible=true;
    if(['COVER','CANCEL_RESTORE'].includes(message.type))visible=false;
    if(message.type==='NOTE_AI_PROPOSE'){
      if(!visible)result={ok:false,accepted:false,reason:'hidden'};
      else if(doc.revision!==message.expectedRevision||doc.text!==message.expectedText||doc.html!==message.expectedHtml)result={ok:false,accepted:false,reason:'local_changes'};
      else{doc.text=message.text;doc.html='<div>'+message.text+'</div>';latch=message.editRequestId;result={ok:true,accepted:true,note:{id:doc.id,text:doc.text,html:proposalMode==='invalid'?12:doc.html}};}
    }
    if(['NOTE_AI_COMMITTED','NOTE_AI_FAILED'].includes(message.type)&&latch===message.editRequestId){if(Number.isSafeInteger(message.revision))doc.revision=message.revision;latch=null;}
    void runtime.receive(1,{replyTo:message.requestId,result});
  }
  await runtime.connect(1,message=>{delivery=delivery.then(async()=>{if(delayUntil>Date.now())await pause(delayUntil-Date.now());receive(message);});});
  const ready=await runtime.request('EDITOR_READY',{}, {id:1,url:tab.url});assert.equal(ready.ok,true);doc={...ready.note};let assistantId=ready.assistant.id;
  const request=async(type,data={})=>runtime.request(type,{assistantId,...data},{id:1,url:tab.url});
  const assistant=()=>runtime.snapshot()['assistant:'+assistantId];
  const note=()=>runtime.snapshot()['note:'+doc.id];
  const publish=async(id,edit,status='working')=>{const at=++clock;latest.set(id,{requestId:id,at,status,text:'Fixture answer',noteEdit:edit});await until(()=>seen.get(id)===at,'native update polled');await pause(10);await request('AI_READY');};
  const send=async()=>{const id=randomUUID(),response=await request('AI_SEND',{id,text:'Revise this note.'});assert.equal(response.ok,true,response.error);await until(()=>calls.some(x=>x.action==='send'&&x.data.requestId===id),'native send');return id;};
  return {runtime,calls,messages,request,assistant,note,publish,send,folder,get doc(){return doc;},get assistantId(){return assistantId;},get visible(){return visible;},get latch(){return latch;},async reveal(){const r=await request('RESUME',{token:randomUUID()});assert.equal(r.ok,true,r.error);},async hide(){const r=await request('HIDE');assert.equal(r.ok,true,r.error);},async manual(text){doc.text=text;doc.html='<p>'+text+'</p>';const r=await request('SAVE_NOTE',{note:doc});assert.equal(r.ok,true,r.error);doc={...r.note};},async newNote(text=''){const r=await request('NEW_NOTE',{text});assert.equal(r.ok,true,r.error);doc={...r.note};assistantId=r.assistant.id;return r;},setProposalMode(value){proposalMode=value;},delayRenderer(ms){delayUntil=Date.now()+ms;},async close(){await delivery;await runtime.close();const target=path.resolve(folder),root=path.resolve(__dirname);assert(target.startsWith(root+path.sep));fs.rmSync(target,{recursive:true,force:true});}};
}
test('note editing stages preserve privacy, conflicts and note/chat bindings',async t=>{
  const f=await fixture();t.after(()=>f.close());await f.reveal();
  await t.test('ordinary AI submission does not receive the notepad text',async()=>{assert.equal(f.assistant().editNote,false);await f.manual('Original note');const id=await f.send();assert(!Object.hasOwn(f.calls.find(x=>x.action==='send'&&x.data.requestId===id).data,'noteEdit'));await f.publish(id,null,'completed');});
  let id,base;
  await t.test('explicit permission supplies the exact saved baseline',async()=>{assert.equal((await f.request('AI_NOTE_EDIT_SET',{enabled:true})).ok,true);base={...f.doc};id=await f.send();assert.deepEqual(f.calls.find(x=>x.action==='send'&&x.data.requestId===id).data.noteEdit,{noteId:base.id,text:base.text,revision:base.revision});});
  await t.test('hidden writes stage without changing the ordinary note or renderer',async()=>{await f.hide();await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:1,text:'Hidden revision'});assert.equal(f.note().text,base.text);assert.equal(f.doc.text,base.text);assert.equal(f.assistant().noteEditStage.text,'Hidden revision');assert(!f.messages.some(m=>m.type==='NOTE_AI_PROPOSE'));});
  await t.test('reveal catches up once and separates run IDs from transport counters',async()=>{await f.reveal();const r=await f.request('AI_NOTE_SYNC');assert.equal(r.applied,true);assert.equal(f.note().text,'Hidden revision');assert.equal(f.note().revision,base.revision+1);assert.equal(f.doc.revision,f.note().revision);assert.equal(f.latch,null);const proposal=f.messages.find(m=>m.type==='NOTE_AI_PROPOSE');assert.equal(proposal.editRequestId,id);assert.equal(typeof proposal.requestId,'number');assert(f.messages.some(m=>m.type==='NOTE_AI_COMMITTED'&&m.editRequestId===id));});
  await t.test('automatic proposals never carry explicit replacement consent',()=>{assert.equal(f.messages.find(m=>m.type==='NOTE_AI_PROPOSE').confirmed,false);});
  await t.test('duplicate, stale-baseline and wrong-note snapshots cannot replace the accepted revision',async()=>{for(const edit of [{noteId:base.id,baseRevision:base.revision,sequence:1,text:'Duplicate'},{noteId:randomUUID(),baseRevision:base.revision,sequence:2,text:'Wrong note'},{noteId:base.id,baseRevision:base.revision+1,sequence:2,text:'Wrong base'}])await f.publish(id,edit);assert.equal(f.note().text,'Hidden revision');assert.equal(f.assistant().noteEditStage.sequence,1);});
  await t.test('manual edits win until the user explicitly applies the staged revision',async()=>{await f.manual('My manual change');await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:2,text:'New AI revision'});assert.equal(f.note().text,'My manual change');assert.equal(f.doc.text,'My manual change');assert.equal(f.assistant().noteEditStage.conflict,true);const r=await f.request('AI_NOTE_APPLY',{force:true});assert.equal(r.applied,true);assert.equal(f.doc.text,'New AI revision');});
  await t.test('discard rejects the same snapshot but allows a genuinely later revision',async()=>{await f.hide();await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:3,text:'Discard me'});await f.reveal();await f.request('AI_NOTE_DISCARD');assert.equal(f.assistant().noteEditStage,null);await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:3,text:'Discard me again'});assert.equal(f.assistant().noteEditStage,null);await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:4,text:'Later revision'});assert.equal(f.assistant().noteEditStage.text,'Later revision');assert.equal(f.assistant().noteEditStage.conflict,false);assert.equal(f.doc.text,'Later revision');});
  await t.test('disabling permission permanently revokes this accepted run',async()=>{await f.request('AI_NOTE_EDIT_SET',{enabled:false});await f.request('AI_NOTE_EDIT_SET',{enabled:true});await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:5,text:'Revoked revision'},'completed');assert.equal(f.note().text,'Later revision');assert.equal(f.assistant().pending,null);});
  await t.test('a new note has an independent chat and editing starts disabled',async()=>{const previous=f.assistantId,r=await f.newNote('Second note');assert.notEqual(r.assistant.id,previous);assert.equal(r.assistant.noteId,r.note.id);assert.equal(r.assistant.editNote,false);assert.equal(f.doc.text,'Second note');});
});
test('malformed accepted renderer edits release the commit latch without overwriting canonical content',async t=>{
  const f=await fixture();t.after(()=>f.close());await f.reveal();await f.manual('Canonical note');await f.request('AI_NOTE_EDIT_SET',{enabled:true});const base={...f.doc},id=await f.send();f.setProposalMode('invalid');await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:1,text:'Uncommitted AI text'},'completed');assert.equal(f.note().text,'Canonical note');assert.equal(f.note().revision,base.revision);assert.equal(f.latch,null);assert.equal(f.assistant().noteEditStage.conflict,true);const failed=f.messages.find(m=>m.type==='NOTE_AI_FAILED');assert.equal(failed.editRequestId,id);assert.equal(failed.revision,base.revision);
});
test('a delayed renderer receives failure after a timed-out proposal and can release its late latch',async t=>{
  const f=await fixture();t.after(()=>f.close());await f.reveal();await f.manual('Durable note');await f.request('AI_NOTE_EDIT_SET',{enabled:true});const base={...f.doc},id=await f.send();f.delayRenderer(4500);await f.publish(id,{noteId:base.id,baseRevision:base.revision,sequence:1,text:'Late visible proposal'},'completed');assert.equal(f.note().text,'Durable note');assert.equal(f.latch,null);assert.equal(f.assistant().noteEditStage.conflict,true);assert(f.messages.some(m=>m.type==='NOTE_AI_FAILED'&&m.editRequestId===id));
});
test('an imported pending note preview needs permission and explicit Apply',async t=>{
  const noteId=randomUUID(),assistantId=randomUUID(),requestId=randomUUID();
  const initial={['note:'+noteId]:{id:noteId,text:'Original',html:'',revision:0},['assistant:'+assistantId]:{id:assistantId,agentVersion:4,noteId,messages:[],editNote:false,pending:null,noteEditStage:{requestId,text:'Imported revision',sequence:1,baseRevision:0,baseText:'Original',baseHtml:'',conflict:true,requiresApply:true}},['noteAssistant:'+noteId]:assistantId,lastNoteId:noteId};
  const f=await fixture(initial);t.after(()=>f.close());await f.reveal();assert.equal((await f.request('AI_NOTE_SYNC')).reason,'disabled');await f.request('AI_NOTE_EDIT_SET',{enabled:true});assert.equal((await f.request('AI_NOTE_SYNC')).reason,'explicit_apply');assert.equal(f.note().text,'Original');assert.equal((await f.request('AI_NOTE_APPLY',{force:true})).applied,true);assert.equal(f.note().text,'Imported revision');assert(!Object.hasOwn(f.assistant().noteEditStage,'requiresApply'));
});
function preview(text='Pending revision'){
  const noteId=randomUUID(),assistantId=randomUUID(),requestId=randomUUID();
  return {['note:'+noteId]:{id:noteId,text:'Original note',html:'<b>Original note</b>',revision:2},['assistant:'+assistantId]:{id:assistantId,agentVersion:4,noteId,messages:[],editNote:false,pending:null,noteEditStage:{requestId,text,sequence:1,baseRevision:2,baseText:'Original note',baseHtml:'<b>Original note</b>',conflict:true,requiresApply:true}},['noteAssistant:'+noteId]:assistantId,lastNoteId:noteId};
}
test('confirmed Apply is one-time consent while automatic note editing remains off',async t=>{
  const f=await fixture(preview());t.after(()=>f.close());await f.reveal();
  assert.equal((await f.request('AI_NOTE_SYNC')).reason,'disabled');
  assert.equal((await f.request('AI_NOTE_SYNC',{force:true})).reason,'disabled');
  assert.equal((await f.request('AI_NOTE_APPLY',{force:'true'})).reason,'disabled');
  assert.equal(f.messages.filter(m=>m.type==='NOTE_AI_PROPOSE').length,0);
  const result=await f.request('AI_NOTE_APPLY',{force:true});assert.equal(result.applied,true);assert.equal(f.note().text,'Pending revision');assert.equal(f.doc.text,'Pending revision');assert.equal(result.assistant.editNote,false);assert.equal(f.assistant().editNote,false);assert.equal(f.messages.find(m=>m.type==='NOTE_AI_PROPOSE').confirmed,true);
  assert.equal((await f.request('AI_NOTE_SYNC')).reason,'disabled');const id=await f.send();assert(!Object.hasOwn(f.calls.find(x=>x.action==='send'&&x.data.requestId===id).data,'noteEdit'));await f.publish(id,{noteId:f.doc.id,baseRevision:f.doc.revision,sequence:2,text:'Unpermitted later revision'},'completed');assert.equal(f.note().text,'Pending revision');assert.equal(f.assistant().editNote,false);
});
test('pending Windows newline revisions normalize before proposing and saving',async t=>{
  const f=await fixture(preview('First\r\nSecond\rThird\nFourth'));t.after(()=>f.close());await f.reveal();const result=await f.request('AI_NOTE_APPLY',{force:true});assert.equal(result.applied,true);assert.equal(f.doc.text,'First\nSecond\nThird\nFourth');assert.equal(f.note().text,f.doc.text);assert.equal(result.assistant.noteEditStage.text,f.doc.text);assert.equal(f.messages.find(m=>m.type==='NOTE_AI_PROPOSE').text,f.doc.text);
});
test('confirmed Apply is blocked while hidden and cannot target a different assistant',async t=>{
  const f=await fixture(preview());t.after(()=>f.close());const hidden=await f.request('AI_NOTE_APPLY',{force:true});assert.equal(hidden.ok,false);assert.match(hidden.error,/panel is disabled/i);assert.equal(f.note().text,'Original note');assert.equal(f.doc.text,'Original note');assert.equal(f.messages.filter(m=>m.type==='NOTE_AI_PROPOSE').length,0);
  await f.reveal();const wrong=await f.request('AI_NOTE_APPLY',{force:true,assistantId:randomUUID()});assert.equal(wrong.ok,false);assert.match(wrong.error,/selected note changed/i);assert.equal(f.note().text,'Original note');assert.equal(f.messages.filter(m=>m.type==='NOTE_AI_PROPOSE').length,0);
});
