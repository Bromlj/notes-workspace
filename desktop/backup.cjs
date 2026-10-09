'use strict';
const path = require('node:path');
const C = (() => { try { return require('./ui/core.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return require('../extension/core.js'); } })();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 128 * 1024 * 1024;
const IMPORT_MESSAGE = 'This conversation was imported from a backup. No unfinished request was resent.';
const own = (value, key) => Object.hasOwn(value, key);
function invalid(label) { throw Error('Invalid notepad backup: ' + label + '.'); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label); return value; }
function string(value, label, maximum, empty = true) { if (typeof value !== 'string' || value.length > maximum || (!empty && !value)) invalid(label); return value; }
function uuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) invalid(label); return value; }
function number(value, label, fallback = 0) { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(label); return value; }
function integer(value, label) { if (!Number.isSafeInteger(value) || value < 0) invalid(label); return value; }
function noteText(value, label) { string(value, label, C.MAX_TEXT_BYTES); if (Buffer.byteLength(value, 'utf8') > C.MAX_TEXT_BYTES) invalid(label + ' is too large'); return value; }
function array(value, label, maximum) { if (!Array.isArray(value) || value.length > maximum) invalid(label); return value; }
function json(value, maximum = MAX_BYTES) {
  let text; try { text = JSON.stringify(value); } catch { invalid('data cannot be serialized'); }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > maximum) invalid('data is too large');
  return JSON.parse(text);
}
function folder(value, label) {
  string(value, label, 32767, false);
  if (!path.win32.isAbsolute(value) || value.includes('\0')) invalid(label + ' must be an absolute Windows folder');
  return value;
}
function projectKey(value) { return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase(); }
function project(value) {
  object(value, 'project');
  return { id: uuid(value.id, 'project identifier'), path: folder(value.path, 'project path'), name: string(value.name, 'project name', 100, false), updatedAt: number(value.updatedAt, 'project timestamp') };
}
function plan(value) {
  return array(value, 'plan', 1000).map(item => {
    object(item, 'plan step'); const out = {};
    for (const key of ['step', 'text', 'status']) if (own(item, key)) out[key] = string(item[key], 'plan ' + key, 100000);
    return out;
  });
}
function activity(value) {
  return array(value, 'activity', 200).map(item => {
    object(item, 'activity item'); const out = {};
    for (const key of ['id', 'type', 'status', 'cwd', 'name']) if (own(item, key) && item[key] != null) out[key] = string(item[key], 'activity ' + key, 32767);
    if (own(item, 'command') && item.command != null) out.command = Array.isArray(item.command) ? array(item.command, 'command arguments', 10000).map(arg => string(arg, 'command argument', 100000)) : string(item.command, 'command', 500000);
    for (const key of ['output', 'summary']) if (own(item, key) && item[key] != null) out[key] = json(item[key], 2 * 1024 * 1024);
    if (own(item, 'exitCode') && item.exitCode != null) { if (!Number.isSafeInteger(item.exitCode)) invalid('command exit code'); out.exitCode = item.exitCode; }
    if (own(item, 'changes') && item.changes != null) out.changes = array(item.changes, 'file changes', 10000).map(change => {
      object(change, 'file change'); const clean = {};
      for (const key of ['path', 'file', 'diff']) if (own(change, key) && change[key] != null) clean[key] = string(change[key], 'file change ' + key, key === 'diff' ? 1000000 : 32767);
      if (own(change, 'kind')) clean.kind = typeof change.kind === 'string' ? string(change.kind, 'change kind', 100) : json(object(change.kind, 'change kind'), 4096);
      return clean;
    });
    return out;
  });
}
function noteEditStage(value, importing) {
  object(value, 'pending note revision');
  const out = { requestId:uuid(value.requestId, 'note revision request identifier'), text:noteText(value.text, 'AI note text'), sequence:integer(value.sequence, 'AI note sequence'), baseRevision:integer(value.baseRevision, 'AI note base revision'), baseText:noteText(value.baseText, 'AI note base text'), baseHtml:string(value.baseHtml, 'AI note base formatting', C.MAX_TEXT_BYTES), conflict:false };
  for (const key of ['conflict','requiresApply']) if (own(value,key) && typeof value[key] !== 'boolean') invalid('AI note ' + key);
  out.conflict = value.conflict === true;
  if (own(value,'appliedRevision') && value.appliedRevision != null) out.appliedRevision = integer(value.appliedRevision, 'applied AI note revision');
  if (out.appliedRevision == null && (importing || value.requiresApply === true)) { out.conflict=true; out.requiresApply=true; }
  return out;
}
function assistant(value, id, importing) {
  object(value, 'conversation');
  if (own(value, 'id') && value.id !== id) invalid('conversation identifier does not match its key');
  const out = { id, agentVersion: value.agentVersion ?? 3, messages: array(value.messages, 'conversation messages', 10000).map(message => {
    object(message, 'conversation message'); if (!['user', 'assistant'].includes(message.role)) invalid('message role');
    return { role: message.role, text: string(message.text, 'message text', 500000) };
  }), draft: own(value, 'draft') ? string(value.draft, 'conversation draft', C.MAX_TEXT_BYTES) : '', pending: null, error: own(value, 'error') ? string(value.error, 'conversation error', 100000) : '', updatedAt: number(value.updatedAt, 'conversation timestamp') };
  if (!Number.isSafeInteger(out.agentVersion) || out.agentVersion < 0 || out.agentVersion > 5) invalid('conversation version');
  if (own(value, 'noteId') && value.noteId != null) out.noteId = uuid(value.noteId, 'conversation note identifier');
  if (own(value, 'project') && value.project) out.project = folder(value.project, 'conversation project');
  if (own(value, 'threadId') && value.threadId != null) out.threadId = string(value.threadId, 'Codex thread identifier', 200, false);
  if (own(value,'editNote') && typeof value.editNote !== 'boolean') invalid('note editing permission');
  // A backup carries the revision preview, never an opt-in to edit the note on
  // a different installation. Existing local permissions survive a merge.
  out.editNote = !importing && value.editNote === true;
  if (value.noteEditStage != null) out.noteEditStage = noteEditStage(value.noteEditStage, importing);
  else if (own(value,'noteEditStage')) out.noteEditStage = null;
  const preserveWork = source => {
    if (own(source, 'activity')) out.activity = activity(source.activity);
    if (own(source, 'diff')) out.diff = string(source.diff, 'conversation diff', 1000000);
    if (own(source, 'plan')) out.plan = plan(source.plan);
  };
  preserveWork(value);
  if (value.pending != null) {
    object(value.pending, 'unfinished conversation');
    if (own(value.pending, 'text')) { const text = string(value.pending.text, 'unfinished reply', 500000); if (text) out.messages.push({ role: 'assistant', text }); }
    preserveWork(value.pending);
    out.error = [out.error, IMPORT_MESSAGE].filter(Boolean).join('\n');
  }
  return out;
}
function accessLock(value) {
  object(value, 'restore passphrase');
  const out = {};
  for (const [key, length] of [['salt', 16], ['hash', 32]]) {
    const encoded = string(value[key], 'restore passphrase ' + key, 100, false);
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== length || decoded.toString('base64') !== encoded) invalid('restore passphrase ' + key);
    out[key] = encoded;
  }
  if (own(value, 'iterations') && value.iterations !== 310000) invalid('restore passphrase iteration count');
  return out;
}
function sanitizeState(input, importing) {
  object(input, 'root');
  // Validate the envelope's resource limit before copying any allowed fields.
  json(input);
  const output = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('note:')) {
      const id = uuid(key.slice(5), 'note key'); object(value, 'note');
      if (own(value, 'id') && value.id !== id) invalid('note identifier does not match its key');
      string(value.text, 'note text', C.MAX_TEXT_BYTES);
      if (Buffer.byteLength(value.text, 'utf8') > C.MAX_TEXT_BYTES) invalid('note text is too large');
      if (own(value, 'html')) string(value.html, 'formatted note', C.MAX_TEXT_BYTES);
      if (own(value, 'name')) string(value.name, 'note name', 1000);
      if (own(value, 'wrap') && typeof value.wrap !== 'boolean') invalid('note word wrap');
      if (own(value, 'fontSize') && (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize))) invalid('note font size');
      if (own(value, 'revision') && (!Number.isSafeInteger(value.revision) || value.revision < 0)) invalid('note revision');
      number(value.updatedAt, 'note timestamp'); output[key] = C.note(value, id);
    } else if (key.startsWith('assistant:')) output[key] = assistant(value, uuid(key.slice(10), 'conversation key'), importing);
    else if (key.startsWith('noteAssistant:')) { uuid(key.slice(14), 'note-conversation key'); output[key] = uuid(value, 'note-conversation identifier'); }
    else if (['lastNoteId', 'lastAssistantId'].includes(key)) output[key] = value == null ? null : uuid(value, key);
    else if (key === 'projects') output.projects = array(value, 'projects', 10000).map(project);
    else if (key === 'options') { object(value, 'options'); if (own(value, 'hideOnBlur') && typeof value.hideOnBlur !== 'boolean') invalid('hide-on-blur preference'); output.options = C.options(value); }
    else if (key === 'codexSelection') {
      object(value, 'model selection');
      output.codexSelection = { model: string(value.model, 'selected model', 200, false), effort: string(value.effort, 'selected thinking level', 40, false) };
      if (!/^[a-z0-9_-]+$/i.test(value.effort)) invalid('selected thinking level');
    } else if (key === 'accessLock') output.accessLock = accessLock(value);
  }
  return json(output);
}
function sanitizeBackup(input) { return sanitizeState(input, true); }
function mergeBackup(imported, current) {
  const incoming = sanitizeBackup(imported), existing = sanitizeState(current, false);
  const merged = { ...incoming, ...existing };
  const projects = new Map();
  for (const item of [...(incoming.projects || []), ...(existing.projects || [])]) projects.set(projectKey(item.path), item);
  merged.projects = [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const meaningful = Object.entries(existing).some(([key, value]) => key.startsWith('note:') && (value.text.trim() || value.html.replace(/<[^>]*>/g, '').trim() || value.name !== 'Untitled'));
  if (!meaningful && incoming.lastNoteId && own(merged, 'note:' + incoming.lastNoteId)) {
    merged.lastNoteId = incoming.lastNoteId;
    const assistantId = merged['noteAssistant:' + incoming.lastNoteId] || incoming.lastAssistantId;
    if (assistantId && own(merged, 'assistant:' + assistantId)) merged.lastAssistantId = assistantId;
  }
  return json(merged);
}
module.exports = { sanitizeBackup, mergeBackup };
