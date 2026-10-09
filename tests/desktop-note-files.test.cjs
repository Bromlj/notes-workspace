'use strict';
// Real files in disposable local profiles; no account or application data.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createNoteFiles}=require('../desktop/note-files.cjs');
function fixture(){const dataRoot=fs.mkdtempSync(path.join(__dirname,'note-files-data-')),noteId=crypto.randomUUID(),files=createNoteFiles({dataRoot});return {dataRoot,noteId,files,file:name=>path.join(dataRoot,name)};}
const rejects=(fn,code)=>assert.rejects(fn,error=>error.code===code,'Expected '+code);

test('native-picked UTF8 CRLF note binds the actual file with an opaque persistent identity',async()=>{
 const f=fixture(),target=f.file('ordinary note.txt');fs.writeFileSync(target,'\uFEFFFirst line\r\nSecond line\r\n');
 const selected=await f.files.open(target),bound=await f.files.bind(f.noteId,selected);
 assert.equal(bound.text,'First line\nSecond line\n');assert.equal(bound.path,path.resolve(target));assert.equal(bound.name,'ordinary note.txt');assert.equal(bound.managed,false);assert.equal(bound.noteId,f.noteId);assert.equal(typeof bound.bindingId,'string');assert(bound.bindingId.length>=16);assert.equal(typeof bound.hash,'string');
 const restored=await createNoteFiles({dataRoot:f.dataRoot}).status(f.noteId,bound.text);assert.equal(restored.bindingId,bound.bindingId);assert.equal(restored.path,bound.path);assert.equal(restored.hash,bound.hash);
});

test('guarded Save updates only the selected actual file and advances its hash',async()=>{
 const f=fixture(),target=f.file('save.txt');fs.writeFileSync(target,'Before save');const bound=await f.files.bind(f.noteId,await f.files.open(target));
 const saved=await f.files.save(f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash,text:'Saved directly\nSecond line'});
 assert.equal(fs.readFileSync(target,'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'),'Saved directly\nSecond line');assert.notEqual(saved.hash,bound.hash);assert.equal(saved.bindingId,bound.bindingId);assert.equal(saved.path,bound.path);
});

test('saving an opened Windows text file preserves its UTF8 BOM and CRLF convention',async()=>{
 const f=fixture(),target=f.file('windows.txt');fs.writeFileSync(target,'\uFEFFOld first\r\nOld second\r\n');const bound=await f.files.bind(f.noteId,await f.files.open(target));await f.files.save(f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash,text:'New first\nNew second\n'});assert.equal(fs.readFileSync(target,'utf8'),'\uFEFFNew first\r\nNew second\r\n');
});

test('Save As rebinds to the newly selected file and retains the original contents',async()=>{
 const f=fixture(),original=f.file('original.txt'),copy=f.file('copy.txt');fs.writeFileSync(original,'Original disk text');const bound=await f.files.bind(f.noteId,await f.files.open(original));const saved=await f.files.saveAs(f.noteId,copy,'Copy disk text');
 assert.equal(fs.readFileSync(original,'utf8'),'Original disk text');assert.equal(fs.readFileSync(copy,'utf8'),'Copy disk text');assert.equal(saved.path,path.resolve(copy));assert.notEqual(saved.bindingId,bound.bindingId);assert.equal((await f.files.status(f.noteId,'Copy disk text')).bindingId,saved.bindingId);
});

test('external disk changes cannot be overwritten by stale Save or Undo guards',async()=>{
 const f=fixture(),target=f.file('external.txt');fs.writeFileSync(target,'Initial');const bound=await f.files.bind(f.noteId,await f.files.open(target));fs.writeFileSync(target,'External change');
 for(const method of ['save','undo'])await rejects(()=>f.files[method](f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash,text:'Must not overwrite external change'}),'NOTE_FILE_CONFLICT');assert.equal(fs.readFileSync(target,'utf8'),'External change');
 const reloaded=await f.files.reload(f.noteId,{bindingId:bound.bindingId});assert.equal(reloaded.text,'External change');assert.notEqual(reloaded.hash,bound.hash);assert.equal(reloaded.bindingId,bound.bindingId);
 const saved=await f.files.save(f.noteId,{bindingId:reloaded.bindingId,expectedHash:reloaded.hash,text:'After explicit reload'});assert.equal(fs.readFileSync(target,'utf8'),'After explicit reload');assert.notEqual(saved.hash,reloaded.hash);
});

test('guarded Undo restores the actual accepted file only while its AI result is unchanged',async()=>{
 const f=fixture(),target=f.file('undo.txt');fs.writeFileSync(target,'Before AI');const bound=await f.files.bind(f.noteId,await f.files.open(target)),edited=await f.files.save(f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash,text:'After AI'});
 const undone=await f.files.undo(f.noteId,{bindingId:edited.bindingId,expectedHash:edited.hash,text:'Before AI'});assert.equal(fs.readFileSync(target,'utf8'),'Before AI');assert.notEqual(undone.hash,edited.hash);
 const again=await f.files.save(f.noteId,{bindingId:undone.bindingId,expectedHash:undone.hash,text:'Second AI result'});fs.writeFileSync(target,'Later independent edit');await rejects(()=>f.files.undo(f.noteId,{bindingId:again.bindingId,expectedHash:again.hash,text:'Before AI'}),'NOTE_FILE_CONFLICT');assert.equal(fs.readFileSync(target,'utf8'),'Later independent edit');
});

