'use strict';
// Exercise private note mirrors without credentials, a model request or a user
// document. UI visibility, conflict handling and undo are tested separately.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Codex}=require('../native/host.cjs');
const MAX_NOTE_BYTES=2*1024*1024;

function fixture(t){
 const parent=fs.realpathSync(__dirname),root=fs.mkdtempSync(path.join(parent,'.note-host-'));
 const dataRoot=path.join(root,'profile'),project=path.join(root,'project');
 fs.mkdirSync(path.join(dataRoot,'Conversations'),{recursive:true});fs.mkdirSync(project);
 const c=new Codex({dataRoot}),calls=[],events=[];
 c.cwd=path.join(dataRoot,'Conversations');c.start=async()=>{};c.requirements=async()=>{};
 c.models=[{model:'actual-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}];
 c.rpc=async(method,params)=>{calls.push([method,params]);return method==='turn/start'?{turn:{id:randomUUID()}}:{thread:{id:randomUUID()}};};
 c.on('update',e=>events.push(e));
 const send=(extra={})=>c.send({requestId:randomUUID(),text:'Revise my existing note.',model:'actual-model',effort:'low',project,files:[],...extra});
 t.after(()=>{c.close();const resolved=path.resolve(root);assert(resolved.startsWith(parent+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});
 return {c,calls,events,root,dataRoot,project,send};
}
const note=(extra={})=>({noteId:randomUUID(),text:'Existing note\nKeep this detail.',revision:7,...extra});
const turnCall=f=>f.calls.filter(([method])=>method==='turn/start').at(-1)[1];
const parseMirror=input=>JSON.parse(/^Authoritative editable note file: (.+)$/m.exec(input.text)[1]);

test('editing is opt-in and ordinary turns do not expose or create a note mirror',async t=>{
 const f=fixture(t);await f.send({text:'An ordinary question.'});
 const params=turnCall(f);
 assert.deepEqual(params.input,[{type:'text',text:'An ordinary question.'}]);
 assert.deepEqual(params.runtimeWorkspaceRoots,[f.project]);
 assert.deepEqual(params.sandboxPolicy.writableRoots,[f.project]);
 assert.equal(fs.existsSync(path.join(f.dataRoot,'NoteWork')),false);
 assert.equal(f.c.snapshot([...f.c.turns.keys()][0],[...f.c.turns.values()][0]).noteEdit,undefined);
});

test('editing keeps an existing Codex thread and only adds its owned mirror root',async t=>{
 const f=fixture(t),requestId=randomUUID(),n=note();
 f.c.loaded.set('existing-thread',f.project);
 const result=await f.send({threadId:'existing-thread',requestId,noteEdit:n});
 assert.equal(result.threadId,'existing-thread');assert.equal(f.calls.some(([m])=>m.startsWith('thread/')),false);
 const params=turnCall(f),file=parseMirror(params.input[0]);
 assert.equal(file,path.join(f.dataRoot,'NoteWork',requestId,'note.txt'));
 assert.equal(fs.readFileSync(file,'utf8'),n.text);
 assert.deepEqual(params.runtimeWorkspaceRoots,[f.project,path.dirname(file)]);
 assert.deepEqual(params.sandboxPolicy,{type:'workspaceWrite',writableRoots:[f.project,path.dirname(file)],networkAccess:false});
 assert.equal(params.approvalPolicy,'on-request');assert.equal(params.approvalsReviewer,'user');
 assert.match(params.input[0].text,/^\[NOTES_WORKSPACE_EDITABLE_NOTE\]/);
 assert.match(params.input[0].text,/Read this existing note before revising it/);
 assert.equal(params.input.at(-1).text,'Revise my existing note.');
 assert.equal(f.c.turns.get('existing-thread').note.sequence,0);
});

test('each valid change carries the original note, run and revision binding',async t=>{
 const f=fixture(t),requestId=randomUUID(),n=note();
 const {threadId}=await f.send({requestId,noteEdit:n}),state=f.c.turns.get(threadId);
 fs.writeFileSync(state.note.file,'First revision');f.c.pollNote(threadId,state);
 const first=f.events.at(-1);
 assert.equal(first.requestId,requestId);assert.equal(first.threadId,threadId);
 assert.equal(first.phase,'Updating note');assert.equal(first.status,'working');
 assert.deepEqual(first.noteEdit,{text:'First revision',sequence:1,noteId:n.noteId,baseRevision:7});
 const count=f.events.length;f.c.pollNote(threadId,state);assert.equal(f.events.length,count);
 fs.writeFileSync(state.note.file,'Second revision');f.c.pollNote(threadId,state);
 assert.deepEqual(f.events.at(-1).noteEdit,{text:'Second revision',sequence:2,noteId:n.noteId,baseRevision:7});
 assert.equal(fs.readdirSync(f.project).length,0,'The ordinary project and actual note are never mirror destinations.');
});

test('the polling timer captures progress without a model completion event',async t=>{
 const f=fixture(t),{threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId);
 const changed=new Promise(resolve=>f.c.once('update',resolve));
 fs.writeFileSync(state.note.file,'Progress while the assistant is still running');
 const event=await Promise.race([changed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Mirror polling did not run.')),1500).unref())]);
 assert.equal(event.noteEdit.text,'Progress while the assistant is still running');assert.equal(event.status,'working');
});

test('completion flushes the last write before emission and then removes only the owned mirror',async t=>{
 const f=fixture(t),n=note(),{threadId}=await f.send({noteEdit:n}),state=f.c.turns.get(threadId);
 const file=state.note.file,timer=state.note.timer;let existedDuringFinal=false;
 f.c.on('update',e=>{if(e.status==='completed')existedDuringFinal=fs.existsSync(file);});
 fs.writeFileSync(file,'The final revised note');
 f.c.finish(threadId,{status:'completed',items:[{id:'answer',type:'agentMessage',text:'Updated your note.'}]});
 const final=f.events.at(-1);
 assert.equal(existedDuringFinal,true);assert.equal(final.status,'completed');assert.equal(final.text,'Updated your note.');
 assert.deepEqual(final.noteEdit,{text:'The final revised note',sequence:1,noteId:n.noteId,baseRevision:7});
 assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(path.dirname(file)),false);
 assert.equal(state.note.closed,true);assert.equal(state.note.timer,null);assert.equal(timer._destroyed,true);assert.equal(f.c.turns.size,0);
});

test('concurrent notes use separate mirrors and emit to their own submitted runs',async t=>{
 const f=fixture(t),a=note(),b=note({text:'Another note',revision:15});
 const aa=await f.send({requestId:randomUUID(),noteEdit:a}),bb=await f.send({requestId:randomUUID(),noteEdit:b});
 const ta=f.c.turns.get(aa.threadId),tb=f.c.turns.get(bb.threadId);
 assert.notEqual(ta.note.root,tb.note.root);
 fs.writeFileSync(ta.note.file,'Only A');f.c.pollNote(aa.threadId,ta);
 fs.writeFileSync(tb.note.file,'Only B');f.c.pollNote(bb.threadId,tb);
 assert.deepEqual(f.events.map(e=>[e.threadId,e.requestId,e.noteEdit.noteId,e.noteEdit.text,e.noteEdit.baseRevision]),[
  [aa.threadId,ta.requestId,a.noteId,'Only A',7],[bb.threadId,tb.requestId,b.noteId,'Only B',15]
 ]);
});

test('the next ordinary turn resets roots to the project and sends no obsolete mirror instruction',async t=>{
 const f=fixture(t),first=await f.send({noteEdit:note()});f.c.finish(first.threadId,{status:'completed'});
 await f.send({threadId:first.threadId,text:'Now answer normally.'});
 const params=turnCall(f);
 assert.equal(f.calls.filter(([method])=>method==='thread/start').length,1);
 assert.deepEqual(params.runtimeWorkspaceRoots,[f.project]);assert.deepEqual(params.sandboxPolicy.writableRoots,[f.project]);
 assert.deepEqual(params.input,[{type:'text',text:'Now answer normally.'}]);
});

test('malformed identity, text and revision values cannot create an editable copy',async t=>{
 const f=fixture(t);
 const invalid=[note({noteId:'../escape'}),note({text:'a\0b'}),note({text:'é'.repeat(MAX_NOTE_BYTES/2+1)}),note({revision:-1}),note({revision:1.5}),note({revision:Number.MAX_SAFE_INTEGER+1}),[],true];
 for(const candidate of invalid)await assert.rejects(f.send({noteEdit:candidate}),/editable note is invalid/);
 await assert.rejects(f.send({requestId:'../escape',noteEdit:note()}),/editable note is invalid/);
 assert.equal(fs.existsSync(path.join(f.dataRoot,'NoteWork')),false);assert.equal(f.c.turns.size,0);
});

test('a full 2 MiB UTF-8 note is accepted without relaxing the limit',async t=>{
 const f=fixture(t),text='é'.repeat(MAX_NOTE_BYTES/2),{threadId}=await f.send({noteEdit:note({text})});
 const state=f.c.turns.get(threadId);assert.equal(fs.statSync(state.note.file).size,MAX_NOTE_BYTES);
 fs.writeFileSync(state.note.file,'a'.repeat(MAX_NOTE_BYTES));f.c.pollNote(threadId,state);
 assert.equal(f.events.at(-1).noteEdit.text.length,MAX_NOTE_BYTES);
});

test('oversized, binary and invalid UTF-8 writes never replace the last valid candidate',async t=>{
 const f=fixture(t),{threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId);
 fs.writeFileSync(state.note.file,'Valid revision');f.c.pollNote(threadId,state);
 for(const bytes of [Buffer.alloc(MAX_NOTE_BYTES+1,65),Buffer.from('bad\0value'),Buffer.from([0xff,0xfe,0xfd])]){
  fs.writeFileSync(state.note.file,bytes);f.c.pollNote(threadId,state);
  assert.equal(f.events.length,1);assert.equal(state.note.text,'Valid revision');assert.equal(state.note.sequence,1);
 }
 f.c.finish(threadId,{status:'completed'});assert.equal(f.events.at(-1).noteEdit.text,'Valid revision');
});

test('a directory or a hard link cannot become an editable note source',async t=>{
 const f=fixture(t),{threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId),outside=path.join(f.root,'other-document.txt');
 fs.unlinkSync(state.note.file);fs.mkdirSync(state.note.file);f.c.pollNote(threadId,state);assert.equal(f.events.length,0);
 fs.rmdirSync(state.note.file);fs.writeFileSync(outside,'Do not read this as a note');fs.linkSync(outside,state.note.file);
 f.c.pollNote(threadId,state);assert.equal(f.events.length,0);assert.equal(state.note.sequence,0);
 f.c.disposeNote(state);assert.equal(fs.readFileSync(outside,'utf8'),'Do not read this as a note');
});

test('a junction cannot redirect the application working folder or an active mirror',async t=>{
 const f=fixture(t),outside=path.join(f.root,'other-folder'),work=path.join(f.dataRoot,'NoteWork');
 fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'note.txt'),'Do not read or remove');
 fs.symlinkSync(outside,work,process.platform==='win32'?'junction':'dir');
 await assert.rejects(f.send({noteEdit:note()}),/regular application folder/);fs.unlinkSync(work);
 const {threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId),saved=state.note.root+'-original';
 fs.renameSync(state.note.root,saved);fs.symlinkSync(outside,state.note.root,process.platform==='win32'?'junction':'dir');
 f.c.pollNote(threadId,state);assert.equal(f.events.length,0);assert.equal(state.note.sequence,0);
 f.c.disposeNote(state);assert.equal(fs.readFileSync(path.join(outside,'note.txt'),'utf8'),'Do not read or remove');
});

test('stopping flushes staged changes and always ends mirror monitoring',async t=>{
 const f=fixture(t),{threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId),file=state.note.file,timer=state.note.timer;
 fs.writeFileSync(file,'Partial revision before stop');
 await f.c.stop(threadId,state.requestId);
 assert.equal(f.events.at(-1).noteEdit.text,'Partial revision before stop');
 assert.equal(f.calls.at(-1)[0],'turn/interrupt');assert.equal(state.note.closed,true);assert.equal(timer._destroyed,true);assert.equal(fs.existsSync(file),false);
});

test('a failed interrupt cannot leave a private mirror timer running',async t=>{
 const f=fixture(t),{threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId),timer=state.note.timer;
 f.c.rpc=async()=>{throw Error('Disconnected during stop');};
 await assert.rejects(f.c.stop(threadId,state.requestId),/Disconnected/);
 assert.equal(state.note.closed,true);assert.equal(timer._destroyed,true);assert.equal(fs.existsSync(state.note.file),false);
});

test('stopping while a turn acknowledgement is pending still removes its private copy',async t=>{
 const f=fixture(t),requestId=randomUUID();let acknowledge;
 const normal=f.c.rpc;f.c.rpc=async(method,params)=>method==='turn/start'?(f.calls.push([method,params]),new Promise(resolve=>{acknowledge=resolve;})):normal(method,params);
 const sending=f.send({requestId,noteEdit:note()});
 while(!acknowledge)await new Promise(resolve=>setImmediate(resolve));
 const [threadId,state]=[...f.c.turns][0];await f.c.stop(threadId,requestId);
 assert.equal(state.note.closed,true);assert.equal(fs.existsSync(state.note.file),false);
 acknowledge({turn:{id:'accepted-turn'}});await sending;
 assert.equal(f.calls.at(-1)[0],'turn/interrupt');assert.equal(f.calls.at(-1)[1].turnId,'accepted-turn');
});

test('a rejected turn acknowledgement or host close cannot leave a mirror file or timer',async t=>{
 const f=fixture(t),normal=f.c.rpc;let rejectedFile;
 f.c.rpc=async(method,params)=>{if(method==='turn/start'){rejectedFile=parseMirror(params.input[0]);throw Error('Not accepted');}return normal(method,params);};
 await assert.rejects(f.send({noteEdit:note()}),/Not accepted/);assert.equal(f.c.turns.size,0);assert.equal(fs.existsSync(rejectedFile),false);
 f.c.rpc=normal;const {threadId}=await f.send({noteEdit:note()}),state=f.c.turns.get(threadId),timer=state.note.timer;
 f.c.close();assert.equal(state.note.closed,true);assert.equal(timer._destroyed,true);assert.equal(fs.existsSync(state.note.file),false);
});
