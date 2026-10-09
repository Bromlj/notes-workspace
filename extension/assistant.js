'use strict';
(() => {
  const $=id=>document.getElementById(id),panel=$('assistant-panel'),question=$('assistant-question');
  const request=(type,data)=>NoteConnection.request(type,data);
  let enabled=false,restoreToken=null,restoring=false,submitting=false,switching=false,state=null,settings=null,draftClock=0,draftTimer,uploadEpoch=0,contextEpoch=0,files=[],connecting=false,activitySignature='',requestSignature='',historyLoading=false,capabilitiesLoading=false,submitError='',projects=[];
  const context=()=>({epoch:contextEpoch,assistantId:state?.id});
  const sameContext=c=>c.epoch===contextEpoch&&c.assistantId===state?.id;
  const pretty=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
  function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;}
  function status(text,error=false){$('assistant-status').textContent=text;$('assistant-status').dataset.error=String(error);}
  function elapsed(){if(!state?.pending)return;if(submitError){status(submitError,true);return;}const seconds=Math.max(0,Math.floor((Date.now()-(state.pending.startedAt||Date.now()))/1000));const phase=(state.pending.requests||[]).length?'Waiting for your response':state.pending.phase||'Working';status(`${phase} · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} · Stop is available`);}
  function render(value,loadDraft=false){
    if(value)state=value;if(!state)return;
    const output=$('assistant-output'),atEnd=output.scrollTop+output.clientHeight>=output.scrollHeight-35;
    output.value=[...(state.messages||[]).map(m=>m.text),...(state.pending?.text?[state.pending.text]:[])].join('\n\n');if(atEnd)output.scrollTop=output.scrollHeight;
    if(loadDraft)question.value=state.draft||'';
    question.disabled=switching;$('assistant-attach').disabled=!enabled||switching;
    $('assistant-send').disabled=!enabled||submitting||switching||!settings;
    $('assistant-send').textContent=state.pending?'Steer':'Send';
    $('assistant-stop').hidden=!state.pending;
    for(const id of ['assistant-new','assistant-project-save','assistant-project-list','assistant-project-browse','assistant-history','assistant-review','assistant-compact'])$(id).disabled=!enabled||switching||!!state.pending;
    if(document.activeElement!==$('assistant-project'))$('assistant-project').value=state.project||settings?.defaultProject||'';
    renderProjectLabel();
    if(state.pending)elapsed();else status(submitError||state.error||(settings?'Ready · Codex connected':'Connecting to Codex…'),!!(submitError||state.error));
    renderActivity();renderRequests();renderNoteEditing();
  }
  function renderNoteEditing(){
    const stage=state?.noteEditStage,pending=!!stage&&stage.appliedRevision==null;
    const desktop=!!globalThis.NoteDesktop,file=globalThis.NotepadEditor?.file?.(),undo=!!globalThis.NotepadEditor?.canUndoAI?.();
    $('assistant-edit-note').checked=state?.editNote===true;
    $('assistant-edit-note').disabled=!enabled||switching||submitting;
    $('assistant-note-file').hidden=!desktop||!file;$('assistant-note-file').textContent=file?.path||file?.name||'';
    $('assistant-note-folder-scope').hidden=!desktop;
    $('assistant-note-edit-status').textContent=pending?(stage.conflict?'The file changed while your displayed note also changed. Review before replacing your draft.':state?.editNote?'A file revision is waiting. Show this note to catch up.':'Editing paused. Apply pending replaces the displayed draft once; automatic updates stay off.'):(state?.editNote?(desktop?'On · Codex tools edit the file directly. Hiding freezes this view while accepted work continues.':'On · the next task can revise this note. Hiding pauses visible changes; work continues.'):(desktop&&state?.pending?'Off for new tasks · accepted file changes can still finish in the active task.':'Off · your note is not sent automatically.'));
    if(undo&&state?.pending)$('assistant-note-edit-status').textContent+=' Undo AI edit is available when this task finishes.';
    if(state?.noteFileError)$('assistant-note-edit-status').textContent+=' '+state.noteFileError;
    $('assistant-note-preview').hidden=!pending;$('assistant-note-preview-text').value=pending?stage.text:'';
    $('assistant-note-apply').hidden=$('assistant-note-discard').hidden=!pending;
    $('assistant-note-apply').disabled=!enabled||switching||submitting;
    $('assistant-note-discard').disabled=!enabled||switching;
    $('assistant-note-undo').hidden=!undo;
    $('assistant-note-undo').disabled=!enabled||switching||!!state?.pending;
  }
  async function syncNote(){
    const current=context();
    try{await globalThis.NotepadEditor?.flush();if(!enabled||switching||!sameContext(current))return;const r=await request('AI_NOTE_SYNC',{assistantId:current.assistantId,...globalThis.NotepadEditor?.fileGuard?.()});if(sameContext(current))render(r.assistant);}
    catch(e){if(enabled&&sameContext(current))status(e.message,true);}
  }
  function renderActivity(){
    const work=state.pending||state,activity=work.activity||[],diff=work.diff||'',plan=work.plan||[];
    const signature=JSON.stringify([activity,diff,plan]);if(signature===activitySignature)return;activitySignature=signature;
    $('assistant-progress').hidden=!activity.length&&!diff&&!plan.length;
    const box=$('assistant-activity'),atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-30;box.replaceChildren();
    $('assistant-activity-summary').textContent=`Activity (${activity.length})`;$('assistant-activity-details').hidden=!activity.length;
    for(const item of activity){
      const row=element('div',undefined,'assistant-activity-item');row.dataset.status=item.status||'';
      const title={commandExecution:'Command',fileChange:'File changes',mcpToolCall:'Connected tool',webSearch:'Web search',collabAgentToolCall:'Agent',imageGeneration:'Image generation'}[item.type]||item.type||'Tool';
      row.append(element('div',`${item.name||title}${item.status?' · '+item.status:''}`,'assistant-activity-title'));
      if(item.cwd)row.append(element('small',item.cwd));
      if(item.command)row.append(element('pre',Array.isArray(item.command)?item.command.join(' '):item.command));
      if(item.summary)row.append(element('p',pretty(item.summary)));
      if(item.changes?.length)for(const change of item.changes){row.append(element('div',`${change.kind?.type||change.kind||'Change'} · ${change.path||change.file||''}`));if(change.diff)row.append(element('pre',change.diff));}
      if(item.output)row.append(element('pre',pretty(item.output)));
      if(item.exitCode!==undefined&&item.exitCode!==null)row.append(element('small',`Exit code ${item.exitCode}`));
      box.append(row);
    }
    if(atEnd)box.scrollTop=box.scrollHeight;
    $('assistant-diff-details').hidden=!diff;$('assistant-diff').textContent=diff;
    const list=$('assistant-plan');list.replaceChildren();list.hidden=!plan.length;
    for(const step of plan){const li=element('li',step.step||step.text||'');li.dataset.status=step.status||'';list.append(li);}
  }
  function renderRequests(){
    const requests=state.pending?.requests||[],signature=JSON.stringify(requests);
    if(signature===requestSignature)return;requestSignature=signature;
    const box=$('assistant-requests');box.replaceChildren();box.hidden=!requests.length;
    for(const pending of requests){
      const p=pending.params||{},card=element('div',undefined,'assistant-request'),form=element('form');card.dataset.requestId=String(pending.id);
      card.append(element('h3',{command:'Command approval',file:'File change approval',permissions:'Additional access',input:'Your response is needed',elicitation:'Connected service request'}[pending.kind]||'Your response is needed'));
      if(p.reason)card.append(element('p',p.reason));if(p.message)card.append(element('p',p.message));if(p.cwd)card.append(element('p',`Folder: ${p.cwd}`));
      const error=element('div',undefined,'assistant-request-error');error.setAttribute('role','status');
      const actions=element('div',undefined,'assistant-actions');
      async function reply(response){
        if(!enabled||panel.hidden||switching)return;const current=context();
        for(const b of card.querySelectorAll('button'))b.disabled=true;error.textContent='';
        try{await request('AI_REPLY',{id:pending.id,response,assistantId:current.assistantId});if(!sameContext(current))return;card.remove();if(!box.children.length)box.hidden=true;status('Response sent.');}
        catch(e){if(!sameContext(current))return;error.textContent=e.message;for(const b of card.querySelectorAll('button'))b.disabled=false;}
      }
      function button(label,response){const b=element('button',label);b.type='button';b.addEventListener('click',()=>void reply(typeof response==='function'?response():response));actions.append(b);}
      if(pending.kind==='command'||pending.kind==='file'){
        if(p.command)card.append(element('pre',Array.isArray(p.command)?p.command.join(' '):p.command));
        if(p.changes)card.append(element('pre',pretty(p.changes)));if(p.grantRoot)card.append(element('p',`Requested write folder: ${p.grantRoot}`));
        if(p.additionalPermissions)card.append(element('pre',pretty(p.additionalPermissions)));if(p.networkApprovalContext)card.append(element('pre',pretty(p.networkApprovalContext)));
        const available=p.availableDecisions;const allows=d=>!Array.isArray(available)||available.includes(d);
        if(allows('accept'))button('Allow once',{decision:'accept'});
        if(allows('decline'))button('Decline',{decision:'decline'});
        if(allows('cancel'))button('Cancel work',{decision:'cancel'});
        if(!actions.children.length)card.append(element('p','This request has no supported one-time decision. Stop the work to cancel it.'));
      }else if(pending.kind==='permissions'){
        card.append(element('pre',pretty(p.permissions||{})));button('Allow for this turn',{permissions:p.permissions||{},scope:'turn'});button('Decline',{permissions:{},scope:'turn'});
      }else if(pending.kind==='input'){
        const answers=[];
        for(const q of p.questions||[]){
          const field=element('fieldset'),legend=element('legend',q.header||'Question');field.append(legend,element('p',q.question||''));
          const group=`answer-${pending.id}-${q.id}`,options=[];
          for(const option of q.options||[]){const label=element('label'),radio=element('input');radio.type='radio';radio.name=group;radio.value=option.label;const text=element('span',option.label);if(option.description)text.append(element('small',option.description));label.append(radio,text);field.append(label);options.push(radio);}
          const input=element('input');input.type=q.isSecret?'password':'text';input.autocomplete='off';input.setAttribute('aria-label',q.question||q.header||'Answer');input.placeholder=options.length?'Or write your own answer':'Your answer';input.addEventListener('input',()=>{if(input.value)for(const radio of options)radio.checked=false;});for(const radio of options)radio.addEventListener('change',()=>{if(radio.checked)input.value='';});field.append(input);form.append(field);answers.push({id:q.id,input,options});
        }
        const send=element('button','Send response');send.type='submit';actions.append(send);form.append(actions);
        form.addEventListener('submit',e=>{e.preventDefault();const result={};for(const a of answers){const value=a.input.value.trim()||a.options.find(o=>o.checked)?.value;if(!value){error.textContent='Answer each question before sending.';return;}result[a.id]={answers:[value]};}void reply({answers:result});});
        card.append(form);
      }else if(pending.kind==='elicitation'){
        let input;
        if(p.url){let url;try{url=new URL(p.url);}catch{}if(url&&['https:','http:'].includes(url.protocol)){const a=element('a','Open service request');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';card.append(a);}else card.append(element('p','This service supplied an unsupported link.'));}
        if(p.requestedSchema){const details=element('details');details.append(element('summary','Requested form schema'),element('pre',pretty(p.requestedSchema)));card.append(details);input=element('textarea');input.setAttribute('aria-label','Service response JSON');input.placeholder='Enter the requested response as a JSON object';form.append(input);card.append(form);}
        const accept=element('button',input?'Send form':'Continue');accept.type='button';accept.addEventListener('click',()=>{let content=null;if(input){try{content=JSON.parse(input.value);if(!content||typeof content!=='object'||Array.isArray(content))throw Error();}catch{error.textContent='Enter a valid JSON object for this form.';return;}}void reply({action:'accept',content});});actions.append(accept);button('Decline',{action:'decline',content:null});button('Cancel',{action:'cancel',content:null});
      }else card.append(element('p','This request is not supported. Stop the work to cancel it.'));
      if(pending.kind!=='input')card.append(actions);card.append(error);box.append(card);
    }
  }
  function renderFiles(){const box=$('assistant-files');box.replaceChildren();box.hidden=!files.length;for(const file of files){const b=element('button',file.name+' ×');b.type='button';b.title='Remove attachment';b.addEventListener('click',()=>{files=files.filter(f=>f.id!==file.id);renderFiles();void request('AI_REMOVE_UPLOAD',{id:file.id}).catch(()=>{});});box.append(b);}}
  function discardFiles(){for(const file of files)void request('AI_REMOVE_UPLOAD',{id:file.id}).catch(()=>{});files=[];renderFiles();}
  async function saveDraft(){clearTimeout(draftTimer);if(!state?.id||switching)return;await request('AI_DRAFT',{text:question.value,assistantId:state.id});}
  function clearContext(){
    contextEpoch++;uploadEpoch++;draftClock++;clearTimeout(draftTimer);submitting=false;submitError='';discardFiles();
    question.value='';question.disabled=switching;$('assistant-output').value='';$('assistant-activity').replaceChildren();$('assistant-diff').textContent='';$('assistant-plan').replaceChildren();$('assistant-requests').replaceChildren();
    $('assistant-progress').hidden=$('assistant-requests').hidden=true;activitySignature=requestSignature='';$('assistant-stop').hidden=true;$('assistant-send').disabled=true;
    $('assistant-capabilities').replaceChildren();historyLoading=capabilitiesLoading=false;
    const conversation=element('option','Current conversation');conversation.value='';$('assistant-history').replaceChildren(conversation);
    $('assistant-current-project').textContent='Opening note…';$('assistant-current-project').title='';$('assistant-project').value='';$('assistant-project-name').value='';
  }
  async function beforeNoteSwitch(){
    const previous=state,oldDraft=question.value;switching=true;clearContext();state=null;status('Opening note…');
    for(const id of ['assistant-new','assistant-project-save','assistant-project-list','assistant-project-browse','assistant-history','assistant-review','assistant-compact'])$(id).disabled=true;
    if(previous?.id)await request('AI_DRAFT',{text:oldDraft,assistantId:previous.id});
  }
  function contextChanged(assistant){clearContext();switching=false;state=null;render(assistant,true);void loadProjects();if(enabled){void syncNote();if(!$('assistant-settings').hidden)void history();}}
  async function cancelNoteSwitch(){try{const r=await request('AI_READY');contextChanged(r.assistant);}catch(e){switching=false;status(e.message,true);}}
  function hide(notify=true){
    enabled=false;restoreToken=null;restoring=false;uploadEpoch++;panel.hidden=true;$('assistant-settings').hidden=true;$('assistant-diagnostic-text').hidden=true;
    $('assistant-send').disabled=true;$('editor').focus({preventScroll:true});void saveDraft().catch(()=>{});if(notify)void request('HIDE').catch(()=>{});
  }
  async function restore(){if(restoring||enabled||!globalThis.notepadReady){if(enabled)question.focus();return;}restoring=true;const token=crypto.randomUUID();restoreToken=token;try{await request('RESUME',{token});}catch(e){if(restoreToken===token){$('error').textContent=e.message;$('error').hidden=false;restoreToken=null;}}finally{if(restoreToken===token)restoring=false;}}
  globalThis.NotepadAssistant=Object.freeze({hide,restore,beforeNoteSwitch,cancelNoteSwitch,noteContext:contextChanged,chooseProject:selectProject,working:()=>!!state?.pending,token:()=>restoreToken,matches:t=>!!t&&t===restoreToken,visible:()=>enabled&&!panel.hidden&&!switching,owns:id=>state?.id===id&&!switching});
  function sameProject(a,b){return String(a||'').replace(/[\\/]+$/,'').toLowerCase()===String(b||'').replace(/[\\/]+$/,'').toLowerCase();}
  function renderProjectLabel(){
    const path=state?.project||'',project=projects.find(p=>sameProject(p.path,path));
    $('assistant-current-project').textContent=path?(project?.name||path.split(/[\\/]/).filter(Boolean).pop()||path):'No project selected';
    $('assistant-current-project').title=path||'Choose or browse a project folder below.';
    const select=$('assistant-project-list');select.value=project?.id||'';
    if(document.activeElement!==$('assistant-project-name'))$('assistant-project-name').value=project?.name||'';
  }
  function renderProjects(value){
    projects=Array.isArray(value)?value:[];const select=$('assistant-project-list');select.replaceChildren();
    const placeholder=element('option',projects.length?'Choose a project…':'No saved projects');placeholder.value='';select.append(placeholder);
    for(const project of projects){const option=element('option',project.name||project.path);option.value=project.id;option.title=project.path;select.append(option);}renderProjectLabel();
  }
  async function loadProjects(){const current=context();try{const r=await request('AI_PROJECTS');if(sameContext(current))renderProjects(r.projects);}catch(e){if(sameContext(current)&&enabled&&!$('assistant-settings').hidden)status(e.message,true);}}
  function controls(value){
    settings=value;const models=$('assistant-model');models.replaceChildren();
    for(const m of value.models){const o=element('option',m.displayName||m.model);o.value=m.model;models.append(o);}models.value=value.model;
    const model=value.models.find(m=>m.model===value.model),efforts=$('assistant-thinking');efforts.replaceChildren();
    for(const e of model?.supportedReasoningEfforts||[]){const o=element('option',{xhigh:'Extra high',max:'Maximum',ultra:'Ultra'}[e.reasoningEffort]||e.reasoningEffort[0].toUpperCase()+e.reasoningEffort.slice(1));o.value=e.reasoningEffort;o.title=e.description||'';efforts.append(o);}efforts.value=value.effort;
    models.disabled=efforts.disabled=false;render();
  }
  async function connect(refresh=false){if(connecting)return;connecting=true;status('Connecting to Codex…');try{controls(await request('AI_CONTROLS',{operation:refresh?'reconnect':'inspect'}));}catch(e){settings=null;render();status(e.message,true);}finally{connecting=false;}}
  async function choose(changedModel){
    if(!enabled||!settings)return;const model=settings.models.find(m=>m.model===$('assistant-model').value);if(!model)return;let effort=$('assistant-thinking').value;
    if(changedModel&&!model.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort))effort=model.defaultReasoningEffort;
    $('assistant-model').disabled=$('assistant-thinking').disabled=true;
    try{controls(await request('AI_CONTROLS',{operation:'choose',model:model.model,effort}));status(state?.pending?'Selection saved for the next question.':'Selection saved.');}catch(e){controls(settings);status(e.message,true);}
  }
  async function submit(){
    if(!enabled||switching||submitting||!settings)return;const text=question.value.trim();if(!text)return;const current=context();
    submitting=true;submitError='';const clock=draftClock,steering=!!state?.pending;render();status(steering?'Sending follow-up…':'Starting…');
    try{await saveDraft();if(!steering){if(globalThis.NoteDesktop)await globalThis.NotepadEditor?.ensureFile();await globalThis.NotepadEditor?.flush();}if(!enabled||!sameContext(current))return;const file=globalThis.NotepadEditor?.file?.();const value=await request(steering?'AI_STEER':'AI_SEND',{id:crypto.randomUUID(),text,files:files.map(f=>f.id),assistantId:current.assistantId,...file?{noteBindingId:file.bindingId,noteFileHash:file.hash}:{}});if(!sameContext(current))return;if(clock===draftClock)question.value='';files=[];renderFiles();render(value.assistant);await saveDraft();if(enabled&&sameContext(current))question.focus();}catch(e){if(sameContext(current)){submitError=e.message;status(submitError,true);}}finally{if(sameContext(current)){submitting=false;$('assistant-send').disabled=!enabled||switching||!settings;$('assistant-send').textContent=state?.pending?'Steer':'Send';renderNoteEditing();}}
  }
  async function attach(incoming){
    if(!enabled||switching||!incoming.length)return;const epoch=uploadEpoch,current=context();
    try{for(const file of incoming){if(!enabled||epoch!==uploadEpoch)break;if(files.length>=20)throw Error('Attach up to 20 files per question.');if(file.size>16*1024*1024)throw Error('Each attachment must be 16 MB or smaller.');status('Reading '+file.name+'…');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));if(!enabled||epoch!==uploadEpoch)break;const r=await request('AI_UPLOAD',{file:{name:file.name,mime:file.type,data:btoa(binary)},assistantId:current.assistantId});if(!enabled||epoch!==uploadEpoch){void request('AI_REMOVE_UPLOAD',{id:r.attachment.id}).catch(()=>{});break;}files.push(r.attachment);renderFiles();}if(epoch===uploadEpoch)status('Attachments ready.');}catch(e){if(epoch===uploadEpoch)status(e.message,true);}finally{if(epoch===uploadEpoch)$('assistant-upload').value='';}
  }
  async function history(){
    if(!enabled||switching||historyLoading)return;historyLoading=true;const current=context();
    try{const r=await request('AI_HISTORY',{assistantId:current.assistantId});if(!sameContext(current))return;const select=$('assistant-history');select.replaceChildren();for(const conversation of r.conversations||[]){const o=element('option',(conversation.title||'Untitled')+(conversation.pending?' · working':''));o.value=conversation.id;o.title=[conversation.noteName,conversation.project].filter(Boolean).join(' · ');select.append(o);}if(state?.id)select.value=state.id;if(!select.value){const o=element('option','Current conversation');o.value='';select.prepend(o);select.value='';}}
    catch(e){if(sameContext(current))status(e.message,true);}finally{if(sameContext(current))historyLoading=false;}
  }
  async function capabilities(){
    if(!enabled||switching||capabilitiesLoading)return;capabilitiesLoading=true;const current=context(),box=$('assistant-capabilities');box.textContent='Loading…';
    try{const r=await request('AI_CAPABILITIES',{assistantId:current.assistantId});if(!sameContext(current))return;box.replaceChildren();for(const [label,key] of [['Skills','skills'],['MCP tools','mcp'],['Apps','apps']]){box.append(element('p',label));const values=r[key]||[];if(!values.length)box.append(element('p','None configured.'));else{const list=element('ul');for(const value of values){const name=value.name||value.title||value.id||String(value),li=element('li',name);if(value.enabled!==undefined)li.append(element('small',value.enabled?'Enabled':'Disabled'));if(value.authStatus)li.append(element('small',`Authentication: ${value.authStatus}`));if(value.isAccessible!==undefined)li.append(element('small',value.isAccessible?'Accessible':'Not accessible'));if(value.description||value.status)li.append(element('small',value.description||value.status));if(value.tools?.length)li.append(element('small','Tools: '+value.tools.map(tool=>typeof tool==='string'?tool:tool.name||tool.id).join(', ')));list.append(li);}box.append(list);}}for(const warning of r.warnings||[])box.append(element('p',warning));}
    catch(e){if(sameContext(current))box.textContent=e.message;}finally{if(sameContext(current))capabilitiesLoading=false;}
  }
  function showOptions(){if(!enabled||switching)return;$('assistant-settings').hidden=!$('assistant-settings').hidden;if(!$('assistant-settings').hidden){if(!settings)void connect();void loadProjects();void history();}}
  $('assistant-close').addEventListener('click',()=>hide());$('assistant-send').addEventListener('click',()=>void submit());
  $('assistant-edit-note').addEventListener('change',async()=>{
    if(!enabled||switching)return;const current=context(),on=$('assistant-edit-note').checked;
    try{if(on){if(globalThis.NoteDesktop)await globalThis.NotepadEditor?.ensureFile();await globalThis.NotepadEditor?.flush();}if(!enabled||!sameContext(current))return;const r=await request('AI_NOTE_EDIT_SET',{enabled:on,assistantId:current.assistantId});if(sameContext(current))render(r.assistant);}catch(e){if(sameContext(current)){renderNoteEditing();status(e.message,true);}}
  });
  $('assistant-note-apply').addEventListener('click',()=>{if(enabled&&!switching&&!$('note-apply-dialog').open){$('note-apply-dialog').returnValue='cancel';$('note-apply-dialog').showModal();}});
  $('note-apply-dialog').addEventListener('close',async()=>{
    if($('note-apply-dialog').returnValue!=='apply'||!enabled||switching)return;const current=context();submitError='';status('Applying pending revision…');
    try{await globalThis.NotepadEditor?.flush();if(!enabled||!sameContext(current))return;const r=await request('AI_NOTE_APPLY',{assistantId:current.assistantId,force:true,...globalThis.NotepadEditor?.fileGuard?.()});if(!sameContext(current))return;render(r.assistant);if(r.applied){status('Pending revision applied. Undo AI edit restores your previous note.');}else if(['already_applied','unchanged'].includes(r.reason)){status('Your note already contains this revision.');}else{const reasons={disabled:'There is no pending revision to apply.',hidden:'Show the Reference panel before applying this revision.',missing_note:'The note could not be found. Reopen it and try again.',context_changed:'The active note changed. Return to the original note to apply its revision.',local_changes:'The note changed during application. Your text is kept; review and try again.',disk_changed:'The file changed again. Your draft is kept. Reload the file or review its latest revision.',formatting_conflict:'The revision could not be inserted into this formatted note. Your original text is kept.',unavailable:'The note editor did not respond. Reopen the panel and try again.'};submitError=r.error||reasons[r.reason]||'The pending revision was not applied. Your existing note is kept.';status(submitError,true);}}catch(e){if(sameContext(current)){submitError=e.message;status(e.message,true);}}
  });
  $('assistant-note-discard').addEventListener('click',async()=>{
    if(!enabled||switching)return;const current=context();try{const r=await request('AI_NOTE_DISCARD',{assistantId:current.assistantId});if(sameContext(current))render(r.assistant);}catch(e){if(sameContext(current))status(e.message,true);}
  });
  $('assistant-note-undo').addEventListener('click',async()=>{
    if(!enabled||switching||state?.pending)return;const current=context();
    try{const r=await request('AI_NOTE_EDIT_SET',{enabled:false,assistantId:current.assistantId});if(!enabled||!sameContext(current))return;render(r.assistant);await globalThis.NotepadEditor?.undoAI();renderNoteEditing();}catch(e){if(sameContext(current))status(e.message,true);}
  });
  window.addEventListener('notepad-ai-undo-changed',renderNoteEditing);
  window.addEventListener('notepad-file-state-changed',renderNoteEditing);
  $('assistant-attach').addEventListener('click',()=>{if(enabled)$('assistant-upload').click();});$('assistant-upload').addEventListener('change',()=>void attach([...$('assistant-upload').files]));
  $('assistant-options').addEventListener('click',showOptions);$('assistant-model').addEventListener('change',()=>void choose(true));$('assistant-thinking').addEventListener('change',()=>void choose(false));$('assistant-diagnostics').addEventListener('click',()=>{if(enabled)void connect(true);});
  $('assistant-stop').addEventListener('click',()=>{if(!enabled||switching)return;const current=context();submitError='';status('Stopping…');void request('AI_STOP',{assistantId:current.assistantId}).catch(e=>{if(sameContext(current))status(e.message,true);});});
  async function selectProject(path,name){
    if(!enabled||switching||state?.pending)return;const assistantId=state?.id;let epoch;
    try{await beforeNoteSwitch();epoch=contextEpoch;const r=await request('AI_PROJECT',{path,name,assistantId});if(epoch!==contextEpoch)return;contextChanged(r.assistant);if(r.projects)renderProjects(r.projects);status('Project folder selected · this note has its own conversation.');}
    catch(e){if(epoch!==undefined&&epoch!==contextEpoch)return;await cancelNoteSwitch();status(e.message,true);}
  }
  $('assistant-project-save').addEventListener('click',()=>void selectProject($('assistant-project').value.trim().replace(/^"(.*)"$/,'$1'),$('assistant-project-name').value.trim()));
  $('assistant-project-list').addEventListener('change',()=>{const project=projects.find(p=>p.id===$('assistant-project-list').value);if(project)void selectProject(project.path,project.name);});
  $('assistant-history-refresh').addEventListener('click',()=>void history());
  $('assistant-history').addEventListener('change',async()=>{if(!enabled||switching||state?.pending||!$('assistant-history').value)return;const id=$('assistant-history').value,assistantId=state?.id;let epoch;try{await globalThis.NotepadEditor?.flush?.();await beforeNoteSwitch();epoch=contextEpoch;const r=await request('AI_OPEN',{id,assistantId});if(epoch!==contextEpoch)return;if(r.note)globalThis.NotepadEditor.applyContext(r);else contextChanged(r.assistant);}catch(e){if(epoch!==undefined&&epoch!==contextEpoch)return;await cancelNoteSwitch();status(e.message,true);}});
  $('assistant-capabilities-refresh').addEventListener('click',()=>void capabilities());$('assistant-capability-details').addEventListener('toggle',()=>{if($('assistant-capability-details').open)void capabilities();});
  $('assistant-compact').addEventListener('click',async()=>{if(!enabled||switching||state?.pending)return;const current=context();try{await request('AI_COMPACT',{assistantId:current.assistantId});if(sameContext(current))status('Context compaction requested.');}catch(e){if(sameContext(current))status(e.message,true);}});
  $('assistant-review').addEventListener('click',async()=>{if(!enabled||switching||state?.pending)return;const current=context();try{const r=await request('AI_REVIEW',{assistantId:current.assistantId});if(!sameContext(current))return;render(r.assistant);if(enabled)$('assistant-settings').hidden=true;}catch(e){if(sameContext(current))status(e.message,true);}});
  $('assistant-new').addEventListener('click',async()=>{if(!enabled||switching||state?.pending)return;const assistantId=state?.id;let epoch;try{await beforeNoteSwitch();epoch=contextEpoch;const r=await request('AI_NEW',{assistantId});if(epoch===contextEpoch)contextChanged(r.assistant);}catch(e){if(epoch!==undefined&&epoch!==contextEpoch)return;await cancelNoteSwitch();status(e.message,true);}});
  $('assistant-export').addEventListener('click',async()=>{if(!enabled)return;const url=URL.createObjectURL(new Blob([NotesCore.exportText($('assistant-output').value)],{type:'text/plain;charset=utf-8'}));try{await request('DOWNLOAD_NOTE',{url,name:'Reference.txt'});}catch(e){status(e.message,true);}finally{setTimeout(()=>URL.revokeObjectURL(url),120000);}});
  question.addEventListener('input',()=>{draftClock++;clearTimeout(draftTimer);draftTimer=setTimeout(()=>void saveDraft().catch(e=>status(e.message,true)),300);});
  question.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.metaKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();void submit();}});
  panel.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();});panel.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(enabled)void attach([...e.dataTransfer.files]);});
  question.addEventListener('paste',e=>{if(enabled&&e.clipboardData.files.length){e.preventDefault();void attach([...e.clipboardData.files]);}});
  document.addEventListener('keydown',e=>{if(e.altKey&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&e.code==='KeyW'){e.preventDefault();e.stopImmediatePropagation();void restore();}},true);
  NoteConnection.onMessage((m,sender,reply)=>{
    if(m.type==='REQUEST_RESTORE'){void restore();reply({ok:true});}
    if(m.type==='AI_MODE'){if(!m.token||m.token!==restoreToken){reply({ok:false});return;}enabled=true;restoring=false;panel.hidden=false;$('error').hidden=true;question.focus();render();reply({ok:true});void connect();void loadProjects();void syncNote();}
    if(m.type==='CANCEL_RESTORE'||m.type==='COVER'){hide(false);reply({ok:true});}
    if(m.type==='AI_OPEN_OPTIONS'){showOptions();reply({ok:true});}
    if(m.type==='NOTE_CONTEXT_CHANGED'){contextChanged(m.assistant);reply({ok:true});}
    if(m.type==='AI_UPDATE'){if(!switching&&m.assistant&&(!state||state.id===m.assistant.id))render(m.assistant,m.loadDraft);reply({ok:true});}
    if(m.type==='OPTIONS')window.noteOptions=m.options;
  });
  async function init(){const epoch=contextEpoch;try{const r=await request('AI_READY');if(epoch===contextEpoch)contextChanged(r.assistant);}catch(e){if(epoch===contextEpoch)status(e.message,true);}}
  if(globalThis.notepadReady)void init();else window.addEventListener('notepad-ready',()=>void init(),{once:true});
  setInterval(()=>{if(enabled&&state?.pending)elapsed();},1000);window.addEventListener('pagehide',()=>void saveDraft().catch(()=>{}));
})();
