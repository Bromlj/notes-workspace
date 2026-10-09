'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {createNoteFiles,documentPath}=require('../desktop/note-files.cjs');
const {createService}=require('../desktop/codex-service.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(t){const dataRoot=fs.mkdtempSync(path.join(__dirname,'note-file-races-')),files=createNoteFiles({dataRoot}),codex=new EventEmitter();codex.turns=new Map();codex.attachments=new Map();codex.send=async()=>({threadId:'fixture'});codex.close=()=>{};const service=createService({noteFiles:files,codexInstance:codex});t.after(()=>fs.rmSync(dataRoot,{recursive:true,force:true}));return {dataRoot,files,codex,service,noteId:crypto.randomUUID(),otherId:crypto.randomUUID(),target:path.join(dataRoot,'shared.txt')};}
async function shared(f){fs.writeFileSync(f.target,'Presented version');const selected=await f.files.open(f.target);return {a:await f.files.bind(f.noteId,selected),b:await f.files.bind(f.otherId,selected)};}
async function interceptRename(t,fn){const original=fs.promises.rename;fs.promises.rename=async(...args)=>fn(original,args);t.after(()=>{fs.promises.rename=original;});}

test('an accepted note turn protects the same physical file through another note before host startup',async t=>{
 const f=fixture(t),{a,b}=await shared(f),started=deferred(),finishStart=deferred();f.codex.send=async()=>{started.resolve();await finishStart.promise;return {};};
 const sending=f.service.invoke('send',{requestId:'accepted',noteEdit:{noteId:f.noteId}});await started.promise;
 assert.equal(f.codex.turns.size,0,'the guard must cover the accepted/start gap');
 const save=await f.service.invoke('noteSave',{noteId:f.otherId,bindingId:b.bindingId,expectedHash:b.hash,text:'Must not overwrite'});assert.equal(save.ok,false);assert.match(save.error,/still editing/);
 await assert.rejects(f.files.undo(f.otherId,{bindingId:b.bindingId,expectedHash:b.hash,text:'Must not undo'}),/still editing/);
 await assert.rejects(f.files.saveAs(crypto.randomUUID(),f.target,'Must not Save As over active file'),/still editing/);
 assert.equal((await f.service.invoke('send',{requestId:'second',noteEdit:{noteId:f.otherId}})).ok,false);
 assert.equal(fs.readFileSync(a.path,'utf8'),'Presented version');finishStart.resolve();await sending;f.codex.emit('update',{requestId:'accepted',status:'completed'});
 assert.equal((await f.service.invoke('noteSave',{noteId:f.otherId,bindingId:b.bindingId,expectedHash:b.hash,text:'After completion'})).ok,true);
});

test('host turns and Windows path casing protect aliases independently of the accepted grant map',async t=>{
 const f=fixture(t),{b}=await shared(f);f.codex.turns.set('active',{note:{noteId:f.noteId,file:process.platform==='win32'?f.target.toUpperCase():f.target}});
 assert.throws(()=>f.service.assertNoteIdle(f.otherId),/still editing/);
 assert.throws(()=>f.service.assertNoteIdle(crypto.randomUUID(),f.target),/still editing/);
 assert.equal((await f.service.invoke('noteSave',{noteId:f.otherId,bindingId:b.bindingId,expectedHash:b.hash,text:'Blocked'})).ok,false);
 assert.equal(documentPath(f.target),documentPath(path.join(f.dataRoot,'.','shared.txt')));
 if(process.platform==='win32')assert.equal(documentPath(f.target),documentPath(f.target.toUpperCase()));
});

test('a queued write rechecks a newly accepted physical-file grant when its operation begins',async t=>{
 const f=fixture(t),{b}=await shared(f),entered=deferred(),release=deferred(),registry=path.join(f.dataRoot,'document-bindings.json');let held=false;
 await interceptRename(t,async(original,args)=>{if(args[1]===registry&&!held){held=true;entered.resolve();await release.promise;}return original(...args);});
 const blocker=f.files.ensure(crypto.randomUUID(),'Unrelated queue blocker');await entered.promise;
 const queued=f.files.save(f.otherId,{bindingId:b.bindingId,expectedHash:b.hash,text:'Queued stale write'});
 assert.equal((await f.service.invoke('send',{requestId:'newly-accepted',noteEdit:{noteId:f.noteId}})).ok,true);release.resolve();await blocker;
 await assert.rejects(queued,/still editing/);assert.equal(fs.readFileSync(f.target,'utf8'),'Presented version');
});

test('a save reservation prevents a new alias grant before asynchronous disk replacement finishes',async t=>{
 const f=fixture(t),{b}=await shared(f),entered=deferred(),release=deferred();
 await interceptRename(t,async(original,args)=>{if(args[1]===f.target){entered.resolve();await release.promise;}return original(...args);});
 const saving=f.files.save(f.otherId,{bindingId:b.bindingId,expectedHash:b.hash,text:'Manual save'});await entered.promise;
 const response=await f.service.invoke('send',{requestId:'during-save',noteEdit:{noteId:f.noteId}});assert.equal(response.ok,false);assert.match(response.error,/being saved/);
 release.resolve();await saving;assert.equal(fs.readFileSync(f.target,'utf8'),'Manual save');
});

test('a Save As destination reservation prevents a grant on another note bound to that destination',async t=>{
 const f=fixture(t);await shared(f);const entered=deferred(),release=deferred();
 await interceptRename(t,async(original,args)=>{if(args[1]===f.target){entered.resolve();await release.promise;}return original(...args);});
 const saving=f.files.saveAs(crypto.randomUUID(),f.target,'Manual Save As');await entered.promise;
 const response=await f.service.invoke('send',{requestId:'during-save-as',noteEdit:{noteId:f.noteId}});assert.equal(response.ok,false);assert.match(response.error,/being saved/);
 release.resolve();await saving;assert.equal(fs.readFileSync(f.target,'utf8'),'Manual Save As');
});

for(const operation of ['ensure','bind','save','saveAs'])test(operation+' returns only the exact selected or written bytes, never an unseen external hash',async t=>{
 const f=fixture(t),originalText='Presented version',external='Independent external revision',registry=path.join(f.dataRoot,'document-bindings.json');let bound,result,target=f.target;
 if(operation==='bind'){fs.writeFileSync(target,originalText);bound=await f.files.open(target);}
 if(operation==='save'){fs.writeFileSync(target,'Before save');bound=await f.files.bind(f.noteId,await f.files.open(target));}
 if(operation==='ensure')target=path.join(f.dataRoot,'Documents',f.noteId,'note.txt');
 let injected=false;
 await interceptRename(t,async(original,args)=>{await original(...args);const trigger=operation==='save'?target:registry;if(args[1]===trigger&&!injected){injected=true;fs.writeFileSync(target,external);}});
 if(operation==='ensure')result=await f.files.ensure(f.noteId,originalText);
 if(operation==='bind')result=await f.files.bind(f.noteId,bound);
 if(operation==='save')result=await f.files.save(f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash,text:originalText});
 if(operation==='saveAs')result=await f.files.saveAs(f.noteId,target,originalText);
 assert.equal(injected,true);assert.equal(result.text,originalText);assert.equal(result.hash,crypto.createHash('sha256').update(originalText).digest('hex'));assert.equal(fs.readFileSync(target,'utf8'),external);
 await assert.rejects(f.files.save(f.noteId,{bindingId:result.bindingId,expectedHash:result.hash,text:'Would overwrite unseen content'}),error=>error.code==='NOTE_FILE_CONFLICT');assert.equal(fs.readFileSync(target,'utf8'),external);
});
