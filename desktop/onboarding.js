'use strict';
const $=id=>document.getElementById(id);
let busy=false,poll=null,sandboxPoll=null,sandboxBusy=false;
async function request(type){const result=await NoteDesktop.request(type);if(!result?.ok)throw Error(result?.error||'The account operation failed.');return result;}
function message(text,error=false){$('account-status').textContent=text;$('account-status').classList.toggle('error',error);}
function controls(status){
  $('account-login').hidden=status.signedIn||status.loginPending;
  $('account-login').disabled=busy||!status.available;
  $('account-cancel').hidden=!status.loginPending;
  $('account-cancel').disabled=busy;
  $('account-logout').hidden=!status.signedIn;
  $('account-logout').disabled=busy;
  $('account-refresh').disabled=busy;
  clearTimeout(poll);poll=null;
  if(status.loginPending)poll=setTimeout(()=>void refresh(),2000);
}
async function refreshSandbox(){
  if(sandboxBusy)return;
  try{
    const status=await request('DESKTOP_SANDBOX_STATUS');
    clearTimeout(sandboxPoll);sandboxPoll=null;
    $('sandbox-setup').hidden=status.status==='ready'||status.pending;
    $('sandbox-setup').disabled=status.pending;
    $('sandbox-refresh').disabled=status.pending;
    $('sandbox-status').classList.toggle('error',!!status.error);
    $('sandbox-status').textContent=status.pending?'Complete the official Windows setup prompt, then return here.':status.error||({ready:'Windows sandbox is ready for project commands.',notConfigured:'First-time Windows sandbox setup is needed for project commands.',updateRequired:'The Windows sandbox needs an update.'}[status.status]||'Windows sandbox status is unavailable.');
    if(status.pending)sandboxPoll=setTimeout(()=>void refreshSandbox(),2000);
  }catch(error){$('sandbox-status').textContent=error.message;$('sandbox-status').classList.add('error');}
}
async function setupSandbox(){
  if(sandboxBusy)return;sandboxBusy=true;$('sandbox-setup').disabled=$('sandbox-refresh').disabled=true;
  try{await request('DESKTOP_SANDBOX_SETUP');}
  catch(error){$('sandbox-status').textContent=error.message;$('sandbox-status').classList.add('error');return;}
  finally{sandboxBusy=false;$('sandbox-setup').disabled=$('sandbox-refresh').disabled=false;}
  await refreshSandbox();
}
async function refresh(){
  if(busy)return;
  try{
    const status=await request('DESKTOP_ACCOUNT_STATUS');controls(status);
    if(!status.available)message(status.error||'The included Codex runtime could not start. Extract the complete app package again.',true);
    else if(status.signedIn)message('Signed in with ChatGPT'+(status.planType?' · '+status.planType:'')+'. You can return to the notepad.');
    else if(status.loginPending)message('Finish signing in on the official page in your browser, then return here.');
    else if(status.error)message(status.error,true);
    else if(status.accountType)message('Codex is using a different sign-in method. Sign in with ChatGPT to use your plan allowance.',true);
    else message('Not signed in. Choose Sign in with ChatGPT to connect your own account.');
  }catch(error){message(error.message,true);}
}
async function action(type){
  if(busy)return;busy=true;$('account-login').disabled=$('account-cancel').disabled=$('account-logout').disabled=$('account-refresh').disabled=true;
  try{await request(type);}catch(error){message(error.message,true);busy=false;return;}
  finally{busy=false;$('account-login').disabled=$('account-cancel').disabled=$('account-logout').disabled=$('account-refresh').disabled=false;}
  await refresh();
}
$('account-login').addEventListener('click',()=>void action('DESKTOP_ACCOUNT_LOGIN'));
$('account-cancel').addEventListener('click',()=>void action('DESKTOP_ACCOUNT_CANCEL'));
$('account-logout').addEventListener('click',()=>void action('DESKTOP_ACCOUNT_LOGOUT'));
$('account-refresh').addEventListener('click',()=>void refresh());
$('sandbox-setup').addEventListener('click',()=>void setupSandbox());
$('sandbox-refresh').addEventListener('click',()=>void refreshSandbox());
window.addEventListener('focus',()=>{void refresh();void refreshSandbox();});
window.addEventListener('pagehide',()=>{clearTimeout(poll);clearTimeout(sandboxPoll);});
void refresh();
void refreshSandbox();