test('a moved or deleted bound file is not silently recreated by Save, Undo, ensure or agent access',async()=>{
 const f=fixture(),target=f.file('moved.txt'),moved=f.file('new-name.txt');fs.writeFileSync(target,'Keep moved data');const bound=await f.files.bind(f.noteId,await f.files.open(target));fs.renameSync(target,moved);
 for(const method of ['save','undo','agentTarget'])await rejects(()=>f.files[method](f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash,text:'Do not recreate'}),'NOTE_FILE_MISSING');await rejects(()=>f.files.ensure(f.noteId,'Do not recreate'),'NOTE_FILE_MISSING');assert.equal(fs.existsSync(target),false);assert.equal(fs.readFileSync(moved,'utf8'),'Keep moved data');
 const relinked=await f.files.bind(f.noteId,await f.files.open(moved));assert.equal(relinked.path,path.resolve(moved));assert.notEqual(relinked.bindingId,bound.bindingId);
});

test('untitled notes receive distinct persistent actual files rather than per-turn temporary copies',async()=>{
 const f=fixture(),other=crypto.randomUUID(),one=await f.files.ensure(f.noteId,'Untitled one'),two=await f.files.ensure(other,'Untitled two');
 assert.equal(one.managed,true);assert.equal(two.managed,true);assert.notEqual(one.path,two.path);assert.equal(fs.readFileSync(one.path,'utf8'),'Untitled one');assert.equal(fs.readFileSync(two.path,'utf8'),'Untitled two');assert.equal((await f.files.ensure(f.noteId,'Untitled one')).path,one.path);const restart=createNoteFiles({dataRoot:f.dataRoot});assert.equal((await restart.ensure(f.noteId,'Untitled one')).path,one.path);assert.equal(fs.readFileSync(one.path,'utf8'),'Untitled one');assert(!one.path.includes(path.sep+'NoteWork'+path.sep));
});

test('binding identity is scoped to its note and stale renderer binding IDs cannot grant a target',async()=>{
 const f=fixture(),a=await f.files.ensure(f.noteId,'First note'),other=crypto.randomUUID(),b=await f.files.ensure(other,'Second note');
 for(const method of ['save','undo','agentTarget'])await rejects(()=>f.files[method](other,{bindingId:a.bindingId,expectedHash:a.hash,text:'Wrong owner'}),'NOTE_FILE_INVALID');assert.equal(fs.readFileSync(a.path,'utf8'),'First note');assert.equal(fs.readFileSync(b.path,'utf8'),'Second note');
});

test('the binding registry is separate from note recovery data and opened invalid files are rejected',async()=>{
 const f=fixture(),bound=await f.files.ensure(f.noteId,'Local note');assert.equal(fs.existsSync(path.join(f.dataRoot,'document-bindings.json')),true);assert.equal(fs.existsSync(path.join(f.dataRoot,'notes.json')),false);assert.equal((await f.files.status(f.noteId,'Local note')).bindingId,bound.bindingId);await rejects(()=>f.files.open(f.dataRoot),'NOTE_FILE_INVALID');const binary=f.file('binary.txt');fs.writeFileSync(binary,Buffer.from([0xff,0xfe,0,0xff]));await rejects(()=>f.files.open(binary),'NOTE_FILE_INVALID');
});

test('a file changed after native selection cannot be bound using the stale selection',async()=>{
 const f=fixture(),target=f.file('picker-race.txt');fs.writeFileSync(target,'Selected version');const selected=await f.files.open(target);fs.writeFileSync(target,'Newer version after selection');await rejects(()=>f.files.bind(f.noteId,selected),'NOTE_FILE_CONFLICT');assert.equal(fs.readFileSync(target,'utf8'),'Newer version after selection');
});

test('stage verification rejects a stale disk hash while accepting the exact current file',async()=>{
 const f=fixture(),bound=await f.files.ensure(f.noteId,'Bound initial text');assert.equal((await f.files.verify(f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash})).hash,bound.hash);fs.writeFileSync(bound.path,'Later actual file revision');await rejects(()=>f.files.verify(f.noteId,{bindingId:bound.bindingId,expectedHash:bound.hash}),'NOTE_FILE_CONFLICT');assert.equal(fs.readFileSync(bound.path,'utf8'),'Later actual file revision');
});

test('a missing persistent untitled file remains missing after restarting the binding registry',async()=>{
 const f=fixture(),bound=await f.files.ensure(f.noteId,'Persistent note');fs.renameSync(bound.path,bound.path+'.moved');const restarted=createNoteFiles({dataRoot:f.dataRoot});await rejects(()=>restarted.ensure(f.noteId,'Do not recreate from frozen recovery text'),'NOTE_FILE_MISSING');assert.equal(fs.existsSync(bound.path),false);assert.equal(fs.readFileSync(bound.path+'.moved','utf8'),'Persistent note');
});
