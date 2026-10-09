'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');
test('default preferences are safe and do not hide on focus loss', () => {
  assert.deepEqual(C.options(null), {hideOnBlur: false});
});
test('preference coercion rejects non-booleans and unknown fields', () => {
  assert.deepEqual(C.options({paper: false, hideOnBlur: 'yes', blockNotifications: 0, fake: true}), {hideOnBlur:false});
});
for (const [input, expected] of [['../my/file','.._my_file'],['CON','_CON'],['con.txt','_con.txt'],['LPT9','_LPT9'],['notes. ','notes'],['','Untitled'],[' A:B*? ','A_B__']]) {
  test(`safe filename: ${JSON.stringify(input)}`,()=>assert.equal(C.filename(input),expected));
}
test('downloads are text files, including executable-looking names',()=>assert.equal(C.filename('test.exe',true),'test.exe.txt'));
test('existing .TXT suffix is retained',()=>assert.equal(C.filename('test.TXT',true),'test.TXT'));
test('filenames have bounded length',()=>assert.equal(C.filename('x'.repeat(500)).length,120));
test('note normalisation constrains values',()=>assert.deepEqual(C.note({fontSize:100, revision:-1, text:3, wrap:false},'abc'),{html:'',id:'abc',name:'Untitled',text:'',wrap:false,fontSize:28,revision:0,updatedAt:0}));
for (const [text,pos,line,column] of [['',0,1,1],['ab',2,1,3],['a\nbc',3,2,2],['a\n',2,2,1]]) {
  test(`line/column for ${JSON.stringify(text)} offset ${pos}`,()=>assert.deepEqual(C.lineCol(text,pos),{line,column}));
}
test('find is case-insensitive and wraps forward',()=>{assert.equal(C.find('One two ONE','one',5),8);assert.equal(C.find('One two ONE','one',11),0)});
test('find respects case',()=>assert.equal(C.find('One one','one',0,false,true),4));
test('backwards find wraps from the first character',()=>assert.equal(C.find('a x a','a',0,true),4));
test('find treats punctuation literally',()=>assert.equal(C.find('a.*b','.*'),1));
test('empty search is rejected',()=>assert.equal(C.find('abc',''),-1));
test('UTF-8 normalises newlines',()=>assert.equal(C.decodeText(new TextEncoder().encode('α\r\nb\rc')),'α\nb\nc'));
test('UTF-16 LE BOM works',()=>assert.equal(C.decodeText(Uint8Array.from([255,254,65,0,10,0,66,0])),'A\nB'));
test('UTF-16 BE BOM works',()=>assert.equal(C.decodeText(Uint8Array.from([254,255,0,65,0,66])),'AB'));
test('binary input is rejected',()=>assert.throws(()=>C.decodeText(new Uint8Array([65,0,66])),/binary/));
test('invalid UTF-8 is rejected',()=>assert.throws(()=>C.decodeText(new Uint8Array([255,255])),/UTF/));
test('oversized files are rejected before decoding',()=>assert.throws(()=>C.decodeText(new Uint8Array(C.MAX_TEXT_BYTES+1)),/2 MB/));
test('export consistently uses CRLF',()=>assert.equal(C.exportText('a\r\nb\rc\nd'),'a\r\nb\r\nc\r\nd'));
for (const url of ['https://chatgpt.com/','https://chatgpt.com/c/test']) test(`allowed origin ${url}`,()=>assert.equal(C.isChatUrl(url),true));
for (const url of ['http://chatgpt.com/','https://chatgpt.com.evil.test/','https://evil.test/?chatgpt.com','not-a-url']) test(`reject origin ${url}`,()=>assert.equal(C.isChatUrl(url),false));
