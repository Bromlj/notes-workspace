'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const ID='mpjgdedegfkfcpdfhdldkmdkaejjhnce';
const listeners=new Set();
let connected;
const isEditor=location.pathname==='/editor.html';
const connect=()=>connected ||= (isEditor?ipcRenderer.invoke('notes:connect'):Promise.resolve());
ipcRenderer.on('notes:event',(_event,message)=>{for(const listener of listeners)listener(message);});
const request=async(type,data={})=>{await connect();return ipcRenderer.invoke('notes:request',{type,data});};
contextBridge.exposeInMainWorld('NoteDesktop',Object.freeze({
  id:ID,
  request,
  onMessage(listener){if(typeof listener==='function')listeners.add(listener);},
  reply(requestId,result){ipcRenderer.send('notes:reply',{replyTo:requestId,result});}
}));
