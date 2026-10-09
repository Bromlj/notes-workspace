'use strict';
// Drives the actual packaged desktop executable in isolated application profiles.
// The deterministic Codex process is signed Node executing a local protocol
// fixture. It does not read the user's account, browser profile or projects.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const ROOT=path.resolve(__dirname,'..');
const EXE=process.env.NOTES_DESKTOP_EXE||path.join(ROOT,'desktop','dist','Notes Workspace','Notes Workspace.exe');
const NODE=process.env.NOTES_TEST_NODE||process.execPath;
const OUTPUT=path.join(__dirname,'desktop-e2e-results.json');
const results=[],errors=[],profiles=[];let application,page,currentData;
function fixtureProfile(name){
 const data=fs.mkdtempSync(path.join(__dirname,'desktop-e2e-'+name+'-'));
 fs.mkdirSync(path.join(data,'Conversations'),{recursive:true});fs.mkdirSync(path.join(data,'codex-home'));
 fs.copyFileSync(path.join(__dirname,'desktop-app-server-fixture.cjs'),path.join(data,'Conversations','app-server'));profiles.push(data);return data;
}
async function launch(data,extra={}){
 currentData=data;const env={...process.env,NOTES_DESKTOP_DATA_DIR:data,NOTES_CODEX:NODE,CODEX_HOME:path.join(data,'codex-home'),...extra};delete env.ELECTRON_RUN_AS_NODE;if(extra.NOTES_CODEX===null)delete env.NOTES_CODEX;
 application=await _electron.launch({executablePath:EXE,args:[],env,timeout:45000});
 page=await application.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.notepadReady,{},{timeout:30000});
 return page;
}
const state=async()=>page.evaluate(async()=> (await NoteConnection.request('AI_READY')).assistant);
const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
async function reveal(){await page.locator('#editor').press('Alt+w');await page.waitForFunction(()=>!document.querySelector('#assistant-panel').hidden);await page.waitForFunction(()=>!document.querySelector('#assistant-send').disabled,{},{timeout:20000});}
async function options(){if(await page.locator('#assistant-settings').isHidden())await page.locator('#assistant-options').click();}
async function projectDetails(){if(!await page.locator('#assistant-project-details').evaluate(e=>e.open))await page.locator('#assistant-project-details > summary').click();}
async function waitAssistant(id){await page.waitForFunction(async expected=>(await NoteConnection.request('AI_READY')).assistant.id===expected,id);}
async function waitCompleted(){await page.waitForFunction(()=>document.querySelector('#assistant-stop').hidden&&document.querySelector('#assistant-output').value.includes('Fixture completed response'),{},{timeout:20000});}
async function send(text){await page.locator('#assistant-question').fill(text);await page.locator('#assistant-question').press('Enter');await page.waitForFunction(()=>!document.querySelector('#assistant-stop').hidden);}
async function close(){if(application){await application.close();application=null;}}
// Chromium's CDP keyboard dispatch does not emit Electron before-input-event.
// Use Electron's public input API for the app-level native shortcut boundary.
async function nativeAlt(target,key,shift=false){await application.evaluate(({BrowserWindow},{url,key,shift})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);if(!win)throw Error('Test window not found.');const modifiers=shift?['alt','shift']:['alt'];win.webContents.sendInputEvent({type:'keyDown',keyCode:key.toUpperCase(),modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:key.toUpperCase(),modifiers});},{url:target.url(),key,shift});}
async function openSettings(){const opened=application.waitForEvent('window');await nativeAlt(page,'s',true);const settings=await opened;settings.setDefaultTimeout(12000);settings.on('pageerror',e=>errors.push(e.message));await settings.waitForFunction(()=>document.querySelectorAll('#shortcuts kbd').length===4);return settings;}
async function calls(){const file=path.join(currentData,'Conversations','fixture-calls.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
(async()=>{
 assert(fs.existsSync(EXE),'Build the desktop executable first: '+EXE);
 const data=fixtureProfile('main'),alpha=path.join(data,'project-alpha'),beta=path.join(data,'project-beta');fs.mkdirSync(alpha);fs.mkdirSync(beta);
 try{
  await launch(data);
  await check('the packaged EXE opens a local native Notepad window with sandboxed renderer',async()=>{
   assert.match(page.url(),/^notes:\/\/app\/editor\.html/);
   const actual=await application.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('editor.html'));const p=w.webContents.getLastWebPreferences();return {exe:app.getPath('exe'),name:app.getName(),title:w.getTitle(),nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox,preload:p.preload};});
   assert.equal(path.resolve(actual.exe).toLowerCase(),path.resolve(EXE).toLowerCase());assert.match(actual.title,/Notepad/i);assert.equal(actual.nodeIntegration,false);assert.equal(actual.contextIsolation,true);assert.equal(actual.sandbox,true);
   assert.equal(await page.evaluate(()=>typeof NoteDesktop.request),'function');
   assert.deepEqual(await page.evaluate(()=>({require:typeof require,process:typeof process})),{require:'undefined',process:'undefined'});
   assert.equal(await page.locator('#assistant-panel').isVisible(),false);assert.equal(await page.locator('.notepad-mark').isVisible(),true);
  });
  await check('the program configures its own Windows application identity and Notepad-style icon',async()=>{
   const d=await application.evaluate(({app,nativeImage})=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/main.cjs'),d=load(app.getAppPath()).diagnostics(),image=nativeImage.createFromPath(d.iconPath);return {...d,version:app.getVersion(),empty:image.isEmpty(),size:image.getSize()};});
   assert.equal(d.appId,'NotesWorkspace.Desktop');assert.equal(d.empty,false);assert(d.size.width>=16&&d.size.height>=16);assert.equal(path.resolve(d.dataRoot).toLowerCase(),path.resolve(data).toLowerCase());
   assert.equal(d.version,JSON.parse(fs.readFileSync(path.join(ROOT,'desktop','package.json'),'utf8')).version);
   const official=path.join(ROOT,'desktop','node_modules','electron','dist','electron.exe'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');assert.equal(hash(EXE),hash(official),'Packaged executable preserves the official Electron binary without resource editing.');
  });
  await check('ordinary notepad editing, visible formatting, find and replace work',async()=>{
   const e=page.locator('#editor');await e.fill('Ordinary private note');await e.press('Control+a');await page.locator('[data-format="bold"]').click();assert.equal(await e.locator('b,strong').innerText(),'Ordinary private note');assert.doesNotMatch(await e.innerText(),/\*\*/);await page.locator('[data-format="bold"]').click();assert.equal(await e.locator('b,strong').count(),0);
   await e.fill('first\nsecond\nthird');await e.press('Control+Home');await e.press('Control+h');await page.locator('#find-text').fill('second');await page.locator('#find-next').click();assert.equal(await page.evaluate(()=>getSelection().toString()),'second');await page.locator('#replace-text').fill('changed');await page.locator('#replace-one').click();assert.equal(await e.evaluate(e=>e.value),'first\nchanged\nthird');await page.locator('#close-find').click();
   await e.fill('Ordinary private note A');await page.evaluate(()=>NotepadEditor.flush());
  });
  await check('Save As reaches the native save dialog and writes the chosen text file',async()=>{
   const saved=path.join(data,'native-save.txt');await application.evaluate(({dialog},filePath)=>{globalThis.__desktopE2ESaveCalls=0;dialog.showSaveDialog=async()=>{globalThis.__desktopE2ESaveCalls++;return {canceled:false,filePath};};},saved);
   await page.locator('#editor').press('Control+Shift+s');await page.waitForFunction(file=>globalThis.NotepadEditor?.file()?.path===file,saved);
   assert.equal(fs.readFileSync(saved,'utf8').replace(/\r\n/g,'\n'),'Ordinary private note A');assert.equal(await application.evaluate(()=>globalThis.__desktopE2ESaveCalls),1);
  });
  await check('untrusted navigation and script-created windows are blocked',async()=>{
   const before=application.windows().length;await page.evaluate(()=>{window.open('javascript:document.title="UNTRUSTED"');});await page.waitForTimeout(200);assert.equal(application.windows().length,before);
   await page.evaluate(()=>{location.href='https://example.invalid/desktop-e2e-blocked';});await page.waitForTimeout(200);assert.match(page.url(),/^notes:\/\/app\/editor\.html/);assert(await page.locator('#editor').isVisible());
  });
  // Electron prevents the navigation, but Chromium's driver can retain that
  // navigation as pending. A deliberate local reload clears the driver state.
  await page.goto('notes://app/editor.html',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.notepadReady);
  await reveal();
  await check('Alt+M opens the panel options from the native window',async()=>{await nativeAlt(page,'m');await page.waitForFunction(()=>!document.querySelector('#assistant-settings').hidden);});
  await check('project Browse reaches the native folder picker and fills the chosen path',async()=>{
   await application.evaluate(({dialog},folder)=>{globalThis.__desktopE2EFolderOptions=null;dialog.showOpenDialog=async(_win,options)=>{globalThis.__desktopE2EFolderOptions=options;return {canceled:false,filePaths:[folder]};};},alpha);
   await page.getByRole('button',{name:'Browse folder…',exact:true}).click();await page.waitForFunction(folder=>document.querySelector('#assistant-project').value===folder,alpha);const chosen=await application.evaluate(()=>globalThis.__desktopE2EFolderOptions);assert(chosen.properties.includes('openDirectory'));
  });
  await check('account-provided model and thinking settings are selectable',async()=>{
   assert.deepEqual(await page.locator('#assistant-model option').evaluateAll(e=>e.map(o=>o.value)),['fixture-codex','fixture-codex-second']);
   await page.locator('#assistant-model').selectOption('fixture-codex-second');await page.waitForFunction(()=>!document.querySelector('#assistant-model').disabled);await page.locator('#assistant-thinking').selectOption('high');await page.waitForFunction(()=>!document.querySelector('#assistant-thinking').disabled);
   assert.equal(await page.locator('#assistant-model').inputValue(),'fixture-codex-second');assert.equal(await page.locator('#assistant-thinking').inputValue(),'high');
  });
  await projectDetails();await page.locator('#assistant-project').fill(alpha);await page.locator('#assistant-project-name').fill('Alpha project');await page.locator('#assistant-project-save').click();await page.waitForFunction(()=>document.querySelector('#assistant-status').textContent.includes('Project folder selected'));
  const a=await state();await page.locator('#assistant-question').fill('Draft A');await page.locator('#new-tab').click();await page.waitForFunction(()=>document.querySelectorAll('#document-tabs [role=tab]').length===2&&document.querySelector('#assistant-question').value==='');const b=await state();
  await check('plus opens a separate note and Codex chat in the selected project',async()=>{assert.notEqual(a.id,b.id);assert.notEqual(a.noteId,b.noteId);assert.equal(b.project,alpha);assert.equal(await page.locator('#editor').innerText(),'');assert.equal(await page.locator('#assistant-question').inputValue(),'');assert.equal(await page.locator('#assistant-output').inputValue(),'');});
  await page.locator('#editor').fill('Ordinary private note B');await page.locator('#assistant-question').fill('Draft B');await page.locator('#document-tabs [role=tab]').nth(0).click();await waitAssistant(a.id);await page.waitForFunction(()=>document.querySelector('#assistant-question').value==='Draft A');
  await check('tab switching restores only the owning note and draft',async()=>{assert.equal(await page.locator('#editor').innerText(),'Ordinary private note A');assert.equal(await page.locator('#assistant-question').inputValue(),'Draft A');});
  await page.locator('#assistant-upload').setInputFiles({name:'attachment-a.txt',mimeType:'text/plain',buffer:Buffer.from('Attached fixture evidence 702.')});await page.waitForFunction(()=>document.querySelector('#assistant-files').textContent.includes('attachment-a.txt'));
  await send('FIXTURE_A: use the attached evidence');await page.locator('#assistant-question').press('Alt+q');
  await check('Alt+Q conceals the entire panel and repeated presses cannot reveal it',async()=>{assert.equal(await page.locator('#assistant-panel').isVisible(),false);await page.locator('#editor').press('Alt+q');assert.equal(await page.locator('#assistant-panel').isVisible(),false);const error=await page.evaluate(()=>NoteConnection.request('AI_SEND',{id:crypto.randomUUID(),text:'MUST_NOT_SEND'}).then(()=>'',e=>e.message));assert.match(error,/disabled/);});
  await waitCompleted();await reveal();
  await check('accepted Codex work completes while hidden and keeps ordinary notes separate',async()=>{
   assert.match(await page.locator('#assistant-output').inputValue(),/FIXTURE_A/);assert.equal(await page.locator('#editor').innerText(),'Ordinary private note A');
   const turn=(await calls()).find(x=>x.method==='turn/start');assert.equal(turn.params.model,'fixture-codex-second');assert.equal(turn.params.effort,'high');assert.equal(turn.params.cwd,alpha);assert.equal(turn.params.sandboxPolicy.networkAccess,false);assert(turn.params.input.some(i=>i.text?.includes('Attached fixture evidence 702.')));assert(!turn.params.input.some(i=>i.text?.includes('Ordinary private note')));
  });
  const aComplete=await state();await page.locator('#document-tabs [role=tab]').nth(1).click();await waitAssistant(b.id);await send('FIXTURE_B: separate question');await waitCompleted();const bComplete=await state();
  await check('each tab uses its own actual protocol thread and transcript',async()=>{assert(aComplete.threadId);assert(bComplete.threadId);assert.notEqual(aComplete.threadId,bComplete.threadId);assert.match(await page.locator('#assistant-output').inputValue(),/FIXTURE_B/);assert.doesNotMatch(await page.locator('#assistant-output').inputValue(),/FIXTURE_A/);assert.equal(await page.locator('#editor').innerText(),'Ordinary private note B');});
  await send('FIXTURE_APPROVAL: require an explicit decision');await page.waitForFunction(()=>document.querySelector('#assistant-requests').textContent.includes('Explicit disposable approval test'));await page.locator('#assistant-question').press('Alt+q');
  await check('hidden approval requests wait without being automatically accepted',async()=>{await page.waitForTimeout(900);assert.equal(await page.locator('#assistant-panel').isVisible(),false);assert((await state()).pending);assert.equal((await calls()).filter(x=>x.id>=9000&&!x.method).length,0);});
  await reveal();await page.getByRole('button',{name:'Decline',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#assistant-stop').hidden&&document.querySelector('#assistant-output').value.includes('approval was decline'));
  await check('an explicit approval decision reaches only its waiting turn',async()=>{const replies=(await calls()).filter(x=>x.id>=9000&&!x.method);assert.equal(replies.length,1);assert.deepEqual(replies[0].result,{decision:'decline'});});
  await options();await projectDetails();await page.locator('#assistant-project').fill(beta);await page.locator('#assistant-project-name').fill('Beta project');await page.locator('#assistant-project-save').click();await page.waitForFunction(()=>document.querySelector('#assistant-status').textContent.includes('Project folder selected'));
  await check('named projects keep independent conversations and history',async()=>{const p=await page.evaluate(()=>NoteConnection.request('AI_PROJECTS'));assert.equal(p.currentProject,beta);assert(p.projects.some(x=>x.name==='Alpha project'&&x.path===alpha));assert(p.projects.some(x=>x.name==='Beta project'&&x.path===beta));const h=await page.evaluate(()=>NoteConnection.request('AI_HISTORY'));assert(!h.conversations.some(x=>[a.id,b.id].includes(x.id)));assert.equal((await state()).messages.length,0);});
  await page.locator('#assistant-project-list').selectOption((await page.evaluate(()=>NoteConnection.request('AI_PROJECTS'))).projects.find(x=>x.path===alpha).id);await waitAssistant(b.id);await page.locator('#assistant-history-refresh').click();await page.waitForFunction(id=>[...document.querySelector('#assistant-history').options].some(o=>o.value===id),a.id);await page.locator('#assistant-history').selectOption(a.id);await waitAssistant(a.id);await page.waitForFunction(()=>document.querySelector('#editor').value==='Ordinary private note A'&&document.querySelector('#assistant-output').value.includes('FIXTURE_A'));
  await check('project history opens its owning notepad document',async()=>{assert.equal(await page.locator('#editor').innerText(),'Ordinary private note A');assert.match(await page.locator('#assistant-output').inputValue(),/FIXTURE_A/);assert.doesNotMatch(await page.locator('#assistant-output').inputValue(),/FIXTURE_B/);});
  await page.evaluate(()=>NotepadEditor.flush());await page.screenshot({path:path.join(ROOT,'docs','desktop-reference-open.png')});await page.locator('#assistant-question').press('Alt+q');await page.screenshot({path:path.join(ROOT,'docs','desktop-notepad-hidden.png')});await close();await launch(data);
  await check('closing and relaunching recovers the note and its own chat and starts concealed',async()=>{assert.equal(await page.locator('#assistant-panel').isVisible(),false);assert.equal(await page.locator('#editor').innerText(),'Ordinary private note A');assert.equal((await state()).id,a.id);await reveal();assert.match(await page.locator('#assistant-output').inputValue(),/FIXTURE_A/);});
  let settings=await openSettings();
  await check('desktop settings exports a local backup containing notes and conversations',async()=>{
   assert.equal(settings.url(),'notes://app/options.html');const saved=path.join(data,'desktop-backup.json');await application.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await settings.locator('#desktop-export').click();await settings.waitForFunction(()=>document.querySelector('#desktop-status').textContent.includes('Backup saved'));
   const backup=JSON.parse(fs.readFileSync(saved,'utf8'));assert.equal(backup.format,'notes-workspace-backup');assert(backup.data['note:'+a.noteId]);assert(backup.data['assistant:'+a.id]);assert(!Object.keys(backup.data).some(k=>/auth|token|cookie/i.test(k)));
  });
  await settings.locator('#new-password').fill('desktop-test-passphrase');await settings.locator('#repeat-password').fill('desktop-test-passphrase');await settings.locator('#save-passphrase').click();await settings.waitForFunction(()=>document.querySelector('#passphrase-status').textContent.includes('Passphrase set'));
  await check('Alt+Q from settings closes the auxiliary window and conceals the editor panel',async()=>{const closed=settings.waitForEvent('close');await nativeAlt(settings,'q');await closed;await page.waitForFunction(()=>document.querySelector('#assistant-panel').hidden);assert.equal(application.windows().length,1);});
  await page.bringToFront();await page.locator('#editor').press('Alt+w');await page.waitForFunction(()=>document.querySelector('#unlock-dialog').open);
  await check('optional restore passphrase is configured through the actual desktop settings',async()=>{assert.equal(await page.locator('#unlock-dialog').isVisible(),true);assert.equal(await page.locator('#assistant-panel').isVisible(),false);});
  await page.locator('#unlock-password').fill('wrong-passphrase');await page.locator('#unlock-submit').click();await page.waitForFunction(()=>document.querySelector('#unlock-error').textContent.includes('Incorrect'));
  await check('a wrong passphrase leaves the panel hidden and Alt+Q cancels unlocking',async()=>{assert.equal(await page.locator('#assistant-panel').isVisible(),false);await page.locator('#unlock-password').press('Alt+q');assert.equal(await page.locator('#unlock-dialog').isVisible(),false);assert.equal(await page.locator('#assistant-panel').isVisible(),false);});
  await page.locator('#editor').press('Alt+w');await page.locator('#unlock-password').fill('desktop-test-passphrase');
  await check('Alt+Q wins over a correct unlock already queued for submission',async()=>{await page.evaluate(()=>{document.querySelector('#unlock-form').requestSubmit();document.dispatchEvent(new KeyboardEvent('keydown',{key:'q',code:'KeyQ',altKey:true,bubbles:true}));});await page.waitForTimeout(400);assert.equal(await page.locator('#unlock-dialog').isVisible(),false);assert.equal(await page.locator('#assistant-panel').isVisible(),false);});
  await page.locator('#editor').press('Alt+w');await page.locator('#unlock-password').fill('desktop-test-passphrase');await page.locator('#unlock-submit').click();await page.waitForFunction(()=>!document.querySelector('#assistant-panel').hidden);
  await check('the correct passphrase restores the same saved conversation',async()=>{assert.equal((await state()).id,a.id);assert.match(await page.locator('#assistant-output').inputValue(),/FIXTURE_A/);});
  await close();await launch(fixtureProfile('signed-out'),{NOTES_FIXTURE_SIGNED_OUT:'1',NOTES_FIXTURE_SANDBOX_UNCONFIGURED:'1'});
  await check('a friend with no sign-in can use notes and sees an actionable AI sign-in state',async()=>{await page.locator('#editor').fill('Fresh user can take notes');await page.evaluate(()=>NotepadEditor.flush());await page.locator('#editor').press('Alt+w');await page.waitForFunction(()=>!document.querySelector('#assistant-panel').hidden);await page.waitForFunction(()=>/sign.?in|signed|account|install/i.test(document.querySelector('#assistant-status').textContent));assert.equal(await page.locator('#assistant-send').isDisabled(),true);assert.equal(await page.locator('#editor').innerText(),'Fresh user can take notes');});
  await options();const opened=application.waitForEvent('window');await page.getByRole('button',{name:'Account…',exact:true}).click();const account=await opened;account.setDefaultTimeout(12000);account.on('pageerror',e=>errors.push(e.message));await account.waitForFunction(()=>document.querySelector('#account-status').textContent.includes('Not signed in'));
  await check('first-time Windows sandbox setup reports readiness and uses the fixed official setup action',async()=>{
   await account.waitForFunction(()=>document.querySelector('#sandbox-status').textContent.includes('First-time'));await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await account.locator('#sandbox-setup').click();await account.waitForFunction(()=>document.querySelector('#sandbox-status').textContent.includes('ready for project commands'));const setup=(await calls()).find(x=>x.method==='windowsSandbox/setupStart');assert.deepEqual(setup.params,{mode:'elevated'});assert.equal(await account.locator('#sandbox-setup').isVisible(),false);
  });
  await check('the Account window starts and cancels the official ChatGPT sign-in flow',async()=>{
   await application.evaluate(({shell})=>{globalThis.__desktopE2ELoginURLs=[];shell.openExternal=async url=>{globalThis.__desktopE2ELoginURLs.push(url);};});await account.locator('#account-login').click();await account.waitForFunction(()=>!document.querySelector('#account-cancel').hidden);const urls=await application.evaluate(()=>globalThis.__desktopE2ELoginURLs);assert.deepEqual(urls,['https://auth.openai.com/fixture-only']);assert((await calls()).some(x=>x.method==='account/login/start'));
   await account.locator('#account-cancel').click();await account.waitForFunction(()=>document.querySelector('#account-status').textContent.includes('Not signed in'));assert((await calls()).some(x=>x.method==='account/login/cancel'));
  });
  await check('Alt+Q also conceals the Account window and leaves only the ordinary notepad',async()=>{const closed=account.waitForEvent('close');await nativeAlt(account,'q');await closed;await page.waitForFunction(()=>document.querySelector('#assistant-panel').hidden);assert.equal(application.windows().length,1);assert.equal(await page.locator('#editor').innerText(),'Fresh user can take notes');});
  await close();await launch(fixtureProfile('bundled-first-run'),{NOTES_CODEX:null});
  await check('the bundled real Codex runtime starts for a new user without external Node or a saved sign-in',async()=>{
   await page.locator('#editor').fill('Bundled runtime first-run note');await page.evaluate(()=>NotepadEditor.flush());await page.locator('#editor').press('Alt+w');await page.waitForFunction(()=>!document.querySelector('#assistant-panel').hidden);await page.waitForFunction(()=>/sign.?in|signed|account/i.test(document.querySelector('#assistant-status').textContent),{},{timeout:30000});await options();const opened=application.waitForEvent('window');await page.getByRole('button',{name:'Account…',exact:true}).click();const account=await opened;account.setDefaultTimeout(30000);account.on('pageerror',e=>errors.push(e.message));await account.waitForFunction(()=>document.querySelector('#account-status').textContent.includes('Not signed in'));assert.equal(await account.locator('#account-login').isEnabled(),true);assert.equal(await page.locator('#editor').innerText(),'Bundled runtime first-run note');
  });
  await check('no renderer exceptions occurred during desktop flows',async()=>assert.deepEqual(errors,[]));
 }catch(e){console.error(e.stack);if(page&&!page.isClosed()){console.error('STATUS',await page.locator('#assistant-status').textContent().catch(()=>''));console.error('EDITOR ERROR',await page.locator('#error').textContent().catch(()=>''));await page.screenshot({path:path.join(ROOT,'docs','desktop-e2e-failure.png')}).catch(()=>{});}process.exitCode=1;}
 finally{await close();fs.writeFileSync(OUTPUT,JSON.stringify({date:new Date().toISOString(),executable:EXE,scope:'Packaged desktop EXE with isolated deterministic app-server and real bundled-runtime signed-out first run; native dialogs and external sign-in launch are stubbed in the main process by the test driver.',passed:results,errors,failed:!!process.exitCode,profiles},null,2));}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
