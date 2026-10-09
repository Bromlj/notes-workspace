'use strict';
const $ = id => document.getElementById(id);
if(!globalThis.NoteDesktop){
  const section=document.createElement('section');section.innerHTML='<h2>Move to the desktop program</h2><p>Export your saved notes and conversations, then import the file in the desktop program’s settings.</p><button id="export-desktop-backup">Export backup…</button><p id="export-desktop-status" role="status"></p>';
  document.querySelector('main footer').before(section);
  $('export-desktop-backup').onclick=async()=>{try{const {backup}=await request('EXPORT_BACKUP'),url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='Notes Workspace backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),120000);$('export-desktop-status').textContent='Backup requested. This file contains private notes and conversations.';}catch(e){$('export-desktop-status').textContent=e.message;}};
}
async function request(type, extra = {}) {
  const result = globalThis.NoteDesktop ? await NoteDesktop.request(type,extra) : await chrome.runtime.sendMessage({type, ...extra});
  if (!result?.ok) throw new Error(result?.error || 'The operation failed.');
  return result;
}
async function refresh() {
  const result = await request('GET_SETTINGS');
  for (const [key, value] of Object.entries(result.options)) $(key).checked = value;
  $('current-row').hidden = !result.hasPassphrase;
  $('remove-passphrase').hidden = !result.hasPassphrase;
  $('save-passphrase').textContent = result.hasPassphrase ? 'Change passphrase' : 'Set passphrase';
  const labels = {'privacy-now': 'Hide and disable all AI panels', 'resume-workspace': 'Open the AI panel in this notepad', 'toggle-paper': 'Open panel connection options', 'open-settings': 'Open these settings'};
  const list = $('shortcuts'); list.replaceChildren();
  const missing = [];
  for (const [name, label] of Object.entries(labels)) {
    const command = result.commands.find(c => c.name === name);
    const row = document.createElement('div'); row.className = 'shortcut';
    const text = document.createElement('span'); text.textContent = label;
    const key = document.createElement('kbd'); key.textContent = command?.shortcut || 'NOT ASSIGNED';
    row.append(text, key); list.append(row);
    if (!command?.shortcut) missing.push(label);
  }
  $('shortcut-warning').hidden = missing.length === 0;
  $('shortcut-warning').textContent = 'Assign the missing shortcuts before relying on the cover. Another extension or browser command may already use them.';
}
$('preferences').addEventListener('submit', async event => {
  event.preventDefault();
  try { await request('SAVE_SETTINGS', {options: {hideOnBlur: $('hideOnBlur').checked}}); $('preference-status').textContent = 'Saved.'; }
  catch (e) { $('preference-status').textContent = e.message; }
});
$('passphrase-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-passphrase').disabled = true;
  try {
    if ($('new-password').value !== $('repeat-password').value) throw new Error('The new passphrases do not match.');
    await request('SET_PASSPHRASE', {currentPassword: $('current-password').value, newPassword: $('new-password').value});
    $('passphrase-status').textContent = 'Passphrase set. It will be required the next time you restore a covered workspace.';
    for (const id of ['current-password', 'new-password', 'repeat-password']) $(id).value = '';
    await refresh();
  } catch (e) { $('passphrase-status').textContent = e.message; }
  finally { $('save-passphrase').disabled = false; }
});
$('remove-passphrase').addEventListener('click', async () => {
  try {
    await request('REMOVE_PASSPHRASE', {currentPassword: $('current-password').value});
    $('passphrase-status').textContent = 'Restore passphrase removed.'; $('current-password').value = ''; await refresh();
  } catch (e) { $('passphrase-status').textContent = e.message; }
});
$('edit-shortcuts').addEventListener('click', () => void request('OPEN_SHORTCUTS').catch(e => { $('shortcut-warning').textContent = e.message; $('shortcut-warning').hidden = false; }));
$('launch').addEventListener('click', async () => {
  try { await request('LAUNCH'); } catch (e) { $('launch').textContent = e.message; }
});
window.addEventListener('focus', () => { void refresh().catch(() => undefined); });
void refresh().catch(e => { $('shortcut-warning').hidden = false; $('shortcut-warning').textContent = e.message; });
