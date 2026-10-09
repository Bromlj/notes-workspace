'use strict';
(() => {
  const $=id=>document.getElementById(id);
  if(location.pathname==='/editor.html') {
    const buttons=document.createElement('div');buttons.className='assistant-actions';
    for(const [label,type]of [['Browse folder…','DESKTOP_CHOOSE_PROJECT'],['Account…','DESKTOP_OPEN_ACCOUNT']]) {
      const button=document.createElement('button');button.type='button';button.textContent=label;
      button.addEventListener('click',async()=>{try{const r=await NoteDesktop.request(type);if(!r.ok)throw Error(r.error);if(r.path)$('assistant-project').value=r.path;}catch(e){$('assistant-status').textContent=e.message;}});buttons.append(button);
    }
    $('assistant-project-save').parentElement.after(buttons);
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
