'use strict';
const {app,BrowserWindow,protocol,net,ipcMain,dialog,shell,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {createRuntime,ORIGIN}=require('./worker-runtime.cjs');
const {createService}=require('./codex-service.cjs');
const {sanitizeBackup:backupData,mergeBackup}=require('./backup.cjs');
const {createNoteFiles}=require('./note-files.cjs');
const APP_ID='NotesWorkspace.Desktop';
app.setName('Notes Workspace');app.setAppUserModelId(APP_ID);
const dataRoot=path.resolve(process.env.NOTES_DESKTOP_DATA_DIR||path.join(process.env.LOCALAPPDATA||app.getPath('appData'),'NotesWorkspace','DesktopData'));
app.setPath('userData',dataRoot);
protocol.registerSchemesAsPrivileged([{scheme:'notes',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const uiRoot=path.join(__dirname,'ui'),iconPath=path.join(uiRoot,'icons','notes.ico');
const pages=new Set(['editor.html','options.html','onboarding.html']);
const assets=new Set(['editor.html','editor.css','options.html','options.css','options.js','onboarding.html','onboarding.js','onboarding.css','core.js','worker.js','client.js','rich-editor.js','editor.js','assistant.js','desktop-ui.js','icons/notes.ico','icons/notes16.png','icons/notes32.png','icons/notes48.png','icons/notes128.png','icons/notes256.png']);
const windows=new Map(),exportsByWindow=new Map();
let runtime,service,noteFiles,quitting=false,closing=false,settingsWindow,accountWindow,desktopPrivacyEpoch=0;
function info(win){if(!win||win.isDestroyed())throw Error('This notepad window has closed.');return {id:win.id,windowId:win.id,url:win.webContents.getURL(),active:win.isFocused(),mutedInfo:{muted:win.webContents.isAudioMuted()},autoDiscardable:false};}
function trusted(event){const win=BrowserWindow.fromWebContents(event.sender),url=new URL(event.senderFrame?.url||'about:blank');if(!win||!windows.has(win.id)||event.senderFrame!==event.sender.mainFrame||!pages.has(url.pathname.slice(1))||url.protocol!=='notes:'||url.host!=='app')throw Error('This action must come from Notes Workspace.');return win;}
function externalLogin(url){const u=new URL(url);if(u.protocol!=='https:'||!['auth.openai.com','auth0.openai.com','chatgpt.com','login.openai.com'].includes(u.hostname))throw Error('Unexpected sign-in address.');return shell.openExternal(u.href);}
function concealAuxiliary(){for(const win of [...windows.values()])if(win.webContents.getURL()!==ORIGIN+'/editor.html'){win.hide();win.close();}const editor=[...windows.values()].find(win=>win.webContents.getURL()===ORIGIN+'/editor.html');editor?.focus();}
async function createWindow(page='editor.html',epoch=desktopPrivacyEpoch){
  if(!pages.has(page))throw Error('Unknown desktop page.');
  const win=new BrowserWindow({width:page==='editor.html'?1280:850,height:900,minWidth:680,minHeight:500,show:false,title:page==='editor.html'?'Notepad':'Notes Workspace',icon:nativeImage.createFromPath(iconPath),backgroundColor:'#272727',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:false,spellcheck:true}});
  windows.set(win.id,win);win.removeMenu();win.setAppDetails({appId:APP_ID,appIconPath:iconPath,appIconIndex:0,relaunchDisplayName:'Notes Workspace',relaunchCommand:'"'+process.execPath+'"'});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==ORIGIN+'/'+page)event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||!input.alt||input.control||input.meta)return;
    if(input.key.toLowerCase()==='q'){desktopPrivacyEpoch++;void runtime.command('privacy-now').catch(()=>{});concealAuxiliary();}
    if(input.key.toLowerCase()==='m'&&!input.shift){event.preventDefault();void runtime.command('toggle-paper',win.id).catch(()=>{});}
    if(input.key.toLowerCase()==='s'&&input.shift){event.preventDefault();void openSettings();}
  });
  win.webContents.on('render-process-gone',()=>runtime.disconnect(win.id));
  win.on('close',event=>{
    if(quitting||win._notesClosing||page!=='editor.html')return;
    event.preventDefault();win._notesClosing=true;
    const flush=win.webContents.executeJavaScript('Promise.all([globalThis.NotepadEditor?.flush(),globalThis.NotepadAssistant?.beforeNoteSwitch()])').catch(()=>{});
    Promise.race([flush,new Promise(resolve=>setTimeout(resolve,2500))]).finally(()=>win.destroy());
  });
  win.on('closed',()=>{runtime?.windowClosed(win.id);windows.delete(win.id);exportsByWindow.delete(win.id);});
  await win.loadURL(ORIGIN+'/'+page);if(page!=='editor.html'&&epoch!==desktopPrivacyEpoch){win.destroy();throw Error('Opening the window was cancelled.');}win.show();return win;
}
async function openSettings(){if(settingsWindow&&!settingsWindow.isDestroyed()){settingsWindow.show();settingsWindow.focus();return info(settingsWindow);}settingsWindow=await createWindow('options.html');return info(settingsWindow);}
async function openAccount(){if(accountWindow&&!accountWindow.isDestroyed()){accountWindow.show();accountWindow.focus();return {};}accountWindow=await createWindow('onboarding.html');return {};}
async function createShortcut(){
  if(!app.isPackaged)throw Error('Create the shortcut from the packaged program.');
  const desktop=app.getPath('desktop'),target=path.join(desktop,'Notes Workspace.lnk');
  const ok=shell.writeShortcutLink(target,'create',{target:process.execPath,cwd:path.dirname(process.execPath),description:'Notes Workspace',icon:iconPath,iconIndex:0,appUserModelId:APP_ID});
  if(!ok)throw Error('Windows could not create the desktop shortcut.');return {message:'Notes Workspace shortcut created on '+desktop+'.'};
}
async function desktopRequest(type,data,win){
  const page=new URL(win.webContents.getURL()).pathname;
  const editorOnly=['DESKTOP_CHOOSE_PROJECT'];
  const settingsOnly=['DESKTOP_EXPORT','DESKTOP_IMPORT','DESKTOP_CREATE_SHORTCUT'];
  const accountOnly=['DESKTOP_ACCOUNT_STATUS','DESKTOP_ACCOUNT_LOGIN','DESKTOP_ACCOUNT_CANCEL','DESKTOP_ACCOUNT_LOGOUT','DESKTOP_SANDBOX_STATUS','DESKTOP_SANDBOX_SETUP'];
  if(editorOnly.includes(type)&&page!=='/editor.html'||settingsOnly.includes(type)&&page!=='/options.html'||accountOnly.includes(type)&&page!=='/onboarding.html')throw Error('Open the appropriate Notes Workspace page first.');
  switch(type){
    case 'DESKTOP_CHOOSE_PROJECT': {const r=await dialog.showOpenDialog(win,{title:'Choose project folder',properties:['openDirectory']});return {path:r.canceled?null:r.filePaths[0]};}
    case 'DESKTOP_OPEN_ACCOUNT':return openAccount();
    case 'DESKTOP_ACCOUNT_STATUS':return service.accountStatus();
    case 'DESKTOP_ACCOUNT_LOGIN': {const result=await service.login();if(result.authUrl)await externalLogin(result.authUrl);return {...result,authUrl:undefined};}
    case 'DESKTOP_ACCOUNT_CANCEL':return service.cancelLogin(data.loginId);
    case 'DESKTOP_SANDBOX_STATUS':return service.sandboxStatus();
    case 'DESKTOP_SANDBOX_SETUP': {const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Set up'],defaultId:0,cancelId:0,message:'Set up the official Codex Windows sandbox?',detail:'Windows may ask for administrator approval to create or update Codex’s restricted environment for project commands and tests.'});if(confirm.response!==1)return {message:'Cancelled.'};return service.setupSandbox();}
    case 'DESKTOP_ACCOUNT_LOGOUT': {const confirm=await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Sign out'],defaultId:0,cancelId:0,message:'Sign out of Codex on this Windows account?',detail:'This also affects other Codex applications using the same sign-in.'});if(confirm.response!==1)return {message:'Cancelled.'};return service.logout();}
    case 'DESKTOP_CREATE_SHORTCUT':return createShortcut();
    case 'DESKTOP_EXPORT': {const r=await dialog.showSaveDialog(win,{title:'Export notepad backup',defaultPath:'Notes Workspace backup.json',filters:[{name:'Notepad backup',extensions:['json']}]});if(r.canceled)return {message:'Cancelled.'};await fs.promises.writeFile(r.filePath,JSON.stringify({format:'notes-workspace-backup',version:5,data:backupData(runtime.snapshot())}),{encoding:'utf8',mode:0o600});return {message:'Backup saved. It contains your notes and conversations; keep it private.'};}
    case 'DESKTOP_IMPORT': {
      if(Object.values(runtime.snapshot()).some(value=>value?.pending))throw Error('Finish or stop active AI requests before importing a backup.');
      const r=await dialog.showOpenDialog(win,{title:'Import notepad backup',properties:['openFile'],filters:[{name:'Notepad backup',extensions:['json']}]});if(r.canceled)return {message:'Cancelled.'};const file=r.filePaths[0];if((await fs.promises.stat(file)).size>128*1024*1024)throw Error('The backup is too large.');const parsed=JSON.parse(await fs.promises.readFile(file,'utf8'));if(parsed.format!=='notes-workspace-backup')throw Error('Choose a Notes Workspace backup.');
      const confirm=await dialog.showMessageBox(win,{type:'question',message:'Import the saved notes and conversations?',detail:'Existing notes are kept. The program will close so the imported data can load on your next launch.',buttons:['Cancel','Import'],defaultId:0,cancelId:0});if(confirm.response!==1)return {message:'Cancelled.'};
      for(const w of windows.values())if(new URL(w.webContents.getURL()).pathname==='/editor.html')await w.webContents.executeJavaScript('globalThis.NotepadEditor?.flush()').catch(()=>{});
      const current=runtime.snapshot(),merged=mergeBackup(parsed.data,current);
      await runtime.close();const target=path.join(dataRoot,'notes.json'),temp=target+'.import';await fs.promises.writeFile(temp,JSON.stringify(merged));await fs.promises.rename(temp,target);setTimeout(()=>{service.close();quitting=true;app.quit();},200);return {message:'Imported. Reopen Notes Workspace.'};
    }
    default:throw Error('Unknown desktop action.');
  }
}
async function noteFileRequest(type,data,win){
  if(win.webContents.getURL()!==ORIGIN+'/editor.html')throw Error('Open the notepad document first.');
  const sender={id:win.id,url:win.webContents.getURL()},context=await runtime.request('NOTE_FILE_CONTEXT',{},sender);
  if(!context.ok)throw Error(context.error);const current=context.note;
  if(data.noteId!==undefined&&data.noteId!==current.id)throw Error('The selected document changed. Try again in its current tab.');
  const idle=()=>{if(context.assistant.pending?.noteEditBase)throw Error('Codex is still editing this document. Your local note is retained; wait for the turn to finish.');service.assertNoteIdle(current.id);};
  const currentAgain=async()=>{const next=await runtime.request('NOTE_FILE_CONTEXT',{},sender);if(!next.ok||next.note.id!==current.id||next.note.revision!==current.revision)throw Error('The selected document changed while the dialog was open. Try again.');idle();};
  const reload=async(file,relinked=false)=>{const result=await runtime.request('RELOAD_NOTE_FILE',{noteId:current.id,text:file.text,name:file.name,relinked},sender);if(!result.ok)throw Error(result.error);return {...result,file};};
  const saveAs=async()=>{idle();const picked=await dialog.showSaveDialog(win,{title:'Save document as',defaultPath:path.basename(typeof data.name==='string'?data.name:current.name||'Untitled.txt'),properties:['showOverwriteConfirmation'],filters:[{name:'UTF-8 text document',extensions:['txt']},{name:'All files',extensions:['*']}]});if(picked.canceled)return {cancelled:true};await currentAgain();const file=await noteFiles.saveAs(current.id,picked.filePath,current.text),renamed=await runtime.request('NAME_NOTE_FILE',{noteId:current.id,name:file.name,bindingId:file.bindingId},sender);if(!renamed.ok)throw Error(renamed.error);return {...renamed,file};};
  switch(type){
    case 'NOTE_FILE_STATUS':return {file:await noteFiles.status(current.id,current.text)};
    case 'NOTE_FILE_OPEN':{
      const picked=await dialog.showOpenDialog(win,{title:'Open text document',properties:['openFile'],filters:[{name:'UTF-8 text documents',extensions:['txt','md','log','csv','json','js','cjs','mjs','py','css','html']},{name:'All files',extensions:['*']}]});if(picked.canceled)return {cancelled:true};
      const latest=await runtime.request('NOTE_FILE_CONTEXT',{},sender);if(!latest.ok||latest.note.id!==current.id)throw Error('The selected note changed while the dialog was open.');
      const selection=await noteFiles.open(picked.filePaths[0]),created=await runtime.request('NEW_NOTE',{name:selection.name,text:selection.text},sender);if(!created.ok)throw Error(created.error);
      try{const file=await noteFiles.bind(created.note.id,selection),project=await runtime.request('NOTE_FILE_PROJECT',{noteId:created.note.id},sender);if(!project.ok)throw Error(project.error);return {...project,file};}
      catch(error){await runtime.request('OPEN_NOTE',{id:current.id},sender).catch(()=>undefined);throw error;}
    }
    case 'NOTE_FILE_SAVE':{idle();const file=await noteFiles.status(current.id,current.text);if(file.managed)return saveAs();return {file:await noteFiles.save(current.id,{bindingId:data.bindingId,expectedHash:data.expectedHash,text:current.text})};}
    case 'NOTE_FILE_SAVE_AS':return saveAs();
    case 'NOTE_FILE_RELOAD':idle();return reload(await noteFiles.reload(current.id,{bindingId:data.bindingId}));
    case 'NOTE_FILE_RELINK':{
      idle();const picked=await dialog.showOpenDialog(win,{title:'Relink text document',properties:['openFile'],filters:[{name:'Text document',extensions:['txt','md','log']},{name:'All files',extensions:['*']}]});if(picked.canceled)return {cancelled:true};await currentAgain();const selection=await noteFiles.open(picked.filePaths[0]),file=await noteFiles.bind(current.id,selection),loaded=await reload(file,true),project=await runtime.request('NOTE_FILE_PROJECT',{noteId:current.id},sender);if(!project.ok)throw Error(project.error);return {...loaded,...project,file};
    }
    case 'NOTE_FILE_UNDO':if(!runtime.enabled(win.id))throw Error('Show the panel before undoing an AI document revision.');if(context.assistant.pending)throw Error('Wait for the current turn to finish before undoing its document revision.');idle();return {file:await noteFiles.undo(current.id,{bindingId:data.bindingId,expectedHash:data.expectedHash,text:data.text})};
    default:throw Error('Unknown document action.');
  }
}
ipcMain.handle('notes:connect',async event=>{const win=trusted(event);await runtime.connect(win.id,message=>{if(!win.isDestroyed())win.webContents.send('notes:event',message);});return true;});
ipcMain.on('notes:reply',(event,message)=>{try{const win=trusted(event);void runtime.receive(win.id,message).catch(()=>{});}catch{}});
ipcMain.handle('notes:request',async(event,payload)=>{
  try{
    const win=trusted(event);if(!payload||typeof payload.type!=='string'||JSON.stringify(payload).length>40*1024*1024)throw Error('Invalid notepad request.');
    const {type}=payload,data=payload.data||{};
    if(type==='HIDE'){desktopPrivacyEpoch++;concealAuxiliary();}
    if(new URL(win.webContents.getURL()).pathname==='/editor.html'&&['DESKTOP_CHOOSE_PROJECT','DESKTOP_OPEN_ACCOUNT'].includes(type)&&!runtime.enabled(win.id))throw Error('The panel is disabled. Press Alt+W to enable it.');
    if(type.startsWith('DESKTOP_'))return {ok:true,...await desktopRequest(type,data,win)};
    if(type.startsWith('NOTE_FILE_')&&type!=='NOTE_FILE_CONTEXT')return {ok:true,...await noteFileRequest(type,data,win)};
    if(type==='DOWNLOAD_NOTE'){
      if(new URL(win.webContents.getURL()).pathname!=='/editor.html'||!Array.isArray(data.bytes)||data.bytes.length>8*1024*1024||!data.bytes.every(n=>Number.isInteger(n)&&n>=0&&n<=255)||typeof data.url!=='string'||!data.url.startsWith('blob:'+ORIGIN+'/'))throw Error('Invalid local export.');
      exportsByWindow.set(win.id,{url:data.url,bytes:Buffer.from(data.bytes)});delete data.bytes;
    }
    try{return await runtime.request(type,data,{id:win.id,url:win.webContents.getURL()});}finally{if(type==='DOWNLOAD_NOTE')exportsByWindow.delete(win.id);}
  }catch(error){return {ok:false,error:error.message||'The desktop operation failed.'};}
});
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();
else {
  app.on('second-instance',(_event,args)=>{if(args.includes('--quit-for-update')){app.quit();return;}const win=[...windows.values()].find(w=>w.webContents.getURL()===ORIGIN+'/editor.html');if(win){win.show();win.focus();}else void createWindow();});
  app.whenReady().then(async()=>{
    await fs.promises.mkdir(dataRoot,{recursive:true});
    protocol.handle('notes',async request=>{
      const u=new URL(request.url),name=decodeURIComponent(u.pathname.slice(1));
      if(u.hostname!=='app'||!assets.has(name))return new Response('Not found',{status:404});
      const response=await net.fetch(pathToFileURL(path.join(uiRoot,name)).href);const headers=new Headers(response.headers);
      headers.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'");headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});
    });
    const bundled=path.join(process.resourcesPath,'codex','bin','codex.exe');
    noteFiles=createNoteFiles({dataRoot});service=createService({dataRoot,noteFiles,codexPath:fs.existsSync(bundled)?bundled:undefined});
    runtime=createRuntime({uiRoot,dataFile:path.join(dataRoot,'notes.json'),native:(action,data)=>service.invoke(action,data),windows:{
      get:id=>info(windows.get(id)),list:()=>[...windows.values()].map(info),
      create:async url=>info(await createWindow(new URL(url).pathname.slice(1))),
      update:async(id,changes)=>{const win=windows.get(id);if(changes.focused){win.show();win.focus();}if(typeof changes.muted==='boolean')win.webContents.setAudioMuted(changes.muted);return info(win);},
      remove:async id=>{windows.get(id)?.destroy();},
      openSettings,openShortcuts:()=>dialog.showMessageBox({message:'Alt+W opens the panel. Alt+Q hides it. Alt+M opens its options. Alt+Shift+S opens settings.',detail:'These shortcuts work while the program has focus. Native Windows dialogs can take priority.'}),
      save:async(id,options)=>{const staged=exportsByWindow.get(id);if(!staged||staged.url!==options.url)throw Error('The document export expired. Try again.');const r=await dialog.showSaveDialog(windows.get(id),{title:'Save as',defaultPath:path.basename(options.filename)});if(r.canceled)return 0;await fs.promises.writeFile(r.filePath,staged.bytes);return 1;}
    }});
    await createWindow();if(process.argv.includes('--create-shortcut'))await createShortcut();
  }).catch(error=>{try{fs.writeFileSync(path.join(dataRoot,'startup-error.log'),String(error.stack||error));}catch{}dialog.showErrorBox('Notes Workspace could not start',error.message);quitting=true;app.quit();});
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitting)return;event.preventDefault();if(closing)return;closing=true;
  Promise.all([...windows.values()].filter(w=>w.webContents.getURL()===ORIGIN+'/editor.html').map(w=>w.webContents.executeJavaScript('Promise.all([globalThis.NotepadEditor?.flush(),globalThis.NotepadAssistant?.beforeNoteSwitch()])').catch(()=>{}))).then(()=>runtime?.close()).finally(()=>{service?.close();quitting=true;app.quit();});
});
module.exports={diagnostics:()=>({appId:APP_ID,iconPath,dataRoot,version:'5.2.0'})};
