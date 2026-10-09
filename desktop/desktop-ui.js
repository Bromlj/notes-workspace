'use strict';
(() => {
  const $=id=>document.getElementById(id);
  if(location.pathname==='/editor.html') {
    const browse=$('assistant-project-browse');browse.hidden=false;browse.textContent='Browse folder…';
    browse.addEventListener('click',async()=>{if(!NotepadAssistant.visible())return;try{const r=await NoteDesktop.request('DESKTOP_CHOOSE_PROJECT');if(!r.ok)throw Error(r.error);if(r.path&&NotepadAssistant.visible())await NotepadAssistant.chooseProject(r.path);}catch(e){$('assistant-status').textContent=e.message;}});
    const buttons=document.createElement('div');buttons.className='assistant-actions';const account=document.createElement('button');account.type='button';account.id='assistant-account';account.textContent='Account…';account.addEventListener('click',async()=>{try{const r=await NoteDesktop.request('DESKTOP_OPEN_ACCOUNT');if(!r.ok)throw Error(r.error);}catch(e){$('assistant-status').textContent=e.message;}});buttons.append(account);$('assistant-diagnostics').after(buttons);
    document.querySelectorAll('.desktop-file-action').forEach(button=>button.hidden=false);
    const save=document.querySelector('[data-action="save"]');save.firstChild.textContent='Save';
    $('save-dialog').querySelector('.hint').textContent='Choose a location in the Windows Save As dialog. Text exports omit formatting.';
    $('recent-dialog').querySelector('.hint').textContent='Saved locally by Notes Workspace on this computer.';
  }
  if(location.pathname==='/options.html') {
    $('edit-shortcuts').textContent='Show desktop shortcuts';
    const section=document.createElement('section');section.innerHTML='<h2>Desktop program</h2><p>Account sign-in, local backups and desktop shortcut.</p><div class="buttons"><button id="desktop-account">Account…</button><button id="desktop-shortcut">Create desktop shortcut</button><button id="desktop-export">Export backup…</button><button id="desktop-import">Import backup…</button></div><p id="desktop-status" role="status"></p>';
    document.querySelector('main footer').before(section);
    for(const [id,type]of [['desktop-account','DESKTOP_OPEN_ACCOUNT'],['desktop-shortcut','DESKTOP_CREATE_SHORTCUT'],['desktop-export','DESKTOP_EXPORT'],['desktop-import','DESKTOP_IMPORT']])$(id).onclick=async()=>{try{const r=await NoteDesktop.request(type);if(!r.ok)throw Error(r.error);$('desktop-status').textContent=r.message||'Done.';}catch(e){$('desktop-status').textContent=e.message;}};
  }
})();
