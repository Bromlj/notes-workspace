'use strict';
importScripts('core.js');
const C = NotesCore;
const CHAT = chrome.runtime.getURL('editor.html');
const ORIGIN = globalThis.NotesEnvironment?.origin || `chrome-extension://${chrome.runtime.id}`;
let serial = Promise.resolve();
let privacyEpoch = 0;
const patchQueues = new Map();
// Serialise storage mutations so multiple windows cannot race each other.
function exclusive(fn) {
  const task = serial.then(fn, fn);
  serial = task.catch(() => undefined);
  return task;
}
async function local(key, fallback) { const v = await chrome.storage.local.get(key); return v[key] ?? fallback; }
async function state(id) { const k = `tab:${id}`; return (await chrome.storage.session.get(k))[k] || {}; }
function patch(id, values) {
  const next = (patchQueues.get(id) || Promise.resolve()).catch(() => undefined).then(async () => {
    await chrome.storage.session.set({[`tab:${id}`]: {...await state(id), ...values}});
  });
  patchQueues.set(id, next);
  return next.finally(() => { if (patchQueues.get(id) === next) patchQueues.delete(id); });
}
const editorPorts = new Map();
const portWaits = new Map();
let portSequence = 0;
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'editor' || port.sender?.url?.split(/[?#]/)[0] !== `${ORIGIN}/editor.html`) return;
  let tabId;
  port.onMessage.addListener(async m => {
    if(m.heartbeat)return;
    if (m.hello != null) {
      try { const tab = await chrome.tabs.get(m.hello); if (tab.url?.split(/[?#]/)[0] !== CHAT) return; tabId=tab.id; editorPorts.set(tabId,port); } catch {} return;
    }
    if (portWaits.has(m.replyTo)) { const p=portWaits.get(m.replyTo); if(p.port!==port)return; clearTimeout(p.timer);portWaits.delete(m.replyTo);p.resolve(m.result); }
  });
  port.onDisconnect.addListener(()=>{if(editorPorts.get(tabId)===port)editorPorts.delete(tabId);});
});
async function send(id,msg) {
  const port=editorPorts.get(id);if(!port)return null;
  return new Promise(resolve=>{const requestId=++portSequence;const timer=setTimeout(()=>{portWaits.delete(requestId);resolve(null)},3000);portWaits.set(requestId,{resolve,timer,port});try{port.postMessage({...msg,requestId});}catch{clearTimeout(timer);portWaits.delete(requestId);resolve(null)}});
}
let catalogCache=null, connectionConfig=null;
const running=new Map();
async function native(action,data={}) {
  if (typeof globalThis.NotesNative === 'function') {
    const result = await globalThis.NotesNative(action,data);
    if (!result?.ok) throw new Error(result?.error || 'The Codex connection was interrupted.');
    return result;
  }
  try {
    if(!connectionConfig)connectionConfig=await (await fetch(chrome.runtime.getURL('connection.json'))).json();
    const response=await fetch(`http://127.0.0.1:${connectionConfig.port}/command`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connectionConfig.token},body:JSON.stringify({action,...data}),signal:AbortSignal.timeout(70000)});
    const result=await response.json();if(!result.ok)throw new Error(result.error);return result;
  }catch(e){if(e instanceof TypeError || e.name==='TimeoutError')throw new Error('The Codex connector is unavailable. Open Notes Workspace from its desktop shortcut, then press Reconnect.');throw e;}
}
let polling=false, lastUpdate=new Map();
async function pollReplies() {
  if(polling||!running.size)return;polling=true;
  try {
    const result=await native('updates',{ids:[...running.keys()]});
    for(const e of result.updates)if(lastUpdate.get(e.requestId)!==e.at){lastUpdate.set(e.requestId,e.at);await exclusive(()=>nativeUpdate(e));}
    for(const id of result.missing||[]) {
      const job=running.get(id);if(!job)continue;const a=await local(`assistant:${job.assistantId}`,null);
      if(a?.pending && Date.now()-a.pending.startedAt>15000)await exclusive(()=>nativeUpdate({requestId:id,status:'failed',error:'The connector restarted before this response could be recovered. Your saved text is retained; the question was not resent.'}));
    }
  }
  catch(e){for(const id of running.keys())await exclusive(()=>nativeUpdate({requestId:id,status:'failed',error:e.message}));}
  finally{polling=false;}
}
setInterval(()=>void pollReplies(),600);
async function catalog(refresh=false) { if(!catalogCache||refresh)catalogCache=await native('catalog');return catalogCache; }
async function selection() {
  const c=await catalog(),saved=await local('codexSelection',{});
  const model=c.models.find(m=>m.model===saved.model)||c.models.find(m=>m.isDefault)||c.models[0];
  if(!model)throw new Error('Codex returned no models for this account.');
  const effort=model.supportedReasoningEfforts.some(e=>e.reasoningEffort===saved.effort)?saved.effort:model.defaultReasoningEffort;
  return {models:c.models,model:model.model,effort,accountType:c.accountType,defaultProject:c.defaultProject};
}
async function nativeUpdate(e) {
  const job=running.get(e.requestId);if(!job)return;
  const a=await local(`assistant:${job.assistantId}`,null);if(!a?.pending||a.pending.id!==e.requestId)return;
  if(e.threadId)a.threadId=e.threadId;if(typeof e.text==='string')a.pending.text=e.text;
  if(typeof e.noteFileError==='string')a.noteFileError=e.noteFileError;
  for(const key of ['activity','diff','plan','requests'])if(e[key]!==undefined)a.pending[key]=e[key];
  const edited=e.noteEdit,base=a.pending.noteEditBase;
  if(a.editNote===true&&base&&edited&&edited.noteId===a.noteId&&edited.baseRevision===base.revision&&Number.isSafeInteger(edited.sequence)&&edited.sequence>=0&&edited.sequence>(a.pending.noteEditDiscardedSequence??-1)&&typeof edited.text==='string'&&new TextEncoder().encode(edited.text).length<=C.MAX_TEXT_BYTES&&(!a.noteEditStage||a.noteEditStage.requestId!==e.requestId||edited.sequence>a.noteEditStage.sequence)) {
    const previous=a.noteEditStage?.requestId===e.requestId?a.noteEditStage:null;
    const applied=a.pending.noteEditAppliedBase;
    a.noteEditStage={requestId:e.requestId,text:edited.text,sequence:edited.sequence,baseRevision:previous?.baseRevision??applied?.revision??base.revision,baseText:previous?.baseText??applied?.text??base.text,baseHtml:previous?.baseHtml??applied?.html??base.html,conflict:false};
    if(edited.file?.noteId===a.noteId&&typeof edited.file.bindingId==='string'&&/^[a-f0-9-]{36}$/i.test(edited.file.bindingId)&&typeof edited.file.hash==='string'&&/^[a-f0-9]{64}$/.test(edited.file.hash)){a.noteEditStage.file=edited.file;a.noteFileError='';}
    await applyNoteStage(a);
  }
  a.pending.phase=e.phase||a.pending.phase;
  if(e.status!=='working') { if(a.pending.text)a.messages.push({role:'assistant',text:a.pending.text});for(const key of ['activity','diff','plan'])a[key]=a.pending[key]|| (key==='diff'?'':[]);a.pending=null;a.error=e.error||'';running.delete(e.requestId); }
  await saveAssistant(a);
  // A running conversation belongs to its note, not to whichever note is now
  // selected in the same browser window.
  for(const tabId of editorPorts.keys())if((await state(tabId)).assistantId===a.id)await send(tabId,{type:'AI_UPDATE',assistant:a});
}
function unappliedNoteStage(a){return !!a.noteEditStage&&a.noteEditStage.appliedRevision==null;}
async function applyNoteStage(a,force=false,fileGuard={}){
  const stage=a.noteEditStage;
  // An explicit confirmed Apply is consent for this revision only. Automatic
  // syncing still requires the separate persistent note-editing permission.
  if(!stage||(a.editNote!==true&&!force))return {applied:false,reason:'disabled'};
  if(stage.appliedRevision!=null)return {applied:false,reason:'already_applied'};
  stage.text=stage.text.replace(/\r\n?/g,'\n');
  if(stage.requiresApply&&!force){stage.conflict=true;return {applied:false,conflict:true,reason:'explicit_apply'};}
  let owner;
  for(const tabId of editorPorts.keys()){const s=await state(tabId);if(s.noteId===a.noteId&&s.assistantId===a.id&&s.private===false&&s.editorFrame===0){owner=tabId;break;}}
  // The canonical ordinary note is never changed by a hidden/inactive proposal.
  // Its separately saved AI stage may continue advancing in the background.
  if(owner==null)return {applied:false,reason:'hidden'};
  const stored=await local(`note:${a.noteId}`,null);if(!stored)return {applied:false,reason:'missing_note'};
  const n=C.note(stored,a.noteId);
  let writeDisk=false;
  if(stage.file){try{stage.file=(await native('noteVerify',{noteId:a.noteId,bindingId:stage.file.bindingId,expectedHash:stage.file.hash})).file||stage.file;}catch(error){stage.conflict=true;a.noteFileError=error.message;return {applied:false,conflict:true,reason:'disk_changed',error:error.message};}}
  else if(typeof globalThis.NotesNative==='function'){
    // Backups and releases before direct documents contain text-only stages.
    // They need a fresh, guarded disk write rather than a UI-only projection.
    const current=(await native('noteStatus',{noteId:n.id,text:n.text})).file;
    if(current){writeDisk=true;if(!force){stage.requiresApply=true;stage.conflict=true;return {applied:false,conflict:true,reason:'explicit_apply'};}}
  }
  if(!force&&(n.revision!==stage.baseRevision||n.text!==stage.baseText||n.html!==stage.baseHtml)){stage.conflict=true;return {applied:false,conflict:true,reason:'local_changes'};}
  if(n.text===stage.text&&!writeDisk){Object.assign(stage,{baseRevision:n.revision,baseText:n.text,baseHtml:n.html,appliedRevision:n.revision,conflict:false});if(a.pending?.id===stage.requestId)a.pending.noteEditAppliedBase={revision:n.revision,text:n.text,html:n.html};if(stage.file)await send(owner,{type:'NOTE_FILE_PRESENTED',noteId:n.id,file:stage.file});return {applied:false,reason:'unchanged'};}
  const response=await send(owner,{type:'NOTE_AI_PROPOSE',assistantId:a.id,noteId:a.noteId,editRequestId:stage.requestId,confirmed:force===true,text:stage.text,expectedRevision:n.revision,expectedText:n.text,expectedHtml:n.html,...(stage.file?{file:stage.file}:{} )});
  if(!response?.accepted){
    if(response?.reason!=='hidden'&&response?.reason!=='context_changed')stage.conflict=true;
    // A timed-out proposal may still reach the renderer. Its ordered failure
    // releases a late commit latch without adopting an unpersisted revision.
    await send(owner,{type:'NOTE_AI_FAILED',noteId:n.id,editRequestId:stage.requestId,error:response?.reason||'The editor did not accept the proposed note change.',revision:n.revision,updatedAt:n.updatedAt});
    return {applied:false,conflict:stage.conflict,reason:response?.reason||'unavailable'};
  }
  try{
    const value=response.note;
    if(!value||value.id!==n.id||value.text!==stage.text||typeof value.html!=='string'||value.html.length>C.MAX_TEXT_BYTES)throw Error('The editor did not acknowledge the expected note revision.');
    if(writeDisk)stage.file=(await native('noteSave',{noteId:n.id,text:stage.text,bindingId:fileGuard.bindingId,expectedHash:fileGuard.expectedHash})).file;
    const next=C.note({...n,text:value.text,html:value.html,revision:n.revision+1,updatedAt:Date.now()},n.id);
    await chrome.storage.local.set({[`note:${n.id}`]:next});
    Object.assign(stage,{baseRevision:next.revision,baseText:next.text,baseHtml:next.html,appliedRevision:next.revision,conflict:false});delete stage.requiresApply;
    if(a.pending?.id===stage.requestId)a.pending.noteEditAppliedBase={revision:next.revision,text:next.text,html:next.html};
    const committed=await send(owner,{type:'NOTE_AI_COMMITTED',noteId:next.id,revision:next.revision,updatedAt:next.updatedAt,text:next.text,html:next.html,editRequestId:stage.requestId,...(stage.file?{file:stage.file}:{} )});
    if(!committed?.ok)throw Error('The editor did not acknowledge the saved AI note change.');
    return {applied:true};
  }catch(error){
    if(stage.appliedRevision==null)stage.conflict=true;
    // Release the frontend commit latch even when a durable write fails. Read
    // back metadata because an adapter may already have advanced memory state.
    const current=await local(`note:${n.id}`,null).catch(()=>null);
    await send(owner,{type:'NOTE_AI_FAILED',noteId:n.id,editRequestId:stage.requestId,error:error.message,revision:current?.revision,updatedAt:current?.updatedAt});
    return {applied:false,conflict:stage.conflict,reason:'save_failed',error:error.message};
  }
}
async function chatTabs() { return (await chrome.tabs.query({})).filter(t=>t.url?.split(/[?#]/)[0]===CHAT); }
async function applyNotifications() {
  // Clear the rule from older releases. A notepad must not change notifications
  // for the user's ordinary ChatGPT tabs in the same profile.
  await chrome.contentSettings.notifications.clear({scope: 'regular'});
}
async function noteForTab(tabId) {
  const s = await state(tabId);
  if (s.noteId) {
    const existing = await local(`note:${s.noteId}`, null);
    if (existing) return C.note(existing, s.noteId);
  }
  let id = await local('lastNoteId', null);
  const sessions = await chrome.storage.session.get(null);
  const inUse = new Set(Object.entries(sessions).filter(([k]) => k.startsWith('tab:')).map(([,v]) => v.noteId));
  if (id && inUse.has(id)) id = null;
  let n = id ? await local(`note:${id}`, null) : null;
  if (!n) {
    id = crypto.randomUUID(); n = C.note({updatedAt: Date.now()}, id);
    await chrome.storage.local.set({[`note:${id}`]: n, lastNoteId: id});
  }
  await patch(tabId, {noteId: id});
  return C.note(n, id);
}
async function configureTab(tabId) {
  const t = await chrome.tabs.get(tabId);
  const s = await state(tabId);
  if (!s.managed) await patch(tabId, {managed: true, originalDiscardable: t.autoDiscardable, mutedBefore: t.mutedInfo?.muted === true});
  await chrome.tabs.update(tabId, {autoDiscardable: false});
}
async function hideOne(tabId) {
  // Paint first; never wait for storage, audio or network operations to hide content.
  const painting = send(tabId, {type: 'COVER'});
  const s = await state(tabId);
  try {
    const t = await chrome.tabs.get(tabId);
    const changes = {private: true, restoreToken:null};
    if (!s.private) changes.mutedBefore = t.mutedInfo?.muted === true;
    await patch(tabId, changes);
    await chrome.tabs.update(tabId, {muted: true, autoDiscardable: false});
  } catch { /* A closing tab needs no further work. */ }
  if (s.editorFrame != null) await send(tabId, {type: 'CANCEL_RESTORE'}, s.editorFrame);
  await painting;
}
async function hideAll() { await Promise.all((await chatTabs()).map(async t => { const s = await state(t.id); if (s.workspace && s.managed) await hideOne(t.id); })); }
async function revealOne(tabId, expectedEpoch = privacyEpoch, token) {
  if (expectedEpoch !== privacyEpoch) throw new Error('Restore cancelled.');
  const s = await state(tabId);
  if (expectedEpoch !== privacyEpoch) throw new Error('Restore cancelled.');

  if (expectedEpoch !== privacyEpoch) { await hideOne(tabId); throw new Error('Restore cancelled.'); }
  const opened = await send(tabId, {type:'AI_MODE', token}, s.editorFrame);
  if (!opened?.ok || expectedEpoch !== privacyEpoch) { await hideOne(tabId); throw new Error('Restore cancelled.'); }
  await patch(tabId, {private: false});
  if (expectedEpoch !== privacyEpoch) { await hideOne(tabId); throw new Error('Restore cancelled.'); }
}
async function resume(tabId, epoch = privacyEpoch, token) {
  if (epoch !== privacyEpoch || typeof token !== 'string' || token.length > 100 || !token) throw new Error('Restore cancelled.');
  await patch(tabId, {restoreToken:token});
  const auth = await local('accessLock', null);
  if (epoch !== privacyEpoch) throw new Error('Restore cancelled.');
  if (auth) {
    const s = await state(tabId);
    if (s.editorFrame == null) throw new Error('The editor is still loading. Try again in a moment.');
    if (epoch !== privacyEpoch) throw new Error('Restore cancelled.');
    const prompt = await send(tabId, {type: 'UNLOCK_PROMPT', token}, s.editorFrame);
    if (!prompt?.ok || epoch !== privacyEpoch) throw new Error('Restore cancelled.');
    return {locked: true};
  }
  await revealOne(tabId, epoch, token); return {locked: false};
}
function bytesToBase64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function base64ToBytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256'}, key, 256));
}
async function checkPassword(password, auth) {
  if (!auth) return true;
  if (typeof password !== 'string' || password.length > 1024) return false;
  const got = await derive(password, base64ToBytes(auth.salt));
  const expected = base64ToBytes(auth.hash);
  let mismatch = got.length ^ expected.length;
  for (let i = 0; i < got.length; i++) mismatch |= got[i] ^ (expected[i] || 0);
  return mismatch === 0;
}
async function verifyWithLimit(password) {
  const k = 'unlockRate';
  const limit = (await chrome.storage.session.get(k))[k] || {failed: 0, until: 0};
  if (limit.until > Date.now()) throw new Error('Too many attempts. Try again in 30 seconds.');
  const ok = await checkPassword(password, await local('accessLock', null));
  if (!ok) {
    const failed = limit.failed + 1;
    await chrome.storage.session.set({[k]: {failed: failed >= 5 ? 0 : failed, until: failed >= 5 ? Date.now() + 30000 : 0}});
    throw new Error('Incorrect passphrase.');
  }
  await chrome.storage.session.remove(k);
}
async function launch() {
  for(const tab of await chatTabs()) { await hideOne(tab.id); await chrome.windows.update(tab.windowId,{focused:true});return {windowId:tab.windowId}; }
  const win=await chrome.windows.create({url:CHAT,type:'popup',width:1180,height:820});return {windowId:win.id};
}
function extensionPage(sender, name) { return sender.url?.split(/[?#]/)[0] === `${ORIGIN}/${name}`; }
function requireEditor(sender) { if (!extensionPage(sender, 'editor.html') || !sender.tab) throw new Error('This action must come from the local editor.'); }
function requireSettings(sender) { if (!extensionPage(sender, 'options.html')) throw new Error('This action must come from Settings.'); }
async function assistantForTab(tabId) {
  const s = await state(tabId);
  if(!s.noteId)throw new Error('Open a note first.');
  let id = await local(`noteAssistant:${s.noteId}`,null);
  if(!id){
    // Bind the pre-4.1 conversation once without copying it into every note.
    const candidateId=s.assistantId||await local('lastAssistantId',null),candidate=candidateId?await local(`assistant:${candidateId}`,null):null;
    if(candidate&&(!candidate.noteId||candidate.noteId===s.noteId))id=candidateId;
  }
  if (id) {
    const sessions = await chrome.storage.session.get(null);
    if (Object.entries(sessions).some(([key,value]) => key !== `tab:${tabId}` && value.assistantId === id)) id = null;
  }
  if (!id) id = crypto.randomUUID();
  let value = await local(`assistant:${id}`, {id,agentVersion:4,noteId:s.noteId,messages:[],draft:'',pending:null,error:''});
  value.editNote=value.editNote===true;
  // Old threads retained tool-disabling instructions in their Codex history.
  // Preserve them in History and start a clean agent thread for the upgrade.
  if(value.agentVersion!==4&&!value.pending){id=crypto.randomUUID();value={id,agentVersion:4,noteId:s.noteId,messages:[],draft:value.draft||'',pending:null,error:'Codex agent mode is ready. Choose a project folder in Options to work on your files.'};}
  value.noteId=s.noteId;
  if (value.pending && value.pending.startedAt) { running.set(value.pending.id,{tabId,assistantId:id}); }
  if (value.pending && !value.pending.startedAt) {
    if (value.pending.text) value.messages.push({role:'assistant',text:value.pending.text});
    value.pending = null; value.error = 'The previous window closed during a reply. Its saved text is shown; completion is unverified and nothing was resent.';
    await saveAssistant(value);
  }
  await bindAssistant(tabId,value);
  return value;
}
async function saveAssistant(value) { value.updatedAt=Date.now();await chrome.storage.local.set({[`assistant:${value.id}`]:value}); }
async function bindAssistant(tabId,value){await saveAssistant(value);await chrome.storage.local.set({[`noteAssistant:${value.noteId}`]:value.id,lastAssistantId:value.id});await patch(tabId,{assistantId:value.id});}
function freshAssistant(noteId,project,draft=''){return {id:crypto.randomUUID(),agentVersion:4,noteId,project,messages:[],draft,pending:null,error:'',editNote:false};}
function projectKey(value){return String(value||'').replace(/[\\/]+$/,'').toLowerCase();}
async function projects(){
  let values=await local('projects',null);if(values)return values;
  const all=await chrome.storage.local.get(null);values=[];
  for(const [key,a]of Object.entries(all))if(key.startsWith('assistant:')&&a.agentVersion===4&&a.project&&!values.some(p=>projectKey(p.path)===projectKey(a.project)))values.push({id:crypto.randomUUID(),name:a.project.split(/[\\/]/).filter(Boolean).at(-1)||a.project,path:a.project,updatedAt:a.updatedAt||Date.now()});
  await chrome.storage.local.set({projects:values});return values;
}
async function rememberProject(folder,name){const values=await projects();let project=values.find(p=>projectKey(p.path)===projectKey(folder));if(!project){project={id:crypto.randomUUID(),path:folder};values.push(project);}project.name=typeof name==='string'&&name.trim()?name.trim().slice(0,100):project.name||folder.split(/[\\/]/).filter(Boolean).at(-1)||folder;project.updatedAt=Date.now();await chrome.storage.local.set({projects:values});return {project,projects:values.sort((a,b)=>b.updatedAt-a.updatedAt)};}
async function contextAssistant(tabId,m){const a=await assistantForTab(tabId);if(m.assistantId&&m.assistantId!==a.id)throw new Error('The selected note changed. Try again in the current tab.');return a;}
async function readContextAssistant(tabId,m){const s=await state(tabId),a=s.assistantId?await local(`assistant:${s.assistantId}`,null):null;if(!a||a.noteId!==s.noteId||(m.assistantId&&m.assistantId!==a.id))throw new Error('The selected note changed. Try again in the current tab.');return a;}
// Recover pending turns for inactive notes after a worker restart as well.
void exclusive(async()=>{const all=await chrome.storage.local.get(null);for(const [key,a]of Object.entries(all))if(key.startsWith('assistant:')&&a.pending?.startedAt)running.set(a.pending.id,{tabId:null,assistantId:a.id});});
async function activeEditor(sender, epoch) {
  requireEditor(sender);
  const s = await state(sender.tab.id);
  if (s.editorFrame !== sender.frameId || s.private !== false || epoch !== privacyEpoch) throw new Error('The panel is disabled. Press Alt+W to enable it.');
  return s;
}
async function dispatch(m, sender, requestEpoch = privacyEpoch) {
  if (!m || typeof m.type !== 'string' || sender.id !== chrome.runtime.id) throw new Error('Invalid request.');
  const tabId = sender.tab?.id;
  switch (m.type) {
    case 'EDITOR_READY': {
      requireEditor(sender);
      await patch(tabId, {workspace:true,managed:true,private:true,editorFrame:0});
      await chrome.tabs.update(tabId,{autoDiscardable:false});
      const n = await noteForTab(tabId);
      return {note: n, assistant:await assistantForTab(tabId), options: C.options(await local('options', null))};
    }
    case 'HIDE': {
      if (!C.isChatUrl(sender.url) && !extensionPage(sender, 'editor.html')) throw new Error('Unsupported page.');
      await hideAll(); return {};
    }
    case 'RESUME': {
      requireEditor(sender); return resume(tabId, requestEpoch, m.token);
    }
    case 'UNLOCK': {
      requireEditor(sender); if (requestEpoch !== privacyEpoch || !m.token || (await state(tabId)).restoreToken !== m.token) throw new Error('Restore cancelled.'); await verifyWithLimit(m.password); await revealOne(tabId, requestEpoch, m.token); return {};
    }
    case 'AI_READY': { requireEditor(sender); return {assistant:await assistantForTab(tabId)}; }
    case 'NOTE_FILE_CONTEXT': {requireEditor(sender);const n=await noteForTab(tabId);return {note:n,assistant:await assistantForTab(tabId)};}
    case 'NAME_NOTE_FILE': {
      requireEditor(sender);const s=await state(tabId);if(s.noteId!==m.noteId)throw Error('The selected note changed.');const old=C.note(await local(`note:${s.noteId}`,null),s.noteId),n=C.note({...old,name:m.name,revision:old.revision+1,updatedAt:Date.now()},old.id);await chrome.storage.local.set({[`note:${n.id}`]:n});const a=await assistantForTab(tabId);
      // Save As deliberately changes this note's binding. Keep any unseen AI
      // result as a preview for the new file, without retaining the old grant.
      if(unappliedNoteStage(a)&&typeof m.bindingId==='string'){delete a.noteEditStage.file;a.noteEditStage.requiresApply=true;a.noteEditStage.conflict=true;await saveAssistant(a);}
      return {note:n,assistant:a};
    }
    case 'NOTE_FILE_PROJECT': {
      requireEditor(sender);let a=await assistantForTab(tabId);if(m.noteId!==a.noteId)throw Error('The selected note changed.');
      const selected=await native('noteProject',{noteId:a.noteId});
      if(selected.path&&!a.projectExplicit&&(!a.project||projectKey(a.project)===projectKey(selected.defaultProject))){if(a.threadId)a=freshAssistant(a.noteId,selected.path,a.draft);else a.project=selected.path;await bindAssistant(tabId,a);}
      return {note:await noteForTab(tabId),assistant:a};
    }
    case 'RELOAD_NOTE_FILE': {
      requireEditor(sender);const s=await state(tabId);if(s.noteId!==m.noteId)throw Error('The selected note changed.');const a=await assistantForTab(tabId);if(a.pending)throw Error('Finish or stop the active turn before reloading the document.');
      if(typeof m.text!=='string'||new TextEncoder().encode(m.text).length>C.MAX_TEXT_BYTES)throw Error('The document exceeds 2 MB.');
      const old=C.note(await local(`note:${s.noteId}`,null),s.noteId),n=C.note({...old,text:m.text.replace(/\r\n?/g,'\n'),html:'',name:m.name||old.name,revision:old.revision+1,updatedAt:Date.now()},old.id);
      await chrome.storage.local.set({[`note:${n.id}`]:n});a.noteEditStage=null;a.noteFileError='';if(m.relinked)a.editNote=false;await saveAssistant(a);return {note:n,assistant:a};
    }
    case 'AI_DRAFT': {
      requireEditor(sender);
      if (typeof m.text !== 'string' || m.text.length > C.MAX_TEXT_BYTES) throw new Error('Draft too large.');
      const a = await contextAssistant(tabId,m); a.draft = m.text; await saveAssistant(a); return {};
    }
    case 'AI_NOTE_EDIT_SET': {
      await activeEditor(sender,requestEpoch);if(typeof m.enabled!=='boolean')throw new Error('Choose whether Codex may edit this note.');
      const a=await contextAssistant(tabId,m);a.editNote=m.enabled;
      // Turning editing off stops further app updates for this run. An already
      // accepted Codex file grant lasts until the turn finishes or is stopped.
      if(!m.enabled&&a.pending){delete a.pending.noteEditBase;delete a.pending.noteEditAppliedBase;}
      await saveAssistant(a);return {assistant:a};
    }
    case 'AI_NOTE_SYNC': case 'AI_NOTE_APPLY': {
      await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);
      const result=await applyNoteStage(a,m.type==='AI_NOTE_APPLY'&&m.force===true,{bindingId:m.bindingId,expectedHash:m.expectedHash});
      await saveAssistant(a);return {assistant:a,...result};
    }
    case 'AI_NOTE_DISCARD': {
      await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);
      if(a.pending&&a.noteEditStage?.requestId===a.pending.id)a.pending.noteEditDiscardedSequence=a.noteEditStage.sequence;
      a.noteEditStage=null;await saveAssistant(a);return {assistant:a};
    }
    case 'AI_SEND': {
      await activeEditor(sender,requestEpoch);
      if(typeof m.id!=='string'||!/^[a-f0-9-]{36}$/.test(m.id)||typeof m.text!=='string'||!m.text.trim()||m.text.length>500000)throw new Error('Invalid question.');
      const settings=await selection();await activeEditor(sender,requestEpoch);
      const a=await contextAssistant(tabId,m);if(a.pending)throw new Error('A response is already running.');
      let noteEdit,noteFile;
      if(a.editNote===true){
        if(unappliedNoteStage(a))throw new Error('Apply or discard the pending AI note changes before starting another note-editing task.');
        const n=C.note(await local(`note:${a.noteId}`,null),a.noteId);
        if(typeof globalThis.NotesNative==='function')noteFile=(await native('notePrepare',{noteId:n.id,text:n.text,bindingId:m.noteBindingId,expectedHash:m.noteFileHash})).file;
        await activeEditor(sender,requestEpoch);
        noteEdit={noteId:a.noteId,text:n.text,revision:n.revision,...(noteFile?{bindingId:noteFile.bindingId,fileHash:noteFile.hash}:{} )};a.noteEditStage=null;
      }
      const files=Array.isArray(m.files)?m.files.slice(0,20):[];
      a.pending={id:m.id,text:'',phase:'Starting',startedAt:Date.now()};
      if(noteEdit){const n=await local(`note:${a.noteId}`,null);a.pending.noteEditBase={revision:noteEdit.revision,text:noteEdit.text,html:n?.html||''};}
      a.error='';a.messages.push({role:'user',text:m.text});a.draft='';await saveAssistant(a);
      running.set(m.id,{tabId,assistantId:a.id});
      // Submission runs outside the storage queue. Notes continue saving while
      // Codex starts, thinks and streams; hiding never cancels an accepted turn.
      void native('send',{requestId:m.id,threadId:a.threadId,project:a.project,model:settings.model,effort:settings.effort,text:m.text,files,...noteEdit?{noteEdit}:{}}).then(r=>exclusive(async()=>{const latest=await local(`assistant:${a.id}`,null);if(latest){latest.threadId=r.threadId;latest.project=latest.project||settings.defaultProject;await saveAssistant(latest);}})).catch(error=>exclusive(()=>nativeUpdate({requestId:m.id,status:'failed',error:error.message})));
      return {assistant:a,...(noteFile?{file:noteFile}:{} )};
    }
    case 'AI_PROJECT': {
      await activeEditor(sender,requestEpoch);const current=await contextAssistant(tabId,m);if(current.pending)throw new Error('Finish or stop the active turn before changing projects.');
      const folder=await native('project',{path:m.path});await activeEditor(sender,requestEpoch);
      current.projectExplicit=true;
      const saved=await rememberProject(folder.path,m.name);
      if(projectKey(current.project)===projectKey(folder.path)){await saveAssistant(current);return {assistant:current,...saved};}
      const all=await chrome.storage.local.get(null);
      const previous=Object.entries(all).filter(([k,a])=>k.startsWith('assistant:')&&a.agentVersion===4&&a.noteId===current.noteId&&projectKey(a.project)===projectKey(folder.path)).map(([,a])=>a).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0];
      const a=previous||freshAssistant(current.noteId,folder.path,current.draft||'');a.projectExplicit=true;await bindAssistant(tabId,a);return {assistant:a,...saved};
    }
    case 'AI_PROJECTS': {await activeEditor(sender,requestEpoch);const a=await assistantForTab(tabId);return {projects:(await projects()).sort((a,b)=>b.updatedAt-a.updatedAt),currentProject:a.project||''};}
    case 'AI_HISTORY': {
      await activeEditor(sender,requestEpoch);const current=await assistantForTab(tabId),all=await chrome.storage.local.get(null);return {conversations:Object.entries(all).filter(([k,v])=>k.startsWith('assistant:')&&v.agentVersion===4&&projectKey(v.project)===projectKey(current.project)).map(([,v])=>({id:v.id,title:(v.messages.find(m=>m.role==='user')?.text||'New conversation').slice(0,90),project:v.project||'',noteId:v.noteId,noteName:all[`note:${v.noteId}`]?.name||'',updatedAt:v.updatedAt||0,pending:!!v.pending})).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,100)};
    }
    case 'AI_OPEN': {
      await activeEditor(sender,requestEpoch);await contextAssistant(tabId,m);
      const a=await local(`assistant:${m.id}`,null);if(!a||a.agentVersion!==4)throw new Error('This saved agent conversation is unavailable.');
      const all=await chrome.storage.session.get(null);if(Object.entries(all).some(([k,v])=>k!==`tab:${tabId}`&&v.assistantId===a.id))throw new Error('This conversation is open in another window.');
      let n=a.noteId?await local(`note:${a.noteId}`,null):null;
      if(!n){n=C.note({name:(a.messages.find(m=>m.role==='user')?.text||'Untitled').slice(0,50),updatedAt:Date.now()},crypto.randomUUID());await chrome.storage.local.set({[`note:${n.id}`]:n});a.noteId=n.id;}
      if(Object.entries(all).some(([k,v])=>k!==`tab:${tabId}`&&v.noteId===n.id))throw new Error('This note is open in another window.');
      await patch(tabId,{noteId:n.id});await chrome.storage.local.set({lastNoteId:n.id});await bindAssistant(tabId,a);return {note:C.note(n,n.id),assistant:await assistantForTab(tabId)};
    }
    case 'AI_REPLY': {
      await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);if(!a.pending)throw new Error('This turn is no longer waiting.');return native('reply',{threadId:a.threadId,requestId:a.pending.id,id:m.id,response:m.response});
    }
    case 'AI_STEER': {
      await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);if(!a.pending)throw new Error('The active turn finished. Send your follow-up again as a new question.');
      await native('steer',{threadId:a.threadId,requestId:a.pending.id,text:m.text,files:m.files||[]});a.messages.push({role:'user',text:m.text});a.draft='';await saveAssistant(a);return {assistant:a};
    }
    case 'AI_CAPABILITIES': {await activeEditor(sender,requestEpoch);const a=await readContextAssistant(tabId,m);return native('capabilities',{project:a.project});}
    case 'AI_COMPACT': {await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);if(a.pending)throw new Error('Finish the active turn first.');return native('compact',{threadId:a.threadId});}
    case 'AI_REVIEW': {
      await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);if(a.pending||!a.threadId)throw new Error('Send a question in this project and finish its turn before starting a review.');
      const id=crypto.randomUUID();a.pending={id,text:'',phase:'Starting review',startedAt:Date.now()};a.error='';a.messages.push({role:'user',text:'Review the uncommitted changes in this project.'});await saveAssistant(a);running.set(id,{tabId,assistantId:a.id});
      void native('review',{requestId:id,threadId:a.threadId}).catch(error=>exclusive(()=>nativeUpdate({requestId:id,status:'failed',error:error.message})));return {assistant:a};
    }
    case 'AI_CONTROLS': {
      await activeEditor(sender,requestEpoch);
      if(m.operation==='reconnect')await catalog(true);
      if(m.operation==='choose') {
        const current=await selection(),model=current.models.find(v=>v.model===m.model);
        if(!model||!model.supportedReasoningEfforts.some(v=>v.reasoningEffort===m.effort))throw new Error('Unsupported model or thinking level.');
        await activeEditor(sender,requestEpoch);await chrome.storage.local.set({codexSelection:{model:m.model,effort:m.effort}});
      }
      return selection();
    }
    case 'AI_UPLOAD': { await activeEditor(sender,requestEpoch);const a=await readContextAssistant(tabId,m); const result=await native('upload',{file:m.file});if(requestEpoch!==privacyEpoch||(await state(tabId)).assistantId!==a.id){void native('removeUpload',{fileId:result.fileId});throw new Error('Attachment cancelled because the selected note changed or the panel was hidden.');}return {attachment:{id:result.fileId,name:result.name}}; }
    case 'AI_REMOVE_UPLOAD': { requireEditor(sender);await native('removeUpload',{fileId:m.id});return {}; }
    case 'AI_STOP': { await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);if(a.pending)await native('stop',{threadId:a.threadId,requestId:a.pending.id});return {}; }
    case 'AI_NEW': {
      await activeEditor(sender,requestEpoch);const a=await contextAssistant(tabId,m);if(a.pending)throw new Error('Stop or finish the current response first.');
      const next=freshAssistant(a.noteId,a.project);await bindAssistant(tabId,next);return {assistant:next};
    }
    case 'SAVE_NOTE': {
      requireEditor(sender);
      if(typeof m.note?.html==='string' && m.note.html.length>C.MAX_TEXT_BYTES)throw new Error('Formatted note is too large. Export it before continuing.');
      if (!m.note || typeof m.note.text !== 'string' || new TextEncoder().encode(m.note.text).length > C.MAX_TEXT_BYTES) throw new Error('The note is too large. The limit is 2 MB.');
      const s = await state(tabId);
      if (s.noteId !== m.note.id) throw new Error('The note has changed. Reopen this window before editing further.');
      const previous = await local(`note:${s.noteId}`, null);
      if (previous && previous.revision !== m.note.revision) throw new Error('A newer copy of this note exists. Use Save as to keep your current text.');
      const n = C.note({...m.note, revision: (previous?.revision || 0) + 1, updatedAt: Date.now()}, s.noteId);
      await chrome.storage.local.set({[`note:${n.id}`]: n, lastNoteId: n.id});
      await send(tabId, {type: 'NOTE_NAME', name: n.name});
      if(typeof globalThis.NotesNative==='function'){
        try{const saved=await native('noteSave',{noteId:n.id,text:n.text,bindingId:m.bindingId,expectedHash:m.expectedHash});return {note:n,...(saved.file?{file:saved.file}:{} )};}
        catch(error){return {note:n,fileError:error.message};}
      }
      return {note:n};
    }
    case 'NEW_NOTE': {
      requireEditor(sender);
      const previous=await assistantForTab(tabId);
      const id = crypto.randomUUID();
      if (typeof m.text === 'string' && new TextEncoder().encode(m.text).length > C.MAX_TEXT_BYTES) throw new Error('The note is too large.');
      const n = C.note({name: m.name, text: m.text || '', updatedAt: Date.now()}, id);
      await chrome.storage.local.set({[`note:${id}`]: n, lastNoteId: id});
      await patch(tabId, {noteId: id});
      const a=freshAssistant(id,previous.project);await bindAssistant(tabId,a);
      a.projectExplicit=previous.projectExplicit===true;await saveAssistant(a);
      await send(tabId, {type: 'NOTE_NAME', name: n.name});
      return {note: n,assistant:a};
    }
    case 'RECENT_NOTES': {
      requireEditor(sender);
      const values = await chrome.storage.local.get(null);
      return {notes: Object.entries(values).filter(([k]) => k.startsWith('note:')).map(([, n]) => ({id: n.id, name: n.name, updatedAt: n.updatedAt})).sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 30)};
    }
    case 'OPEN_NOTE': {
      requireEditor(sender);
      if (typeof m.id !== 'string' || !/^[a-f0-9-]{36}$/.test(m.id)) throw new Error('Invalid note.');
      const existing = await local(`note:${m.id}`, null);
      if (!existing) throw new Error('This note is not available.');
      const all = await chrome.storage.session.get(null);
      const elsewhere = Object.entries(all).some(([k,v]) => k !== `tab:${tabId}` && k.startsWith('tab:') && v.noteId === m.id);
      let n = C.note(existing, m.id);
      if (elsewhere) {
        n = C.note({...n, name: `${n.name} (copy)`, revision: 0}, crypto.randomUUID());
        await chrome.storage.local.set({[`note:${n.id}`]: n});
        const originalId=await local(`noteAssistant:${m.id}`,null),original=originalId?await local(`assistant:${originalId}`,null):null;
        const a=freshAssistant(n.id,original?.project);await saveAssistant(a);await chrome.storage.local.set({[`noteAssistant:${n.id}`]:a.id});
      }
      await patch(tabId, {noteId: n.id});
      await chrome.storage.local.set({lastNoteId: n.id});
      await send(tabId, {type: 'NOTE_NAME', name: n.name});
      return {note: n,assistant:await assistantForTab(tabId)};
    }
    case 'DOWNLOAD_NOTE': {
      requireEditor(sender);
      if (typeof m.url !== 'string' || !m.url.startsWith(`blob:${ORIGIN}/`)) throw new Error('Invalid document.');
      const id = await chrome.downloads.download({url: m.url, filename: C.filename(m.name, !m.formatted), saveAs: true, conflictAction: 'uniquify'});
      return {downloadId: id};
    }
    case 'CLOSE_WINDOW': {
      requireEditor(sender); await chrome.tabs.remove(tabId); return {};
    }
    case 'GET_SETTINGS': {
      requireSettings(sender);
      return {options: C.options(await local('options', null)), hasPassphrase: !!await local('accessLock', null), commands: await chrome.commands.getAll(), version: C.VERSION};
    }
    case 'EXPORT_BACKUP': {
      requireSettings(sender);
      const all=await chrome.storage.local.get(null),data={};
      for(const [key,value]of Object.entries(all))if(/^(note:|assistant:|noteAssistant:)/.test(key)||['lastNoteId','lastAssistantId','projects','options','codexSelection','accessLock'].includes(key))data[key]=value;
      return {backup:{format:'notes-workspace-backup',version:5,data}};
    }
    case 'SAVE_SETTINGS': {
      requireSettings(sender);
      const o = C.options(m.options);
      await chrome.storage.local.set({options: o});
      await applyNotifications();
      for (const t of await chatTabs()) await send(t.id, {type: 'OPTIONS', options: o});
      return {};
    }
    case 'SET_PASSPHRASE': {
      requireSettings(sender);
      await verifyWithLimit(m.currentPassword || '');
      const password = m.newPassword;
      if (typeof password !== 'string' || password.length < 6 || password.length > 1024) throw new Error('Use a passphrase of 6–1024 characters.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      await chrome.storage.local.set({accessLock: {salt: bytesToBase64(salt), hash: bytesToBase64(await derive(password, salt))}});
      return {};
    }
    case 'REMOVE_PASSPHRASE': {
      requireSettings(sender); await verifyWithLimit(m.currentPassword || '');
      await chrome.storage.local.remove('accessLock'); return {};
    }
    case 'OPEN_SHORTCUTS': {
      requireSettings(sender);
      // Edge redirects chrome://extensions to its own equivalent.
      await chrome.tabs.create({url: 'chrome://extensions/shortcuts'}); return {};
    }
    case 'LAUNCH': {
      if (!extensionPage(sender, 'launch.html') && !extensionPage(sender, 'options.html')) throw new Error('Unsupported action.');
      return launch();
    }
    default: throw new Error('Unknown action.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Emergency concealment bypasses the serial queue (a password derivation or a
  // Save As dialog must never delay painting the cover).
  if (message?.type === 'HIDE' && sender.id === chrome.runtime.id && (C.isChatUrl(sender.url) || extensionPage(sender, 'editor.html'))) {
    privacyEpoch++;
    hideAll().then(() => reply({ok: true}), () => reply({ok: false, error: 'Could not contact the page.'}));
    return true;
  }
  const requestEpoch = privacyEpoch;
  const execute=async () => {
    if(extensionPage(sender,'editor.html')) {
      const tab=await chrome.tabs.get(message.tabId);if(tab.url?.split(/[?#]/)[0]!==CHAT)throw new Error('Invalid editor window.');
      sender={...sender,tab,frameId:0};
    }
    return dispatch(message,sender,requestEpoch);
  };
  // Tool discovery may wait on external services. It must not hold the notes
  // storage queue or prevent the user from answering a waiting approval.
  const independent=message?.type==='AI_CAPABILITIES'||message?.type==='AI_UPLOAD'||(message?.type==='AI_CONTROLS'&&message.operation!=='choose');
  (independent?execute():exclusive(execute)).then(data => reply({ok: true, ...data}), err => reply({ok: false, error: err.message || 'The operation failed.'}));
  return true;
});
chrome.commands.onCommand.addListener((command, currentTab) => {
  if (command === 'privacy-now') { privacyEpoch++; void hideAll(); return; }
  exclusive(async () => {
    if (command === 'open-settings') { await chrome.runtime.openOptionsPage(); return; }
    let tab = currentTab;
    if (!tab?.id) [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    if (!tab || tab.url?.split(/[?#]/)[0]!==CHAT) return;
    if (!(await state(tab.id)).workspace) return;
    if (command === 'resume-workspace') { const s = await state(tab.id); if (s.editorFrame != null) await send(tab.id,{type:'REQUEST_RESTORE'},s.editorFrame); }
    if (command === 'toggle-paper') {
      const s = await state(tab.id); if (s.private === false) await send(tab.id,{type:'AI_OPEN_OPTIONS'},s.editorFrame);
    }
  }).catch(() => { /* Fail closed; a rejected restore leaves the notepad visible. */ });
});
chrome.action.onClicked.addListener(() => { void exclusive(launch).catch(() => undefined); });
chrome.runtime.onInstalled.addListener(details => {
  exclusive(async () => {
    await applyNotifications();
    if(details.reason==='update') {
      const sessions=await chrome.storage.session.get(null);
      for(const [key,value] of Object.entries(sessions)) if(key.startsWith('tab:')&&value.workspace) {
        try { const tab=await chrome.tabs.get(Number(key.slice(4)));if(tab.url?.startsWith('https://chatgpt.com/'))await chrome.storage.session.remove(key); } catch {await chrome.storage.session.remove(key);}
      }
    }
    if (details.reason === 'install') await chrome.runtime.openOptionsPage();
  }).catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => { void applyNotifications().catch(() => undefined); });
chrome.tabs.onRemoved.addListener(id => { void chrome.storage.session.remove(`tab:${id}`); });
