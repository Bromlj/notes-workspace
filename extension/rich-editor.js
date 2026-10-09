'use strict';
(() => {
  const editor=document.getElementById('editor');let savedRange=null;
  const allowed=new Set(['P','DIV','BR','B','STRONG','I','EM','U','S','STRIKE','H1','H2','H3','UL','OL','LI','A','TABLE','THEAD','TBODY','TR','TD','TH','BLOCKQUOTE','PRE','CODE']);
  function safeHTML(html){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const clean=node=>{
      if(node.nodeType===3)return document.createTextNode(node.textContent);
      if(node.nodeType!==1)return document.createDocumentFragment();
      if(['SCRIPT','STYLE','IFRAME','OBJECT','IMG','SVG','MATH'].includes(node.tagName))return document.createDocumentFragment();
      const el=allowed.has(node.tagName)?document.createElement(node.tagName):document.createDocumentFragment();
      if(node.tagName==='A'&&/^(https?:|mailto:)/i.test(node.getAttribute('href')||''))el.setAttribute('href',node.getAttribute('href'));
      for(const child of node.childNodes)el.append(clean(child));return el;
    };
    const box=document.createElement('div');for(const child of doc.body.childNodes)box.append(clean(child));return box.innerHTML;
  }
  // Use the same text projection for saving, status, find and selection. DOM
  // Range.toString() omits block line breaks and causes off-by-one selections.
  function projection(){
    let plain='';const segments=[],blocks=new Set(['DIV','P','H1','H2','H3','UL','OL','LI','TABLE','TR','BLOCKQUOTE','PRE']);
    const add=(value,node,offset=0)=>{if(value){segments.push({start:plain.length,end:plain.length+value.length,node,offset,text:node.nodeType===3});plain+=value;}};
    function walk(parent){let previousBlock=false,previousCell=false;for(let i=0;i<parent.childNodes.length;i++){
      const node=parent.childNodes[i],block=blocks.has(node.nodeName),cell=['TD','TH'].includes(node.nodeName);
      if((block||previousBlock)&&i>0&&!plain.endsWith('\n'))add('\n',parent,i);
      else if(block&&i>0&&previousBlock&&parent.childNodes[i-1].textContent==='')add('\n',parent,i);
      if(cell&&previousCell)add('\t',parent,i);
      if(node.nodeType===3)add(node.data,node);
      else if(node.nodeName==='BR'){if(parent.childNodes.length!==1||parent===editor)add('\n',parent,i+1);}
      else if(node.nodeType===1)walk(node);
      previousBlock=block;previousCell=cell;
    }}walk(editor);return {plain,segments};
  }
  function text(){return projection().plain;}
  function position(end=false){
    const sel=getSelection(),current=sel.rangeCount&&editor.contains(sel.anchorNode)?sel.getRangeAt(0):savedRange;if(!current)return 0;const node=end?current.endContainer:current.startContainer,offset=end?current.endOffset:current.startOffset;
    const p=projection();const direct=p.segments.find(s=>s.text&&s.node===node);if(direct)return direct.start+offset;
    const caret=document.createRange();caret.setStart(node,offset);caret.collapse(true);let result=0;
    for(const s of p.segments){const last=s.text?s.node.length:s.offset;if(caret.comparePoint(s.node,last)<=0)result=s.end;else break;}return result;
  }
  function rangeFor(start,end){
    const p=projection(),range=document.createRange();
    function point(offset){offset=Math.max(0,Math.min(p.plain.length,offset));const text=p.segments.find(s=>s.text&&s.start<=offset&&s.end>=offset);if(text)return [text.node,offset-text.start];const segment=p.segments.find(s=>s.end>=offset);return segment?[segment.node,segment.offset]:[editor,editor.childNodes.length];}
    range.setStart(...point(start));range.setEnd(...point(end));return range;
  }
  Object.defineProperties(editor,{
    value:{get:text,set:value=>{editor.textContent=value;savedRange=null;}},
    selectionStart:{get:()=>position()},selectionEnd:{get:()=>position(true)},
    disabled:{get:()=>editor.contentEditable!=='true',set:v=>{editor.contentEditable=String(!v);}},
    wrap:{get:()=>editor.style.whiteSpace==='pre'?'off':'soft',set:v=>{editor.style.whiteSpace=v==='off'?'pre':'pre-wrap';}}
  });
  editor.select=()=>{editor.focus();const r=document.createRange();r.selectNodeContents(editor);getSelection().removeAllRanges();getSelection().addRange(r);};
  editor.setSelectionRange=(start,end)=>{const r=rangeFor(start,end);getSelection().removeAllRanges();getSelection().addRange(r);savedRange=r.cloneRange();};
  editor.setRangeText=(t,start,end)=>{editor.setSelectionRange(start,end);document.execCommand('insertText',false,t);};
  function remember(){const s=getSelection();if(s.rangeCount&&editor.contains(s.anchorNode)){savedRange=s.getRangeAt(0).cloneRange();update();}}
  function restore(){editor.focus();if(savedRange&&editor.contains(savedRange.commonAncestorContainer)){const s=getSelection();s.removeAllRanges();s.addRange(savedRange);}}
  function update(){for(const [kind,cmd]of Object.entries({bold:'bold',italic:'italic',strike:'strikeThrough'})){document.querySelector(`[data-format="${kind}"]`)?.setAttribute('aria-pressed',String(document.queryCommandState(cmd)));}document.getElementById('text-format').textContent=editor.querySelector('b,strong,i,em,s,strike,h1,h2,h3,ul,ol,a,table')?'Formatted text':'Plain text';}
  function format(kind){
    restore();
    const simple={bold:'bold',italic:'italic',strike:'strikeThrough',bullets:'insertUnorderedList',numbered:'insertOrderedList'};
    if(simple[kind])document.execCommand(simple[kind]);
    else if(/^h[123]$/.test(kind)){const current=document.queryCommandValue('formatBlock').toLowerCase();document.execCommand('formatBlock',false,current===kind?'div':kind);}
    else if(kind==='table')document.execCommand('insertHTML',false,'<table><tbody><tr><th>Column 1</th><th>Column 2</th></tr><tr><td><br></td><td><br></td></tr></tbody></table><div><br></div>');
    else if(kind==='link'){
      const dialog=document.getElementById('link-dialog');document.getElementById('link-address').value='https://';dialog.showModal();document.getElementById('link-address').focus();return;
    }
    remember();editor.dispatchEvent(new Event('input',{bubbles:true}));update();
  }
  document.getElementById('link-dialog').addEventListener('close',()=>{
    if(document.getElementById('link-dialog').returnValue!=='save')return;const url=document.getElementById('link-address').value.trim();if(!/^(https?:\/\/|mailto:)/i.test(url))return;
    restore();if(getSelection().isCollapsed){const a=document.createElement('a');a.href=url;a.textContent=url;document.execCommand('insertHTML',false,a.outerHTML);}else document.execCommand('createLink',false,url);remember();editor.dispatchEvent(new Event('input',{bubbles:true}));
  });
  editor.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));});
  editor.addEventListener('keydown',e=>{if(e.ctrlKey&&!e.altKey&&['b','i'].includes(e.key.toLowerCase())){e.preventDefault();format(e.key.toLowerCase()==='b'?'bold':'italic');}});
  // Keep the selection when clicking a menu or toolbar, including link dialogs.
  document.querySelector('.menubar').addEventListener('pointerdown',remember);
  document.addEventListener('selectionchange',remember);editor.addEventListener('input',update);
  globalThis.RichEditor={format,restore,sanitize:safeHTML,html:()=>safeHTML(editor.innerHTML),load(html,plain){editor.innerHTML=html?safeHTML(html):'';if(!html)editor.value=plain;update();}};
})();
