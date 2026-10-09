'use strict';
// An extension page is not a content script. Use a port for worker events and
// identify its actual tab explicitly for storage and shortcut routing.
(() => {
  if (globalThis.NoteDesktop) {
    const listeners=[];
    NoteDesktop.onMessage(m=>{
      let sent=false;const reply=result=>{if(sent)return;sent=true;NoteDesktop.reply(m.requestId,result);};
      for(const listener of listeners)listener(m,{id:NoteDesktop.id},reply);
      if(!sent)reply({ok:true});
    });
    globalThis.NoteConnection={
      async request(type,data={}) {
        if(type==='DOWNLOAD_NOTE') {
          const response=await fetch(data.url),bytes=new Uint8Array(await response.arrayBuffer());
          if(bytes.length>8*1024*1024)throw Error('The export is too large.');
          data={...data,bytes:Array.from(bytes)};
        }
        const r=await NoteDesktop.request(type,data);if(!r?.ok)throw Error(r?.error||'The notepad connection was interrupted.');return r;
      },onMessage(listener){listeners.push(listener);}
    };
    return;
  }
  const listeners=[],ready=chrome.tabs.getCurrent();let port;
  const connect=async()=>{
    const tab=await ready;port=chrome.runtime.connect({name:'editor'});port.postMessage({hello:tab.id});
    port.onMessage.addListener(m=>{let sent=false;const reply=result=>{if(sent)return;sent=true;port.postMessage({replyTo:m.requestId,result});};for(const listener of listeners)listener(m,{id:chrome.runtime.id},reply);if(!sent)reply({ok:true});});
    port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;setTimeout(()=>void connect().catch(()=>{}),1000);});
  };
  const connected=connect();
  setInterval(()=>{try{port?.postMessage({heartbeat:true})}catch{}},20000);
  globalThis.NoteConnection={
    async request(type,data={}){await connected;const tab=await ready;const r=await chrome.runtime.sendMessage({type,...data,tabId:tab.id});if(!r?.ok)throw Error(r?.error||'The notepad connection was interrupted.');return r;},
    onMessage(listener){listeners.push(listener);}
  };
})();
