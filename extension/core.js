/* Notes Workspace — local helpers, shared by the extension and its tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotesCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '4.1.0';
  const MAX_TEXT_BYTES = 2 * 1024 * 1024;
  const DEFAULT_OPTIONS = Object.freeze({hideOnBlur: false});
  function options(value) {
    const v = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([k, fallback]) => [k, typeof v[k] === 'boolean' ? v[k] : fallback]));
  }
  function filename(value, forDownload = false) {
    let name = String(value || 'Untitled').replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 120) || 'Untitled';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    if (forDownload && !/\.txt$/i.test(name)) name += '.txt';
    return name;
  }
  function note(value, id) {
    const v = value && typeof value === 'object' ? value : {};
    return {html:typeof v.html==='string'?v.html:'',id: String(id || v.id || ''), name: filename(v.name), text: typeof v.text === 'string' ? v.text : '',
      wrap: v.wrap !== false, fontSize: Math.min(28, Math.max(11, Number(v.fontSize) || 15)),
      revision: Math.max(0, Number.isSafeInteger(v.revision) ? v.revision : 0), updatedAt: Number(v.updatedAt) || 0};
  }
  function lineCol(text, offset) {
    const prefix = String(text).slice(0, Math.max(0, offset));
    const lastNewline = prefix.lastIndexOf('\n');
    return {line: 1 + (prefix.match(/\n/g) || []).length, column: prefix.length - lastNewline};
  }
  function find(text, query, from = 0, backwards = false, caseSensitive = false) {
    if (!query) return -1;
    const haystack = caseSensitive ? text : text.toLocaleLowerCase();
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    if (backwards) {
      const index = from <= 0 ? -1 : haystack.lastIndexOf(needle, from - 1);
      return index < 0 ? haystack.lastIndexOf(needle) : index;
    }
    const index = haystack.indexOf(needle, from);
    return index < 0 ? haystack.indexOf(needle) : index;
  }
  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error('This editor opens text files up to 2 MB.');
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    let text;
    try { text = new TextDecoder(encoding, {fatal: true}).decode(bytes); }
    catch { throw new Error('This is not a supported UTF-8 or UTF-16 text file.'); }
    if (text.includes('\u0000')) throw new Error('This looks like a binary file, not a text document.');
    return text.replace(/\r\n?/g, '\n');
  }
  function exportText(text) { return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'); }
  function isChatUrl(url) { try { return new URL(url).origin === 'https://chatgpt.com'; } catch { return false; } }
  return Object.freeze({VERSION, MAX_TEXT_BYTES, DEFAULT_OPTIONS, options, filename, note, lineCol, find, decodeText, exportText, isChatUrl});
});
