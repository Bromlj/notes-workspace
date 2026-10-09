'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),destination=path.join(__dirname,'dist','Notes Workspace');
const copy=(a,b)=>{fs.mkdirSync(path.dirname(b),{recursive:true});fs.cpSync(a,b,{recursive:true,force:true});};
// All inputs are explicit application files. Never recurse over the developer's
// workspace or include local profiles, connection tokens or saved user data.
const safeDist=path.resolve(__dirname,'dist')+path.sep;
if(!path.resolve(destination).startsWith(safeDist)||path.basename(destination)!=='Notes Workspace')throw Error('Unexpected build destination.');
if(fs.existsSync(destination))fs.rmSync(destination,{recursive:true,force:true});
fs.mkdirSync(destination,{recursive:true});
copy(path.join(__dirname,'node_modules','electron','dist'),destination);
fs.renameSync(path.join(destination,'electron.exe'),path.join(destination,'Notes Workspace.exe'));
// Preserve the vendor executable byte for byte. Windows blocked a launcher
// with edited resources on the verification machine. The window, taskbar and
// desktop shortcut use our notepad icon through the normal application APIs.
const application=path.join(destination,'resources','app');fs.mkdirSync(application,{recursive:true});
fs.writeFileSync(path.join(application,'package.json'),JSON.stringify({name:'notes-workspace',productName:'Notes Workspace',version:'5.1.1',main:'main.cjs',private:true}));
for(const file of ['main.cjs','preload.cjs','worker-runtime.cjs','codex-service.cjs','backup.cjs'])copy(path.join(__dirname,file),path.join(application,file));
const ui=path.join(application,'ui');
for(const file of ['core.js','worker.js','client.js','rich-editor.js','editor.js','assistant.js','editor.html','editor.css','options.html','options.css','options.js'])copy(path.join(root,'extension',file),path.join(ui,file));
copy(path.join(root,'extension','icons'),path.join(ui,'icons'));
fs.writeFileSync(path.join(ui,'core.js'),fs.readFileSync(path.join(ui,'core.js'),'utf8').replace("const VERSION = '4.1.0'","const VERSION = '5.1.1'"));
for(const file of ['desktop-ui.js','onboarding.html','onboarding.js','onboarding.css'])copy(path.join(__dirname,file),path.join(ui,file));
for(const name of ['editor.html','options.html']){
  const target=path.join(ui,name);let text=fs.readFileSync(target,'utf8').replaceAll('4.1.0','5.1.1');
  text=text.replace('</body>','<script src="desktop-ui.js"></script></body>');
  if(name==='options.html')text=text.replace('Use the Notes Workspace desktop shortcut to start the local connector and open the notepad. Codex must be installed and signed in with ChatGPT.','Open Notes Workspace.exe or the desktop shortcut. The official Codex runtime is included. Use Account to sign in with your own ChatGPT account.').replace('browser/app has focus','program has focus').replace("this extension's existing browser profile","this program's local data folder").replace('installed Codex agent runtime','bundled official Codex agent runtime');
  fs.writeFileSync(target,text);
}
const native=path.join(destination,'resources','native');copy(path.join(root,'native','host.cjs'),path.join(native,'host.cjs'));copy(path.join(root,'native','node_modules'),path.join(native,'node_modules'));
copy(path.join(__dirname,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc'),path.join(destination,'resources','codex'));
for(const file of ['Install.cmd','Install.ps1','START HERE.txt','SHARE WITH FRIENDS.txt'])copy(path.join(__dirname,file),path.join(destination,file));
copy(path.join(root,'LICENSE.txt'),path.join(destination,'LICENSE.txt'));copy(path.join(__dirname,'licenses'),path.join(destination,'licenses'));
if(fs.existsSync(path.join(__dirname,'TEST_REPORT.md')))copy(path.join(__dirname,'TEST_REPORT.md'),path.join(destination,'TEST_REPORT.md'));
const files=[];function inventory(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())inventory(p);else files.push(path.relative(destination,p));}}inventory(destination);
for(const file of files)if(/(^|[\\/])(auth\.json|connection\.json|notes\.json|Cookies|Local State|\.codex|DesktopData|codex-home)([\\/]|$)/i.test(file))throw Error('Private data in package: '+file);
console.log(JSON.stringify({destination,files:files.length,bytes:files.reduce((n,file)=>n+fs.statSync(path.join(destination,file)).size,0),version:'5.1.1'}));
