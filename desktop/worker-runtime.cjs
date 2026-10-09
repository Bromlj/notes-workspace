'use strict';
// The shipped worker remains the sole owner of note, conversation and privacy
// state. This adapter supplies its small Chrome API surface inside the desktop
// main process; no filesystem or process APIs are exposed to page JavaScript.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const ID = 'mpjgdedegfkfcpdfhdldkmdkaejjhnce';
const ORIGIN = 'notes://app';
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const RENAME_RETRY_DELAYS = Object.freeze([50,100,200,400,800]);
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM','EACCES','EBUSY']);
const waitForRetry = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
const COMMANDS = Object.freeze([
  { name: 'privacy-now', shortcut: 'Alt+Q' },
  { name: 'resume-workspace', shortcut: 'Alt+W' },
  { name: 'toggle-paper', shortcut: 'Alt+M' },
  { name: 'open-settings', shortcut: 'Alt+Shift+S' }
]);

function clone(value, limit = MAX_MESSAGE_BYTES) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > limit) throw Error('The local data exceeds its size limit.');
  return JSON.parse(text);
}

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { if (typeof listener !== 'function') throw Error('Invalid event listener.'); listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    emit(...args) { return [...listeners].map(listener => listener(...args)); },
    clear() { listeners.clear(); }
  };
}

