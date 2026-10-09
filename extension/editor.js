'use strict';
(() => {
  const C = NotesCore;
  const $ = id => document.getElementById(id);
  const editor = $('editor');
  let note = null;
  let dirty = false;
  let ready = false;
  let revisionClock = 0;
  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let currentMenu = null;
  let restoreAttempt = 0;
  let tabs = [];
  let switchingNote = false;
  let applyingAI = false;
  let aiCommit = null;
  const aiUndo = new Map();
  const fileBindings = new Map();
  let fileState = null;
  let fileWarning = '';
  let fileLoading = null;
  const desktop = !!globalThis.NoteDesktop;
  try { tabs = JSON.parse(sessionStorage.getItem('open-notes') || '[]').filter(t=>typeof t.id==='string' && typeof t.name==='string'); } catch { tabs = []; }
  async function request(type, data = {}) {
    return NoteConnection.request(type,data);
  }
  function error(message) { $('error').textContent = message; $('error').hidden = !message; }
  function status(message) { $('save-status').textContent = message === 'Saved locally' ? '' : message; $('save-status').title = message; }
  function ordinaryFileMessage(message){return /\b(?:codex|AI|task|turn)\b/i.test(String(message))?'File updates are in progress. Your recovery draft is kept. Wait for them to finish, then reload the file or use Save as.':String(message||'');}
  function renderFileState(){
    const state=fileState?.state||'',warning=ordinaryFileMessage(fileWarning||({missing:'The file is missing or was moved. Your recovery draft is kept. Relink it or use Save as.',changed:'The file changed on disk. Your recovery draft is kept. Reload it or use Save as.',conflict:'The file changed on disk. Your recovery draft is kept. Reload it or use Save as.'}[state]||''));
    $('file-statebar').hidden=!desktop||!warning;$('file-status').textContent=warning;
    $('file-reload').hidden=!fileState?.bindingId||state==='missing';$('file-relink').hidden=!desktop||!note;
    for(const action of ['reload-file','relink-file']){const button=document.querySelector(`[data-action="${action}"]`);if(button)button.disabled=action==='reload-file'?!fileState?.bindingId:!note;}
    $('document-name').title=fileState?.name||note?.name||'';
    window.dispatchEvent(new Event('notepad-file-state-changed'));
  }
  function acceptFile(value,warning=''){
    if(!desktop||!value||value.noteId!==note?.id)return;
    fileState={...value};fileBindings.set(note.id,fileState);fileWarning=warning;renderFileState();
  }
  async function ensureFile(){
    if(!desktop||!note)return null;if(fileState?.bindingId)return fileState;
    const id=note.id,presentedText=editor.value;if(fileLoading?.noteId===id)return fileLoading.promise;
    const promise=request('NOTE_FILE_STATUS',{noteId:id}).then(r=>{if(note?.id===id){if(r.file){
        const different=typeof r.file.text!=='string'||r.file.text.replace(/\r\n?/g,'\n')!==presentedText.replace(/\r\n?/g,'\n');
        if(different)acceptFile({...r.file,hash:fileState?.bindingId===r.file.bindingId?fileState.hash:null,state:'changed'},'The file has a newer revision than this recovery draft. Reload it or review the pending revision before saving.');
        else acceptFile(r.file,r.fileError||'');
      }else if(r.fileError){fileWarning=r.fileError;renderFileState();}}return note?.id===id?fileState:null;}).finally(()=>{if(fileLoading?.noteId===id)fileLoading=null;});
    fileLoading={noteId:id,promise};return promise;
  }
  function fileGuard(){return fileState?.bindingId?{bindingId:fileState.bindingId,expectedHash:fileState.hash}:{};}
  async function fileAction(type){
    if(!desktop||!note)return;
    if(['NOTE_FILE_OPEN','NOTE_FILE_RELINK','NOTE_FILE_SAVE_AS'].includes(type))await ensureFile().catch(()=>null);else await ensureFile();
    await flush();
    const id=note.id,guard=fileGuard(),changesNote=['NOTE_FILE_OPEN','NOTE_FILE_RELOAD','NOTE_FILE_RELINK'].includes(type);
    if(changesNote)await globalThis.NotepadAssistant?.beforeNoteSwitch();
    try{
      const r=await request(type,type==='NOTE_FILE_OPEN'?{}:{noteId:id,...guard,name:note.name});
      if(r.cancelled||r.canceled){if(changesNote)await globalThis.NotepadAssistant?.cancelNoteSwitch();return;}
      if(r.note){if(['NOTE_FILE_RELOAD','NOTE_FILE_RELINK'].includes(type))aiUndo.delete(r.note.id);applyContext(r);undoChanged();editor.focus();}
      else if(note?.id===id){if(r.file)acceptFile(r.file,r.fileError||'');else if(r.fileError){fileWarning=r.fileError;renderFileState();}if(r.file?.name&&note.name!==r.file.name){note.name=r.file.name;renderTabs();$('document-name').textContent=note.name;}status(r.fileError?'Recovery draft saved; file needs attention':r.file?'Saved':'Saved locally');}
    }catch(e){if(changesNote)await globalThis.NotepadAssistant?.cancelNoteSwitch();if(note?.id===id){fileWarning=e.message;renderFileState();}throw Error(ordinaryFileMessage(e.message));}
  }
  function updatePosition() {
    const {line, column} = C.lineCol(editor.value, editor.selectionStart);
    $('position').textContent = `Ln ${line}, Col ${column}`;
    $('character-count').textContent = `${editor.value.length.toLocaleString()} characters`;
  }
  function renderTabs() {
    if (!note) return;
    const current = tabs.find(t=>t.id===note.id);
    if (current) current.name = note.name; else tabs.push({id:note.id,name:note.name});
    sessionStorage.setItem('open-notes',JSON.stringify(tabs));
    const list = $('document-tabs'); list.replaceChildren();
    for (const tab of tabs) {
      const item = document.createElement('div'); item.className = 'document-tab'; item.dataset.active=String(tab.id===note.id);
      const select = document.createElement('button'); select.type='button'; select.setAttribute('role','tab'); select.setAttribute('aria-selected',String(tab.id===note.id)); select.textContent=tab.name;
      select.addEventListener('click',()=>void switchTab(tab.id));
      const close = document.createElement('button'); close.type='button'; close.className='tab-close'; close.textContent='×'; close.setAttribute('aria-label',`Close ${tab.name}`);
      close.addEventListener('click',()=>void closeTab(tab.id)); item.append(select,close); list.append(item);
    }
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  async function switchTab(id) {
    if (!note || id===note.id || switchingNote) return;
    switchingNote=true;
    try { await flush();await globalThis.NotepadAssistant?.beforeNoteSwitch(); const result=await request('OPEN_NOTE',{id}); applyContext(result); editor.focus(); } catch(e) { error(e.message);await globalThis.NotepadAssistant?.cancelNoteSwitch(); }
    finally{switchingNote=false;}
  }
  async function closeTab(id) {
    if(switchingNote)return;
    switchingNote=true;
    try {
      await flush(); const index=tabs.findIndex(t=>t.id===id), active=note?.id===id;
      if(active)await globalThis.NotepadAssistant?.beforeNoteSwitch();
      tabs=tabs.filter(t=>t.id!==id); sessionStorage.setItem('open-notes',JSON.stringify(tabs));
      if (active) { if (tabs.length) { const result=await request('OPEN_NOTE',{id:tabs[Math.min(index,tabs.length-1)].id}); applyContext(result); } else {const result=await request('NEW_NOTE');applyContext(result);} }
      else renderTabs();
      editor.focus();
    } catch(e) { error(e.message);await globalThis.NotepadAssistant?.cancelNoteSwitch(); }
    finally{switchingNote=false;}
  }
  function applyNote(n) {
    note = C.note(n, n.id); RichEditor.load(note.html,note.text); dirty = false; revisionClock++;
    fileState=fileBindings.get(note.id)||null;fileWarning='';renderFileState();
    editor.wrap = note.wrap ? 'soft' : 'off';
    editor.style.fontSize = `${note.fontSize}px`;
    $('zoom').textContent = `${Math.round(note.fontSize / 15 * 100)}%`;
    document.querySelector('[data-action="wrap"]').setAttribute('aria-checked', String(note.wrap));
    $('document-name').textContent = note.name;
    renderTabs();
    editor.disabled = false; status('Saved locally'); error(''); updatePosition();
  }
  function applyContext(result){applyNote(result.note);if(result.file)acceptFile(result.file,result.fileError||'');else if(desktop)void ensureFile().catch(e=>{fileWarning=e.message;renderFileState();});if(result.assistant)globalThis.NotepadAssistant?.noteContext(result.assistant);}
  globalThis.NotepadEditor=Object.freeze({applyContext,flush,canUndoAI,undoAI,ensureFile,file:()=>fileState?{...fileState}:null,fileGuard,openFile:()=>fileAction('NOTE_FILE_OPEN'),saveFile:()=>fileAction('NOTE_FILE_SAVE'),saveFileAs:()=>fileAction('NOTE_FILE_SAVE_AS')});
  function undoChanged(){window.dispatchEvent(new Event('notepad-ai-undo-changed'));}
  function canUndoAI(){const s=note&&aiUndo.get(note.id);return !!s&&!aiCommit&&(!desktop||!s.bindingId||(s.bindingId===fileState?.bindingId&&(!s.afterHash||s.afterHash===fileState?.hash)))&&editor.value===s.after.text&&RichEditor.html()===s.after.html;}
  async function undoAI(){
    if(globalThis.NotepadAssistant?.working?.())throw Error('Wait for this task to finish before undoing its file changes.');
    await flush();if(!canUndoAI())throw Error('The note changed after the AI revision. Use normal Undo to preserve your later edits.');
    const snapshot=aiUndo.get(note.id);
    if(desktop&&snapshot.afterHash){
      try{const result=await request('NOTE_FILE_UNDO',{noteId:note.id,bindingId:snapshot.bindingId,expectedHash:snapshot.afterHash,text:snapshot.before.text});
        if(result.fileError)throw Error(result.fileError);if(result.file)acceptFile(result.file);
      }catch(e){fileWarning=e.message;renderFileState();throw e;}
    }
    editor.focus();applyingAI=true;
    try{
      // Rewind the accepted browser edits instead of reinserting HTML into
      // the current paragraph. Reinsertion inherits headings/list wrappers.
      let restored=false;
      for(let i=0;i<(snapshot.edits||1);i++){
        if(!document.execCommand('undo'))break;
        if(editor.value===snapshot.before.text&&RichEditor.html()===snapshot.before.html){restored=true;break;}
      }
      // Loading another tab can discard native undo history. The captured
      // whole-document snapshot still restores the owning note exactly.
      if(!restored)RichEditor.load(snapshot.before.html,snapshot.before.text);
    }finally{applyingAI=false;}
    aiUndo.delete(note.id);changed();await flush();undoChanged();
  }
  function expectedHTML(html,text){if(html)return RichEditor.sanitize(html);const box=document.createElement('div');box.textContent=text;return box.innerHTML;}
  function proposeAI(m){
    if(!globalThis.NotepadAssistant?.visible())return {ok:false,accepted:false,reason:'hidden'};
    if(!note||switchingNote||note.id!==m.noteId||!globalThis.NotepadAssistant.owns(m.assistantId))return {ok:false,accepted:false,reason:'context_changed'};
    if(aiCommit||dirty||note.revision!==m.expectedRevision||editor.value!==m.expectedText||RichEditor.html()!==expectedHTML(m.expectedHtml,m.expectedText))return {ok:false,accepted:false,reason:'local_changes'};
    if(typeof m.text!=='string'||new TextEncoder().encode(m.text).length>C.MAX_TEXT_BYTES)return {ok:false,accepted:false,reason:'invalid_text'};
    const before={text:editor.value,html:RichEditor.html()},old=aiUndo.get(note.id);
    const active=document.activeElement,start=editor.selectionStart,end=editor.selectionEnd,scroll=editor.scrollTop;
    let prefix=0,suffix=0;while(prefix<before.text.length&&prefix<m.text.length&&before.text[prefix]===m.text[prefix])prefix++;
    if(prefix&&/[\uD800-\uDBFF]/.test(before.text[prefix-1]))prefix--;
    while(suffix<before.text.length-prefix&&suffix<m.text.length-prefix&&before.text[before.text.length-1-suffix]===m.text[m.text.length-1-suffix])suffix++;
    if(suffix&&/[\uDC00-\uDFFF]/.test(before.text[before.text.length-suffix]))suffix--;
    let editSteps=0;applyingAI=true;
    try{
      editor.focus({preventScroll:true});
      if(m.confirmed===true){
        // Neutralize inherited heading/list blocks before replacing a whole
        // document. Otherwise Chromium can leave an extra empty heading after
        // multiline insertHTML, changing the projected text.
        editor.select();if(document.execCommand('formatBlock',false,'div'))editSteps++;
        editor.select();if(document.execCommand('insertHTML',false,expectedHTML('',m.text)))editSteps++;
      }else{editor.setRangeText(m.text.slice(prefix,m.text.length-suffix),prefix,before.text.length-suffix);editSteps=1;}
      if(editor.value!==m.text){
        for(let i=0;i<editSteps&&(editor.value!==before.text||RichEditor.html()!==before.html);i++)if(!document.execCommand('undo'))break;
        if(editor.value!==before.text||RichEditor.html()!==before.html)RichEditor.load(before.html,before.text);
        return {ok:false,accepted:false,reason:'formatting_conflict'};
      }
    }finally{
      applyingAI=false;const delta=m.text.length-before.text.length;
      const shift=p=>p<=prefix?p:p>=before.text.length-suffix?p+delta:prefix+m.text.length-prefix-suffix;
      editor.setSelectionRange(shift(start),shift(end));editor.scrollTop=scroll;
      if(active&&active!==editor&&active.isConnected)active.focus({preventScroll:true});
    }
    const after={text:editor.value,html:RichEditor.html()};
    const grouped=old?.requestId===m.editRequestId&&old.afterRevision===m.expectedRevision&&old.after.text===before.text&&old.after.html===before.html;
    aiUndo.set(note.id,{requestId:m.editRequestId,before:grouped?old.before:before,after,afterRevision:m.expectedRevision+1,edits:(grouped?(old.edits||1):0)+Math.max(1,editSteps),bindingId:fileState?.bindingId,beforeHash:grouped?old.beforeHash:fileState?.hash,afterHash:m.file?.hash});
    revisionClock++;dirty=false;status('Saving…');updatePosition();
    let release;const promise=new Promise(resolve=>{release=resolve;});
    aiCommit={noteId:note.id,requestId:m.editRequestId,clock:revisionClock,promise,release};undoChanged();
    return {ok:true,accepted:true,note:{id:note.id,...after},...fileState?{file:{...fileState}}:{}};
  }
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flush().catch(e => error(e.message)); }, 300);
  }
  function changed() {
    if (!note || applyingAI) return;
    dirty = true; revisionClock++; status('Saving…'); updatePosition(); queueSave();undoChanged();
  }
  function flush() {
    clearTimeout(saveTimer);
    // Do not snapshot before previous writes finish: the returned revision is
    // needed for the next save's optimistic concurrency check.
    const next = saveQueue.catch(() => undefined).then(async () => {
      while(aiCommit)await aiCommit.promise;
      if (!note || !dirty) return;
      if(desktop)try{await ensureFile();}catch(e){fileWarning=e.message;renderFileState();}
      const clock = revisionClock;
      const snapshot = {...note, text: editor.value, html:RichEditor.html()};
      const result = await request('SAVE_NOTE', {note: snapshot,...fileGuard()});
      if (note?.id !== snapshot.id) return;
      note.revision = result.note.revision; note.updatedAt = result.note.updatedAt;
      if(result.file&&!result.fileError)acceptFile(result.file);if(result.fileError){fileWarning=result.fileError;renderFileState();}
      if (clock === revisionClock) {
        dirty = false; note.text = snapshot.text;note.html=snapshot.html; status(result.fileError?'Recovery draft saved; file needs attention':desktop&&fileState?'Saved':'Saved locally'); error('');
      } else { queueSave(); }
    });
    saveQueue = next;
    return next;
  }
  function closeMenus() {
    for (const menu of document.querySelectorAll('.menu')) menu.hidden = true;
    for (const button of document.querySelectorAll('[data-menu]')) button.setAttribute('aria-expanded', 'false');
    currentMenu = null;
  }
  function toggleMenu(button) {
    const name = button.dataset.menu;
    if (currentMenu === name) { closeMenus(); return; }
    closeMenus(); currentMenu = name;
    const menu = $(`menu-${name}`); menu.hidden = false;
    const box = button.getBoundingClientRect();
    menu.style.left = `${Math.min(box.left, Math.max(4,innerWidth-menu.offsetWidth-4))}px`;
    menu.style.top = `${box.bottom+3}px`;
    button.setAttribute('aria-expanded', 'true');
  }
  function insert(text) {
    RichEditor.restore();
    // Native undo history is retained where Chromium supports insertText.
    if (!document.execCommand('insertText', false, text)) {
      editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end'); changed();
    }
    updatePosition();
  }
  async function newNote(text = '', name = 'Untitled') {
    if(switchingNote)return;
    switchingNote=true;
    try{await flush();await globalThis.NotepadAssistant?.beforeNoteSwitch();
      const result = await request('NEW_NOTE', {text, name});
      applyContext(result); editor.focus();
    }catch(e){await globalThis.NotepadAssistant?.cancelNoteSwitch();throw e;}
    finally{switchingNote=false;}
  }
  async function openFile(file) {
    if (!file) return;
    try {
      if (file.size > C.MAX_TEXT_BYTES) throw new Error('This editor opens text files up to 2 MB.');
      if (/\.(pdf|png|jpe?g|gif|webp|zip|docx?|xlsx?|pptx?|exe|dll|mp[34])$/i.test(file.name)) throw new Error('Open a text file here. Other files can only be attached in the workspace view.');
      const text = C.decodeText(await file.arrayBuffer());
      await newNote(text, C.filename(file.name));
      if (/\.html?$/i.test(file.name)) { RichEditor.load(text,''); changed(); }
    } catch (e) { error(e.message); }
    $('open-file').value = '';
  }
  function openSaveDialog() {
    if (!note) return;
    closeMenus(); $('save-name').value = C.filename(note.name, true);
    if (!$('save-dialog').open) $('save-dialog').showModal();
    $('save-name').focus(); $('save-name').select();
  }
  async function exportNote() {
    const fileName = C.filename($('save-name').value, true);
    note.name = fileName; $('document-name').textContent = fileName; changed();
    renderTabs();
    // Export remains available if the browser's local-storage save fails.
    const text = editor.value;
    const url = URL.createObjectURL(new Blob([C.exportText(text)], {type: 'text/plain;charset=utf-8'}));
    try {
      await request('DOWNLOAD_NOTE', {url, name: fileName});
      status('Text file requested');
      void flush().catch(e => error(e.message));
    } catch (e) { error(e.message); }
    // Keep the blob alive while the native Save As dialog is in use.
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
  function findUI(replace = false) {
    closeMenus(); $('findbar').hidden = false; $('replace-row').hidden = !replace;
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (selected && !selected.includes('\n')) $('find-text').value = selected;
    $('find-text').focus(); $('find-text').select();
  }
  function findNext(backwards = false) {
    const q = $('find-text').value;
    const i = C.find(editor.value, q, backwards ? editor.selectionStart : editor.selectionEnd, backwards, $('match-case').checked);
    if (i < 0) { $('find-status').textContent = q ? 'No matches found.' : 'Enter text to find.'; return false; }
    editor.focus(); editor.setSelectionRange(i, i + q.length);
    const line = C.lineCol(editor.value, i).line;
    const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || note.fontSize * 1.5;
    // Approximate scroll location without modifying the document or selection.
    editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
    $('find-status').textContent = ''; updatePosition(); return true;
  }
  function replaceOne() {
    const query = $('find-text').value;
    if (!query) return;
    RichEditor.restore();
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    const matches = $('match-case').checked ? selected === query : selected.toLocaleLowerCase() === query.toLocaleLowerCase();
    if (matches) insert($('replace-text').value);
    findNext();
  }
  function replaceAll() {
    const query = $('find-text').value;
    if (!query) return;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, $('match-case').checked ? 'g' : 'gi');
    let count = 0;
    const text = editor.value.replace(regex, () => { count++; return $('replace-text').value; });
    if (count) { editor.focus(); editor.select(); insert(text); }
    $('find-status').textContent = `${count} replacement${count === 1 ? '' : 's'}.`;
  }
  async function showRecent() {
    await flush();
    const result = await request('RECENT_NOTES');
    const list = $('recent-list'); list.replaceChildren();
    for (const entry of result.notes) {
      const button = document.createElement('button'); button.type = 'button';
      const title = document.createElement('span'); title.textContent = entry.name;
      const date = document.createElement('small'); date.textContent = new Date(entry.updatedAt).toLocaleString();
      button.append(title, date);
      button.addEventListener('click', async () => {
        try { await flush();await globalThis.NotepadAssistant?.beforeNoteSwitch();const result = await request('OPEN_NOTE', {id: entry.id}); applyContext(result); $('recent-dialog').close(); editor.focus(); }
        catch (e) { error(e.message);await globalThis.NotepadAssistant?.cancelNoteSwitch(); }
      });
      list.appendChild(button);
    }
    $('recent-dialog').showModal();
  }
  async function action(name) {
    closeMenus(); if (!ready) return;
    if (['undo','redo','cut','copy','paste','time'].includes(name)) RichEditor.restore();
    try {
      switch (name) {
        case 'new': await newNote(); break;
        case 'open': if(desktop)await fileAction('NOTE_FILE_OPEN');else $('open-file').click(); break;
        case 'save': if(desktop)await fileAction('NOTE_FILE_SAVE');else openSaveDialog(); break;
        case 'save-as': if(desktop)await fileAction('NOTE_FILE_SAVE_AS');else openSaveDialog();break;
        case 'reload-file': if(desktop)await fileAction('NOTE_FILE_RELOAD');break;
        case 'relink-file': if(desktop)await fileAction('NOTE_FILE_RELINK');break;
        case 'save-html': {
          const html='<!doctype html><meta charset="utf-8"><title>Note</title><style>body{max-width:900px;margin:40px auto;font:16px/1.6 system-ui;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid;padding:8px}</style>'+RichEditor.html();
          const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));await request('DOWNLOAD_NOTE',{url,name:note.name.replace(/\.txt$/i,'')+'.html',formatted:true});setTimeout(()=>URL.revokeObjectURL(url),120000);break;
        }
        case 'recent': await showRecent(); break;
        case 'close': await flush(); await request('CLOSE_WINDOW'); break;
        case 'undo': editor.focus(); document.execCommand('undo'); break;
        case 'redo': editor.focus(); document.execCommand('redo'); break;
        case 'cut': editor.focus(); document.execCommand('cut'); break;
        case 'copy': editor.focus(); document.execCommand('copy'); break;
        case 'paste': editor.focus(); if (!document.execCommand('paste')) error('Press Ctrl+V to paste from the clipboard.'); break;
        case 'select': editor.focus(); editor.select(); updatePosition(); break;
        case 'find': findUI(); break;
        case 'replace': findUI(true); break;
        case 'time': insert(`${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} ${new Date().toLocaleDateString()}`); break;
        case 'wrap': note.wrap = !note.wrap; editor.wrap = note.wrap ? 'soft' : 'off'; document.querySelector('[data-action="wrap"]').setAttribute('aria-checked', String(note.wrap)); changed(); break;
        case 'zoom-in': case 'zoom-out': case 'zoom-reset':
          note.fontSize = name === 'zoom-reset' ? 15 : Math.min(28, Math.max(11, note.fontSize + (name === 'zoom-in' ? 1 : -1)));
          editor.style.fontSize = `${note.fontSize}px`; $('zoom').textContent = `${Math.round(note.fontSize / 15 * 100)}%`; changed(); break;
        case 'about': $('about-dialog').showModal(); break;
        case 'spellcheck': editor.spellcheck = !editor.spellcheck; document.querySelector('[data-action="spellcheck"]').setAttribute('aria-pressed',String(editor.spellcheck)); editor.focus(); break;
      }
    } catch (e) { error(e.message); }
  }
  document.querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', () => toggleMenu(button)));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => void action(button.dataset.action)));
  $('new-tab').addEventListener('click',()=>void action('new'));
  $('file-reload').addEventListener('click',()=>void action('reload-file'));
  $('file-relink').addEventListener('click',()=>void action('relink-file'));
  document.querySelectorAll('[data-format]').forEach(button=>{
    button.addEventListener('pointerdown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      if (!ready) return; closeMenus();
      RichEditor.format(button.dataset.format);
    });
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.menu, .menubar')) closeMenus(); });
  editor.addEventListener('input', changed);
  for (const ev of ['keyup', 'click', 'select']) editor.addEventListener(ev, updatePosition);
  $('open-file').addEventListener('change', () => void openFile($('open-file').files[0]));
  document.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer.files.length > 1) { error('Open one text file at a time.'); return; }
    if (event.dataTransfer.files.length) void openFile(event.dataTransfer.files[0]);
    else if (event.dataTransfer.getData('text/plain')) insert(event.dataTransfer.getData('text/plain'));
  });
  $('save-dialog').addEventListener('close', () => { if ($('save-dialog').returnValue === 'save') void exportNote(); });
  $('find-next').addEventListener('click', () => findNext());
  $('find-prev').addEventListener('click', () => findNext(true));
  $('replace-one').addEventListener('click', replaceOne);
  $('replace-all').addEventListener('click', replaceAll);
  $('close-find').addEventListener('click', () => { $('findbar').hidden = true; editor.focus(); });
  $('find-text').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey); } });
  function cancelRestore() {
    restoreAttempt++;
    $('unlock-password').value = '';
    if ($('unlock-dialog').open) $('unlock-dialog').close();
    $('unlock-submit').disabled = false;
  }
  $('cancel-unlock').addEventListener('click', () => { globalThis.NotepadAssistant?.hide(false); cancelRestore(); void request('HIDE').catch(() => undefined); });
  $('unlock-dialog').addEventListener('cancel', () => { globalThis.NotepadAssistant?.hide(false); cancelRestore(); void request('HIDE').catch(() => undefined); });
  $('unlock-form').addEventListener('submit', async event => {
    event.preventDefault(); const attempt = ++restoreAttempt;
    $('unlock-error').textContent = ''; $('unlock-submit').disabled = true;
    const password = $('unlock-password').value; $('unlock-password').value = '';
    try {
      await flush(); await request('UNLOCK', {password,token:globalThis.NotepadAssistant?.token()});
      if (attempt === restoreAttempt) cancelRestore();
    } catch (e) { if (attempt === restoreAttempt) { $('unlock-error').textContent = e.message; $('unlock-password').focus(); } }
    finally { $('unlock-submit').disabled = false; }
  });
  document.addEventListener('keydown', event => {
    if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.code === 'KeyQ') {
      globalThis.NotepadAssistant?.hide(false);
      event.preventDefault(); event.stopImmediatePropagation(); cancelRestore(); closeMenus();
      for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
      void request('HIDE').catch(() => undefined); editor.focus(); return;
    }
    // The browser's registered shortcut is authoritative for restore. There is
    // intentionally no unprotected page message or second toggle that reveals.
    if (event.key === 'Escape') {
      if (!$('unlock-dialog').open) { closeMenus(); $('findbar').hidden = true; }
      return;
    }
    if (currentMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = [...$(`menu-${currentMenu}`).querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); items[next].focus(); return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      const mapping = {n: 'new', o: 'open', s: event.shiftKey?'save-as':'save', f: 'find', h: 'replace', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset'};
      if (mapping[key]) { event.preventDefault(); event.stopPropagation(); void action(mapping[key]); }
      if (key === 'p') { event.preventDefault(); error('Use File > Save as to create a text file, then print it from your usual editor.'); }
    }
    if (event.key === 'F5') { event.preventDefault(); void action('time'); }
    if (event.key === 'Tab' && event.target === editor && !event.ctrlKey && !event.altKey) { event.preventDefault(); insert('\t'); }
  }, true);
  NoteConnection.onMessage((message, sender, reply) => {
    if (sender.id !== (globalThis.NoteDesktop?.id || chrome.runtime.id)) return;
    if(message?.type==='NOTE_FILE_PRESENTED'){
      if(note?.id!==message.noteId||dirty||switchingNote||!globalThis.NotepadAssistant?.visible()){reply({ok:false,accepted:false});return;}
      if(message.file)acceptFile(message.file);reply({ok:true,accepted:true});return;
    }
    if(message?.type==='NOTE_AI_PROPOSE'){reply(proposeAI(message));return;}
    if(message?.type==='NOTE_AI_COMMITTED'||message?.type==='NOTE_AI_FAILED'){
      const pending=aiCommit;
      if(pending&&pending.noteId===message.noteId&&pending.requestId===message.editRequestId){
        if(note?.id===message.noteId){
          if(Number.isSafeInteger(message.revision)){note.revision=message.revision;note.updatedAt=message.updatedAt;}
          if(message.type==='NOTE_AI_COMMITTED'){note.text=message.text;note.html=message.html;if(message.file){acceptFile(message.file);const snapshot=aiUndo.get(note.id);if(snapshot?.requestId===message.editRequestId){snapshot.bindingId=message.file.bindingId;snapshot.afterHash=message.file.hash;}}if(pending.clock===revisionClock){dirty=false;status(desktop&&fileState?'Saved':'Saved locally');}}
          else{dirty=true;error(message.error||'The AI revision could not be saved. Your shown text is retained.');queueSave();}
        }
        aiCommit=null;pending.release();undoChanged();
      }
      reply({ok:true});return;
    }
    if (message?.type === 'UNLOCK_PROMPT') {
      if (!globalThis.NotepadAssistant?.matches(message.token)) { reply({ok:false}); return; }
      closeMenus(); $('unlock-error').textContent = ''; $('unlock-password').value = '';
      if (!$('unlock-dialog').open) $('unlock-dialog').showModal();
      $('unlock-password').focus(); reply({ok: true});
    }
    if (message?.type === 'CANCEL_RESTORE') { cancelRestore(); reply({ok: true}); }
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== 'https://chatgpt.com' || event.data?.type !== 'NW_FOCUS_EDITOR') return;
    if (!document.querySelector('dialog[open]')) editor.focus({preventScroll: true});
  });
  // These are best-effort extra flushes. The 300 ms autosave is the primary
  // recovery mechanism; a power loss within that interval can still lose text.
  window.addEventListener('blur',()=>{if(window.noteOptions?.hideOnBlur)globalThis.NotepadAssistant?.hide();});
  window.addEventListener('pagehide', () => { void flush().catch(() => undefined); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush().catch(() => undefined); });
  request('EDITOR_READY').then(result => {
    applyContext(result); ready = true;
    globalThis.notepadReady = true;
    window.dispatchEvent(new Event('notepad-ready'));
    window.noteOptions=result.options;editor.focus();
  }).catch(e => { error(e.message); status('Document could not be opened'); });
})();
