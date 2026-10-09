'use strict';
// Main-process-owned document grants. Paths are created here or supplied by a
// native picker; renderer requests can only reuse opaque note/binding IDs.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const MAX=2*1024*1024,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
function fail(code,message){throw Object.assign(Error(message),{code});}
function id(value){if(typeof value!=='string'||!UUID.test(value))fail('NOTE_FILE_INVALID','The document identifier is invalid.');return value;}
function text(value){if(typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value,'utf8')>MAX)fail('NOTE_FILE_INVALID','Use a UTF-8 text document no larger than 2 MB.');return value.replace(/\r\n?/g,'\n');}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function documentPath(file){if(typeof file!=='string'||!path.isAbsolute(file))return null;const normalized=path.normalize(path.resolve(file));return process.platform==='win32'?normalized.toLowerCase():normalized;}
function createNoteFiles({dataRoot}){
  const root=path.resolve(dataRoot),documents=path.join(root,'Documents'),registryFile=path.join(root,'document-bindings.json');
  fs.mkdirSync(documents,{recursive:true,mode:0o700});
  if(fs.lstatSync(documents).isSymbolicLink()||fs.realpathSync(documents)!==documents)fail('NOTE_FILE_INVALID','The private document folder is not a regular application folder.');
  let bindings={},queue=Promise.resolve(),writeGuard=null;const writes=new Set();
  if(fs.existsSync(registryFile)){
    if(fs.statSync(registryFile).size>4*1024*1024)fail('NOTE_FILE_INVALID','The document binding registry is too large.');
    const saved=JSON.parse(fs.readFileSync(registryFile,'utf8'));if(!saved||Array.isArray(saved)||typeof saved!=='object')fail('NOTE_FILE_INVALID','The document binding registry is invalid.');
    for(const [noteId,b]of Object.entries(saved)){id(noteId);if(!b||typeof b!=='object'||b.noteId!==noteId||!UUID.test(b.bindingId)||typeof b.path!=='string'||!path.isAbsolute(b.path)||typeof b.root!=='string'||!path.isAbsolute(b.root)||path.dirname(b.path)!==b.root||typeof b.managed!=='boolean'||!['\n','\r\n'].includes(b.newline)||typeof b.bom!=='boolean')fail('NOTE_FILE_INVALID','A saved document binding is invalid.');bindings[noteId]={noteId,bindingId:b.bindingId,path:b.path,root:b.root,managed:b.managed,newline:b.newline,bom:b.bom};}
  }
  const run=fn=>{const result=queue.catch(()=>undefined).then(fn);queue=result.catch(()=>undefined);return result;};
  function checked(binding){
    let parent,stat;
    try{parent=fs.lstatSync(binding.root);stat=fs.lstatSync(binding.path,{bigint:true});}
    catch(error){if(error.code==='ENOENT')fail('NOTE_FILE_MISSING','The document was moved, renamed or deleted. Use Relink to choose its current file.');throw error;}
    if(!parent.isDirectory()||parent.isSymbolicLink()||fs.realpathSync(binding.root)!==binding.root||path.dirname(binding.path)!==binding.root||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||fs.realpathSync(binding.path)!==binding.path||stat.size>BigInt(MAX))fail('NOTE_FILE_INVALID','The document must be a regular, nonlinked UTF-8 text file within its chosen folder, no larger than 2 MB.');
    return stat;
  }
  function read(binding){
    const before=checked(binding);let fd;
    try{
      fd=fs.openSync(binding.path,'r');const opened=fs.fstatSync(fd,{bigint:true});if(opened.ino!==before.ino||opened.dev!==before.dev||!opened.isFile()||opened.nlink!==1n||opened.size>BigInt(MAX))fail('NOTE_FILE_CONFLICT','The document changed while it was being read. Try again.');
      const buffer=Buffer.alloc(MAX+1);let size=0,count;while(size<buffer.length&&(count=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=count;
      if(size>MAX)fail('NOTE_FILE_INVALID','The document exceeds 2 MB.');const bytes=buffer.subarray(0,size),after=checked(binding);if(after.ino!==opened.ino||after.dev!==opened.dev||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs)fail('NOTE_FILE_CONFLICT','The document changed while it was being read. Try again.');
      let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('NOTE_FILE_INVALID','The selected document is not valid UTF-8 text.');}
      value=text(value);return {text:value,hash:hash(bytes),newline:bytes.includes(Buffer.from('\r\n'))?'\r\n':'\n',bom:bytes.length>=3&&bytes[0]===239&&bytes[1]===187&&bytes[2]===191};
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function info(b,r=read(b)){return {noteId:b.noteId,bindingId:b.bindingId,name:path.basename(b.path),path:b.path,managed:b.managed,hash:r.hash,state:'ready',text:r.text};}
  function binding(noteId,bindingId){id(noteId);const b=bindings[noteId];if(!b)fail('NOTE_FILE_INVALID','This note does not have a document binding yet.');if(bindingId!==undefined&&bindingId!==b.bindingId)fail('NOTE_FILE_INVALID','The document binding changed. Reopen the current note.');return b;}
  async function modifying(noteId,file,fn){
    // The synchronous reservation closes both sides of the asynchronous gap:
    // queued writes recheck grants here, and a new grant checks this reservation.
    if(writeGuard)writeGuard(noteId,file);const reservation={noteId,path:documentPath(file)};writes.add(reservation);
    try{return await fn();}finally{writes.delete(reservation);}
  }
  async function atomic(file,bytes,check){
    const temporary=path.join(path.dirname(file),'.notes-workspace-'+randomUUID()+'.tmp');let handle;
    try{
      handle=await fs.promises.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
      for(let attempt=0;;attempt++){if(check)check();try{await fs.promises.rename(temporary,file);break;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;await wait(50*2**attempt);}}
    }catch(error){if(handle)await handle.close().catch(()=>undefined);await fs.promises.unlink(temporary).catch(()=>undefined);throw error;}
  }
  const persist=()=>atomic(registryFile,Buffer.from(JSON.stringify(bindings)),null);
  async function register(noteId,b){const previous=bindings[noteId];bindings[noteId]=b;try{await persist();}catch(error){if(previous)bindings[noteId]=previous;else delete bindings[noteId];throw error;}}
  async function ensureInternal(noteId,value){
    id(noteId);if(bindings[noteId])return info(binding(noteId));
    value=text(value);const parent=path.join(documents,noteId);fs.mkdirSync(parent,{recursive:true,mode:0o700});if(fs.lstatSync(parent).isSymbolicLink()||fs.realpathSync(parent)!==parent)fail('NOTE_FILE_INVALID','The private document folder is not regular.');
    const file=path.join(parent,'note.txt');if(fs.existsSync(file))fail('NOTE_FILE_CONFLICT','An unregistered document already exists. Relink it instead of overwriting it.');
    return modifying(noteId,file,async()=>{const bytes=Buffer.from(value,'utf8');await fs.promises.writeFile(file,bytes,{flag:'wx',mode:0o600});const b={noteId,bindingId:randomUUID(),path:file,root:parent,managed:true,newline:'\n',bom:false};bindings[noteId]=b;
    try{await persist();}catch(error){delete bindings[noteId];throw error;}return info(b,{text:value,hash:hash(bytes)});});
  }
  function selected(file){
    if(typeof file!=='string'||!path.isAbsolute(file))fail('NOTE_FILE_INVALID','Choose a document using the native file picker.');
    const absolute=path.resolve(file),parent=fs.realpathSync(path.dirname(absolute));
    const b={path:path.join(parent,path.basename(absolute)),root:parent,managed:false};const r=read(b);return {...b,...r,name:path.basename(b.path),selectionId:randomUUID()};
  }
  async function writeInternal(noteId,{bindingId,expectedHash,text:value}){
    const b=binding(noteId,bindingId);return modifying(noteId,b.path,async()=>{const before=read(b);value=text(value);
    if(typeof expectedHash!=='string'||!HASH.test(expectedHash)||expectedHash!==before.hash)fail('NOTE_FILE_CONFLICT','The disk document changed. Reload it or review the pending revision before saving; your local note is retained.');
    const bytes=Buffer.from((b.bom?'\uFEFF':'')+value.replace(/\n/g,b.newline),'utf8');if(bytes.length>MAX)fail('NOTE_FILE_INVALID','The encoded document exceeds 2 MB.');
    if(hash(bytes)!==before.hash)await atomic(b.path,bytes,()=>{if(read(b).hash!==expectedHash)fail('NOTE_FILE_CONFLICT','The document changed during saving. Your local note is retained.');});
    return info(b,{text:value,hash:hash(bytes)});});
  }
  return {
    // Main-only identity and reservation methods; never exposed as renderer RPC.
    pathFor:noteId=>{id(noteId);return bindings[noteId]?.path||null;},
    setWriteGuard:guard=>{if(typeof guard!=='function')throw TypeError('A document write guard is required.');writeGuard=guard;},
    assertIdle:(noteId,file)=>{id(noteId);const target=documentPath(file||bindings[noteId]?.path);if([...writes].some(write=>write.noteId===noteId||(target&&write.path===target)))fail('NOTE_FILE_CONFLICT','The document is being saved. Wait for saving to finish before starting another request.');},
    ensure:(noteId,value='')=>run(()=>ensureInternal(noteId,value)),
    status:(noteId,value='')=>run(()=>ensureInternal(noteId,value)),
    open:file=>run(()=>selected(file)),
    bind:(noteId,selection)=>run(async()=>{id(noteId);if(!selection||typeof selection.path!=='string'||typeof selection.hash!=='string')fail('NOTE_FILE_INVALID','The file selection expired.');const current=selected(selection.path);if(current.hash!==selection.hash)fail('NOTE_FILE_CONFLICT','The selected document changed before it could be opened. Choose it again.');const b={noteId,bindingId:randomUUID(),path:current.path,root:current.root,managed:false,newline:current.newline,bom:current.bom};await register(noteId,b);return info(b,current);}),
    save:(noteId,options)=>run(async()=>{if(!bindings[noteId])return ensureInternal(noteId,options.text);return writeInternal(noteId,options);}),
    saveAs:(noteId,file,value)=>run(async()=>{id(noteId);value=text(value);if(typeof file!=='string'||!path.isAbsolute(file))fail('NOTE_FILE_INVALID','Choose a document using the native Save As dialog.');const parent=fs.realpathSync(path.dirname(file));if(fs.lstatSync(parent).isSymbolicLink())fail('NOTE_FILE_INVALID','Choose a regular document folder.');const target=path.join(parent,path.basename(file));return modifying(noteId,target,async()=>{let existing=null;if(fs.existsSync(target))existing=selected(target);const b={noteId,bindingId:randomUUID(),path:target,root:parent,managed:false,newline:existing?.newline||'\n',bom:existing?.bom||false};const bytes=Buffer.from((b.bom?'\uFEFF':'')+value.replace(/\n/g,b.newline));if(bytes.length>MAX)fail('NOTE_FILE_INVALID','The encoded document exceeds 2 MB.');await atomic(target,bytes,()=>{if(existing){if(read(b).hash!==existing.hash)fail('NOTE_FILE_CONFLICT','The destination changed during Save As.');}else if(fs.existsSync(target))fail('NOTE_FILE_CONFLICT','A document appeared at the selected destination. Choose Save As again.');});await register(noteId,b);return info(b,{text:value,hash:hash(bytes)});});}),
    reload:(noteId,{bindingId}={})=>run(()=>info(binding(noteId,bindingId))),
    undo:(noteId,options)=>run(()=>writeInternal(noteId,options)),
    verify:(noteId,{bindingId,expectedHash})=>run(()=>{const b=binding(noteId,bindingId),r=read(b);if(r.hash!==expectedHash)fail('NOTE_FILE_CONFLICT','The disk document has a newer revision. Reload or wait for the current update.');return info(b,r);}),
    agentTarget:(noteId,{bindingId,expectedHash})=>run(()=>{const b=binding(noteId,bindingId),r=read(b);if(r.hash!==expectedHash)fail('NOTE_FILE_CONFLICT','The document changed before Codex could open it. Reload the document and try again.');return {...info(b,r),root:b.root,file:b.path};})
  };
}
module.exports={createNoteFiles,documentPath};