function createRuntime({ uiRoot, dataFile, native, windows, storageIO=fs.promises, retryWait=waitForRetry }) {
  if (typeof native !== 'function' || !windows || !uiRoot || !dataFile) throw Error('Invalid desktop worker configuration.');
  for (const method of ['get', 'list', 'create', 'update', 'remove', 'openSettings', 'save']) {
    if (typeof windows[method] !== 'function') throw Error('Missing desktop window adapter: ' + method);
  }
  const root = path.resolve(uiRoot), storePath = path.resolve(dataFile);
  let closed = false, persistent = {}, session = {}, writeQueue = Promise.resolve();
  const timers = new Map(), ports = new Map(), caller = new AsyncLocalStorage();
  const onMessage = event(), onConnect = event(), onStartup = event(), onInstalled = event();
  const onCommand = event(), onClicked = event(), onRemoved = event();
  if (fs.existsSync(storePath)) {
    if (fs.statSync(storePath).size > MAX_STORE_BYTES) throw Error('The saved notepad data is too large to open safely.');
    const value = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('The saved notepad data is invalid.');
    persistent = value;
  }

  const assertOpen = () => { if (closed) throw Error('The notepad has closed.'); };
  const persist = () => {
    const text = JSON.stringify(persistent);
    if (Buffer.byteLength(text, 'utf8') > MAX_STORE_BYTES) throw Error('Local recovery storage is full. Export important notes before continuing.');
    // Serialize complete snapshots and replace the file atomically. An interrupted
    // write leaves the previous valid snapshot available at the canonical path.
    const task = writeQueue.catch(() => undefined).then(async () => {
      await storageIO.mkdir(path.dirname(storePath), { recursive: true });
      const temporary = storePath + '.tmp';
      try {
        const handle = await storageIO.open(temporary, 'w', 0o600);
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        // Windows scanners and readers can briefly deny replacement. Keep the
        // same fsynced temporary snapshot and retry the atomic rename; never
        // remove the last good destination to make replacement succeed.
        for(let attempt=0;;attempt++){
          try{await storageIO.rename(temporary,storePath);break;}
          catch(error){
            if(!TRANSIENT_RENAME_ERRORS.has(error.code)||attempt>=RENAME_RETRY_DELAYS.length)throw error;
            await retryWait(RENAME_RETRY_DELAYS[attempt]);
          }
        }
      } catch (error) {
        await storageIO.unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    writeQueue = task;
    return task;
  };
  const storage = kind => ({
    async get(keys) {
      // Already accepted Codex callbacks can settle during shutdown. Reads then
      // return no state, so they cannot resurrect a disposed conversation.
      if(closed)return {};
      const value = kind === 'local' ? persistent : session;
      if (keys == null) return clone(value, MAX_STORE_BYTES);
      if (typeof keys === 'string') return Object.hasOwn(value, keys) ? { [keys]: clone(value[keys]) } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, clone(value[key])]));
      if (typeof keys === 'object') return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(Object.hasOwn(value, key) ? value[key] : fallback)]));
      throw Error('Invalid local storage key.');
    },
    async set(values) {
      if(closed)return;
      if (!values || Array.isArray(values) || typeof values !== 'object') throw Error('Invalid local storage update.');
      const previous = kind === 'local' ? persistent : session;
      const next = Object.assign(Object.create(null), previous, clone(values));
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_STORE_BYTES) throw Error('Local recovery storage is full.');
      if (kind === 'local') { persistent = next; await persist(); } else session = next;
    },
    async remove(keys) {
      if(closed)return;
      const values = typeof keys === 'string' ? [keys] : keys;
      if (!Array.isArray(values)) throw Error('Invalid local storage key.');
      const next = Object.assign(Object.create(null), kind === 'local' ? persistent : session);
      for (const key of values) delete next[key];
      if (kind === 'local') { persistent = next; await persist(); } else session = next;
    }
  });
  const localStorage = storage('local'), sessionStorage = storage('session');
  const getTab = async id => {
    assertOpen();
    if (!Number.isSafeInteger(id) || id <= 0) throw Error('Invalid notepad window.');
    const value = await windows.get(id);
    if (!value || value.id !== id) throw Error('This notepad window has closed.');
    return clone(value);
  };
  const disconnect = id => {
    const entry = ports.get(id); if (!entry) return;
    ports.delete(id); entry.active = false;
    entry.port.onDisconnect.emit(); entry.port.onMessage.clear(); entry.port.onDisconnect.clear();
  };
  const chrome = {
    runtime: {
      id: ID, lastError: undefined,
      getURL(file) { if (typeof file !== 'string' || file.includes('..') || file.startsWith('/')) throw Error('Invalid local page.'); return ORIGIN + '/' + file; },
      onMessage, onConnect, onStartup, onInstalled,
      async openOptionsPage() { assertOpen(); return windows.openSettings(); }
    },
    storage: { local: localStorage, session: sessionStorage },
    tabs: {
      get: getTab,
      async query(query = {}) {
        assertOpen();
        const values = clone(await windows.list());
        return values.filter(tab => (!query.active || tab.active) && (!query.url || tab.url === query.url));
      },
      async update(id, changes) { await getTab(id); return clone(await windows.update(id, clone(changes))); },
      async remove(id) {
        await getTab(id); await windows.remove(id); disconnect(id);
        delete session['tab:' + id]; onRemoved.emit(id, { windowId: id, isWindowClosing: true });
      },
      async create({ url }) {
        assertOpen();
        if (url === 'chrome://extensions/shortcuts') {
          if (typeof windows.openShortcuts === 'function') return windows.openShortcuts();
          throw Error('Desktop shortcuts are Alt+Q, Alt+W, Alt+M and Alt+Shift+S.');
        }
        if (![ORIGIN + '/editor.html', ORIGIN + '/options.html'].includes(url)) throw Error('Unsupported local page.');
        return clone(await windows.create(url));
      },
      onRemoved
    },
    windows: {
      async create(options) {
        assertOpen();
        if (options?.url !== ORIGIN + '/editor.html') throw Error('Unsupported notepad window.');
        const tab = await windows.create(options.url, clone(options));
        return { id: tab.windowId ?? tab.id };
      },
      async update(id, changes) { await getTab(id); return clone(await windows.update(id, clone(changes))); }
    },
    commands: { onCommand, async getAll() { return clone(COMMANDS); } },
    action: { onClicked },
    contentSettings: { notifications: { async clear() {} } },
    downloads: {
      async download(options) {
        assertOpen();
        const id = caller.getStore(); await getTab(id);
        if (typeof options?.url !== 'string' || !options.url.startsWith('blob:' + ORIGIN + '/')) throw Error('Invalid local document.');
        return windows.save(id, clone(options));
      }
    }
  };
  const setTimer = (repeat, fn, delay, ...args) => {
    assertOpen();
    const handle = (repeat ? setInterval : setTimeout)(() => {
      if (!repeat) timers.delete(handle);
      if (!closed) fn(...args);
    }, delay);
    timers.set(handle, repeat); handle.unref?.(); return handle;
  };
  const clearTimer = handle => { clearTimeout(handle); clearInterval(handle); timers.delete(handle); };
  let context;
  const runFile = file => {
    if (!['core.js', 'worker.js'].includes(file)) throw Error('Unsupported desktop worker script.');
    const sourcePath = path.join(root, file);
    if (fs.statSync(sourcePath).size > 1024 * 1024) throw Error('The desktop worker script is too large.');
    return vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: file, timeout: 5000 });
  };
  context = vm.createContext({
    chrome,
    NotesEnvironment: Object.freeze({ origin: ORIGIN }),
    NotesNative: async (action, data) => { assertOpen(); return clone(await native(action, clone(data))); },
    crypto: webcrypto, TextEncoder, TextDecoder,
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    setTimeout: (...args) => setTimer(false, ...args),
    setInterval: (...args) => setTimer(true, ...args),
    clearTimeout: clearTimer, clearInterval: clearTimer,
    importScripts: (...files) => { for (const file of files) { if (file !== 'core.js') throw Error('Unsupported worker import.'); runFile(file); } },
    // Logs must never accidentally write submitted documents or conversations.
    console: Object.freeze({ log() {}, warn() {}, error() {} })
  }, { name: 'Notes Workspace state worker', codeGeneration: { strings: false, wasm: false } });
  try { runFile('worker.js'); onStartup.emit(); } catch (error) { for (const timer of timers.keys()) clearTimer(timer); throw error; }

  return {
    async request(type, data = {}, sender) {
      assertOpen();
      if (typeof type !== 'string' || !sender) throw Error('Invalid local request.');
      const tab = await getTab(sender.id);
      const url = String(sender.url || '').split(/[?#]/)[0];
      if (![ORIGIN + '/editor.html', ORIGIN + '/options.html'].includes(url) || tab.url?.split(/[?#]/)[0] !== url) throw Error('This request must come from the local notepad.');
      const message = { ...clone(data), type, tabId: sender.id };
      const source = { id: ID, url, tab, frameId: 0 };
      return caller.run(sender.id, () => new Promise((resolve, reject) => {
        let answered = false;
        const reply = result => { if (!answered) { answered = true; try { resolve(clone(result)); } catch (error) { reject(error); } } };
        try {
          const results = onMessage.emit(message, source, reply);
          if (!answered && !results.includes(true)) reject(Error('The notepad state worker did not handle this request.'));
        } catch (error) { reject(error); }
      }));
    },
    async connect(id, post) {
      await getTab(id);
      if (typeof post !== 'function') throw Error('Invalid notepad event receiver.');
      const tab = await getTab(id);
      if (tab.url?.split(/[?#]/)[0] !== ORIGIN + '/editor.html') throw Error('Only the local editor can receive notepad events.');
      disconnect(id);
      const entry = { active: true };
      const port = {
        name: 'editor', sender: { id: ID, url: ORIGIN + '/editor.html', tab, frameId: 0 },
        onMessage: event(), onDisconnect: event(),
        postMessage(message) { if (!entry.active || closed) throw Error('The editor connection closed.'); post(clone(message)); }
      };
      entry.port = port; ports.set(id, entry); onConnect.emit(port);
      await Promise.all(port.onMessage.emit({ hello: id }));
    },
    receive(id, message) {
      assertOpen(); const entry = ports.get(id);
      if (!entry?.active) return;
      const value = clone(message);
      // A renderer may only answer a worker request. It cannot impersonate a
      // different window by re-running the extension port's hello handshake.
      if (!value || value.hello !== undefined || (value.replyTo === undefined && value.heartbeat !== true)) throw Error('Invalid notepad event reply.');
      return Promise.all(entry.port.onMessage.emit(value));
    },
    disconnect,
    windowClosed(id) {
      disconnect(id); delete session['tab:' + id];
      if (!closed) onRemoved.emit(id, { windowId: id, isWindowClosing: true });
    },
    async command(name, id) {
      assertOpen();
      if (!COMMANDS.some(item => item.name === name)) throw Error('Unsupported desktop shortcut.');
      const tab = id == null ? undefined : await getTab(id);
      await Promise.all(onCommand.emit(name, tab));
    },
    snapshot() { return clone(persistent, MAX_STORE_BYTES); },
    enabled(id) { return session['tab:'+id]?.private === false; },
    async close() {
      if (closed) return writeQueue;
      closed = true;
      for (const timer of [...timers.keys()]) clearTimer(timer);
      for (const id of [...ports.keys()]) disconnect(id);
      await writeQueue;
      onMessage.clear(); onConnect.clear(); onStartup.clear(); onInstalled.clear(); onCommand.clear(); onClicked.clear(); onRemoved.clear();
    }
  };
}

module.exports = { createRuntime, ID, ORIGIN };
