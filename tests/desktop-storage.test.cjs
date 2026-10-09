'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createRuntime,ORIGIN}=require('../desktop/worker-runtime.cjs');
function filesystemError(code){return Object.assign(new Error('Fixture rename '+code),{code});}
async function fixture(t,{rename,wait}={}){
  const folder=fs.mkdtempSync(path.join(__dirname,'desktop-storage-'));
  const dataFile=path.join(folder,'notes.json'),uiRoot=path.join(folder,'ui');fs.mkdirSync(uiRoot);
  fs.writeFileSync(dataFile,JSON.stringify({previous:'canonical snapshot'}));
  fs.writeFileSync(path.join(uiRoot,'worker.js'),`chrome.runtime.onMessage.addListener((message,sender,reply)=>{chrome.storage.local.set(message.values).then(()=>reply({ok:true}),error=>reply({ok:false,error:error.message,code:error.code}));return true;});`);
  const attempts=[],delays=[],unlinks=[];
  const storageIO={mkdir:fs.promises.mkdir.bind(fs.promises),open:fs.promises.open.bind(fs.promises),async rename(from,to){attempts.push({from,to,text:fs.readFileSync(from,'utf8')});if(rename)await rename(from,to,attempts.length);else await fs.promises.rename(from,to);},async unlink(target){unlinks.push(target);return fs.promises.unlink(target);}};
  const tab={id:1,windowId:1,url:ORIGIN+'/editor.html',active:true};
  const windows={async get(){return tab;},async list(){return [tab];},async create(){return tab;},async update(){return tab;},async remove(){},async openSettings(){},async save(){}};
  const runtime=createRuntime({uiRoot,dataFile,native:async()=>({ok:true}),windows,storageIO,retryWait:async milliseconds=>{delays.push(milliseconds);if(wait)await wait(milliseconds);}});
  t.after(async()=>{await runtime.close().catch(()=>undefined);const target=path.resolve(folder),root=path.resolve(__dirname);assert(target.startsWith(root+path.sep));fs.rmSync(target,{recursive:true,force:true});});
  return {runtime,dataFile,attempts,delays,unlinks,write:values=>runtime.request('STORE_SET',{values},{id:1,url:tab.url}),read:()=>JSON.parse(fs.readFileSync(dataFile,'utf8'))};
}
for(const code of ['EPERM','EACCES','EBUSY'])test('atomic save retries transient '+code+' without touching the canonical file',async t=>{
  let f;f=await fixture(t,{async rename(from,to,attempt){assert.deepEqual(f.read(),{previous:'canonical snapshot'});if(attempt<3)throw filesystemError(code);await fs.promises.rename(from,to);}});
  const result=await f.write({acceptedStage:'latest AI revision'});assert.equal(result.ok,true);assert.equal(f.attempts.length,3);assert.deepEqual(f.delays,[50,100]);assert.equal(f.unlinks.length,0);assert.deepEqual(f.read(),{previous:'canonical snapshot',acceptedStage:'latest AI revision'});assert.equal(fs.existsSync(f.dataFile+'.tmp'),false);assert(f.attempts.every(item=>item.text===f.attempts[0].text));
});
test('exhausted transient rename failures report the error and preserve the last saved file',async t=>{
  const f=await fixture(t,{async rename(){throw filesystemError('EPERM');}});const result=await f.write({unsaved:'new snapshot'});assert.equal(result.ok,false);assert.equal(result.code,'EPERM');assert.equal(f.attempts.length,6);assert.deepEqual(f.delays,[50,100,200,400,800]);assert.deepEqual(f.read(),{previous:'canonical snapshot'});assert.deepEqual(f.unlinks,[f.dataFile+'.tmp']);assert.equal(fs.existsSync(f.dataFile+'.tmp'),false);await assert.rejects(f.runtime.close(),error=>error.code==='EPERM');
});
test('nonretryable rename failures report immediately and clean only the temporary file',async t=>{
  const f=await fixture(t,{async rename(){throw filesystemError('ENOSPC');}});const result=await f.write({unsaved:'new snapshot'});assert.equal(result.ok,false);assert.equal(result.code,'ENOSPC');assert.equal(f.attempts.length,1);assert.deepEqual(f.delays,[]);assert.deepEqual(f.read(),{previous:'canonical snapshot'});assert.deepEqual(f.unlinks,[f.dataFile+'.tmp']);assert.equal(fs.existsSync(f.dataFile+'.tmp'),false);
});
test('a queued snapshot waits for retries and cannot replace the shared temporary file early',async t=>{
  let release,waiting;const blocked=new Promise(resolve=>{waiting=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{async rename(from,to,attempt){if(attempt===1)throw filesystemError('EBUSY');await fs.promises.rename(from,to);},async wait(){waiting();await gate;}});
  const first=f.write({first:'accepted'});await blocked;const second=f.write({second:'accepted'});
  // The second local mutation can queue while the first snapshot waits, but it
  // must not open/truncate the shared temporary file until that rename finishes.
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.attempts.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile+'.tmp','utf8')),{previous:'canonical snapshot',first:'accepted'});assert.deepEqual(f.read(),{previous:'canonical snapshot'});
  release();assert.equal((await first).ok,true);assert.equal((await second).ok,true);assert.equal(f.attempts.length,3);assert.deepEqual(f.attempts.map(item=>JSON.parse(item.text)),[{previous:'canonical snapshot',first:'accepted'},{previous:'canonical snapshot',first:'accepted'},{previous:'canonical snapshot',first:'accepted',second:'accepted'}]);assert.deepEqual(f.read(),{previous:'canonical snapshot',first:'accepted',second:'accepted'});assert.equal(fs.existsSync(f.dataFile+'.tmp'),false);
});
test('a permanent failure does not prevent the next queued snapshot from saving',async t=>{
  const f=await fixture(t,{async rename(from,to,attempt){if(attempt===1)throw filesystemError('EIO');await fs.promises.rename(from,to);}});assert.equal((await f.write({first:'retained in recovery memory'})).ok,false);assert.deepEqual(f.read(),{previous:'canonical snapshot'});assert.equal((await f.write({second:'next save'})).ok,true);assert.deepEqual(f.read(),{previous:'canonical snapshot',first:'retained in recovery memory',second:'next save'});assert.equal(f.attempts.length,2);assert.equal(fs.existsSync(f.dataFile+'.tmp'),false);
});
