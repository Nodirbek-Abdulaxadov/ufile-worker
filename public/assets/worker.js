// UFile worker: opens a PDF, Word, Excel or PowerPoint file in the matching Craft engine
// (engines/<id>/ on this origin, in an iframe) for viewing or editing, as a page of its own or
// embedded in another site's <iframe>.
//
// The worker talks to two windows:
// - its engine iframe, through the engine's `<prefix>:*` messages (same origin only);
// - the page embedding it, through `ufile:*` messages (see README.md › API), from origins
//   config.json allows.
import { ACCEPT, ENGINES, engineForBytes, engineForMime, engineForName, isDocumentSave, mimeFor, splitName } from './engines.js';
import { LANGUAGES, pickLanguage, translator } from './i18n.js';

const VERSION = '1.0.0';
const params = new URLSearchParams(location.search);
const embedded = window.parent !== window;
const $ = (id) => document.getElementById(id);
const app = $('app');

const DEFAULTS = {
  // Pages that may embed the worker and drive it with ufile:* messages ("*" = any).
  allowedParentOrigins: ['*'],
  // Where ?url= / ufile:open {url} may fetch files from ("self" = this origin).
  allowedFileOrigins: ['*'],
  // Where edited files may be sent with saveUrl from a link or from a page allowed only by "*".
  allowedSaveOrigins: ['self'],
  defaultMode: 'edit',
  defaultLanguage: 'uz',
  allowEdit: true,
  maxFileMB: 300,
  // The name comments and tracked changes are signed with when the page gives none
  // (?author= or ufile:open {author}); empty: "User" in the interface's language.
  author: '',
};

const state = {
  config: { ...DEFAULTS },
  lang: 'uz',
  t: (k) => k,
  mode: 'edit',
  allowEdit: true,
  author: '',
  // { name, bytes, engine, source: 'local'|'url'|'host'|'host-url'|'new', saveUrl, saveMethod, saveHeaders, ackSaves }
  file: null,
  frame: null,
  dirty: false,
  // Engines draw with WebGPU when the browser has a real GPU for it, else with WebGL2.
  webgl: Promise.resolve(false),
  statusTimer: 0,
  // Resolved when the save the worker asked the engine for has been stored (or failed).
  saveWaiter: null,
  // The page embedding the worker.
  parent: { origin: null, verified: false, explicit: false },
};

// ---------------------------------------------------------------------------------------------
// Start

main().catch((e) => {
  console.error(e);
  showError(String(e?.message || e));
});

async function main() {
  state.webgl = preferWebgl();
  state.config = await loadConfig();
  setLanguage(pickLanguage(params.get('lang'), localStore('ufile.lang'), state.config.defaultLanguage), false);
  state.allowEdit = state.config.allowEdit !== false && params.get('allowEdit') !== '0' && params.get('allowEdit') !== 'false';
  const mode = params.get('mode') || localStore('ufile.mode') || state.config.defaultMode;
  state.mode = mode === 'view' || !state.allowEdit ? 'view' : 'edit';
  state.author = (params.get('author') || state.config.author || '').trim().slice(0, 200);
  if (params.get('toolbar') === '0') document.body.classList.add('no-toolbar');
  app.dataset.embedded = String(embedded);

  setupParent();
  setupLanding();
  setupToolbar();
  window.addEventListener('message', onMessage);
  window.addEventListener('beforeunload', (e) => {
    if (!embedded && state.dirty) e.preventDefault();
  });
  render();
  notifyParent('ufile:ready', { version: VERSION, engines: Object.keys(ENGINES), mode: state.mode });

  const url = params.get('url') || params.get('file');
  const make = params.get('new');
  if (url) {
    const saveUrl = params.get('saveUrl');
    await openFromUrl(url, { name: params.get('name'), source: 'url', saveUrl, saveMethod: params.get('saveMethod'), type: params.get('type') });
  } else if (make && ENGINES[make]) {
    await openNew(ENGINES[make], { saveUrl: params.get('saveUrl'), saveMethod: params.get('saveMethod') });
  } else {
    setView(embedded && params.has('embed') ? 'waiting' : 'landing');
  }
}

/**
 * Whether to ask the engines for WebGL2: when the only WebGPU adapter is a software one
 * (SwiftShader and the like, in virtual machines and remote desktops), which WebGL2 handles
 * better. `?webgl` forces WebGL2, `?gpu=webgpu` forbids it.
 */
async function preferWebgl() {
  if (params.has('webgl')) return true;
  if (params.get('gpu') === 'webgpu' || !navigator.gpu?.requestAdapter) return false;
  try {
    const adapter = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (!adapter) return false;
    const info = adapter.info || {};
    const name = `${info.vendor} ${info.architecture} ${info.device} ${info.description}`;
    return adapter.isFallbackAdapter === true || info.isFallbackAdapter === true || /swiftshader|llvmpipe|softpipe|basic render/i.test(name);
  } catch {
    return false;
  }
}

async function loadConfig() {
  try {
    const r = await fetch('config.json', { cache: 'no-cache' });
    if (r.ok) return { ...DEFAULTS, ...(await r.json()) };
  } catch (e) {
    console.warn('config.json:', e);
  }
  return { ...DEFAULTS };
}

function localStore(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (third-party iframes, private windows): settings just aren't kept.
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Language

function setLanguage(lang, remember = true) {
  state.lang = lang;
  state.t = translator(lang);
  if (remember) localStore('ufile.lang', lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = state.t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = state.t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = state.t(el.dataset.i18nPlaceholder);
  render();
}

// ---------------------------------------------------------------------------------------------
// The embedding page

/** Whether `origin` matches one of `patterns`: "*", "self", an origin, or "https://*.example.com". */
function originAllowed(origin, patterns, { explicitOnly = false } = {}) {
  if (!origin || origin === 'null') return false;
  return (patterns || []).some((p) => {
    if (p === '*') return !explicitOnly;
    if (p === 'self') return origin === location.origin;
    if (p === origin) return true;
    const m = /^(https?:\/\/)\*\.(.+)$/i.exec(p);
    return !!m && origin.startsWith(m[1]) && origin.endsWith(`.${m[2]}`) && /^[a-z0-9.-]+(:\d+)?$/i.test(origin.slice(m[1].length));
  });
}

function originOf(url) {
  try {
    return new URL(url, location.href).origin;
  } catch {
    return null;
  }
}

function setupParent() {
  if (!embedded) return;
  // The browser tells us who framed us (ancestorOrigins, or the referrer elsewhere).
  const origin = location.ancestorOrigins?.[0] || (document.referrer ? originOf(document.referrer) : null);
  if (origin) trustParent(origin);
}

function trustParent(origin) {
  const { allowedParentOrigins } = state.config;
  if (!originAllowed(origin, allowedParentOrigins)) return false;
  if (state.parent.origin && state.parent.origin !== origin) return false;
  state.parent = { origin, verified: true, explicit: originAllowed(origin, allowedParentOrigins, { explicitOnly: true }) };
  return true;
}

function notifyParent(type, data = {}) {
  if (!embedded) return;
  if (state.parent.verified) {
    window.parent.postMessage({ ...data, type }, state.parent.origin);
  } else if (type === 'ufile:ready') {
    // Not knowing who framed us yet, only this harmless hello goes out; the first message back
    // tells us the page's origin.
    window.parent.postMessage({ type, version: VERSION }, '*');
  }
}

/**
 * Whether the page may receive the document's bytes: it sent them itself, or config.json names
 * its origin (not just "*"). A file the worker fetched from a link isn't handed to any page.
 */
function parentGetsBytes() {
  return embedded && state.parent.verified && !!state.file && (state.file.source === 'host' || state.file.source === 'new' || state.parent.explicit);
}

const acks = new Map();
let ackSeq = 0;

function onParentMessage(msg) {
  switch (msg.type) {
    case 'ufile:open':
      return hostOpen(msg);
    case 'ufile:setMode':
      return setMode(msg.mode, { fromHost: true });
    case 'ufile:save':
      return saveAndWait();
    case 'ufile:download':
      return downloadCurrent();
    case 'ufile:close':
      return closeDocument({ force: true });
    case 'ufile:saveResult': {
      const ack = acks.get(msg.saveId);
      if (!ack) return;
      acks.delete(msg.saveId);
      clearTimeout(ack.timer);
      if (msg.ok === false) ack.reject(new Error(msg.error || 'rejected by the page'));
      else ack.resolve();
      return;
    }
    default:
      return;
  }
}

async function hostOpen(msg) {
  if (typeof msg.allowEdit === 'boolean') state.allowEdit = msg.allowEdit && state.config.allowEdit !== false;
  if (msg.mode === 'view' || msg.mode === 'edit') state.mode = msg.mode;
  if (!state.allowEdit) state.mode = 'view';
  if (typeof msg.author === 'string') state.author = msg.author.trim().slice(0, 200);
  if (typeof msg.lang === 'string') setLanguage(pickLanguage(msg.lang));
  const saving = {
    saveUrl: msg.saveUrl,
    saveMethod: msg.saveMethod,
    saveHeaders: msg.saveHeaders,
    ackSaves: !!msg.ackSaves,
    // `engine` forces one ('pdf', 'word', 'excel', 'slides') for a file whose name doesn't say.
    type: typeof msg.engine === 'string' ? msg.engine : undefined,
    fromHost: true,
  };
  if (msg.bytes) {
    const bytes = await toBytes(msg.bytes);
    return openBytes({ name: msg.name, bytes, source: 'host', ...saving });
  }
  if (msg.url) return openFromUrl(msg.url, { name: msg.name, source: 'host-url', ...saving });
  if (msg.new && ENGINES[msg.new]) return openNew(ENGINES[msg.new], saving);
  return undefined;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error('bytes must be an ArrayBuffer, a typed array or a Blob');
}

// ---------------------------------------------------------------------------------------------
// Messages

function onMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const frame = state.frame;
  if (frame && event.source === frame.window && event.origin === location.origin) {
    if (msg.type.startsWith(`${frame.engine.prefix}:`)) onEngineMessage(frame, msg.type.slice(frame.engine.prefix.length + 1), msg);
    return;
  }
  if (embedded && event.source === window.parent && msg.type.startsWith('ufile:')) {
    if (!trustParent(event.origin)) {
      console.warn(`UFile: ignored ${msg.type} from ${event.origin} (not in allowedParentOrigins)`);
      return;
    }
    onParentMessage(msg);
  }
}

function onEngineMessage(frame, kind, msg) {
  switch (kind) {
    case 'ready':
      frame.onReady(msg);
      break;
    case 'opened':
      frame.onOpened(msg);
      break;
    case 'dirty':
      setDirty(!!msg.dirty);
      break;
    case 'save':
      if (msg.bytes) onEngineSave(String(msg.name || state.file?.name || 'document'), new Uint8Array(msg.bytes));
      break;
    case 'failed':
      frame.fail(state.t('error.engineFailed'), msg.error);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// Opening files

function cleanName(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base.slice(0, 200);
}

function nameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? (plain[1] ?? plain[2]).trim() : null;
}

function nameFromUrl(url) {
  try {
    return decodeURIComponent(url.pathname.split('/').pop() || '');
  } catch {
    return url.pathname.split('/').pop() || '';
  }
}

async function openFromUrl(raw, opts = {}) {
  setView('engine');
  let url;
  try {
    url = new URL(raw, location.href);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error(url.protocol);
  } catch {
    return showError(state.t('error.badUrl', { url: raw }));
  }
  if (url.protocol !== 'blob:' && !originAllowed(url.origin, state.config.allowedFileOrigins)) {
    return showError(state.t('error.fileOrigin', { origin: url.origin }));
  }
  showOverlay(state.t('overlay.loadingFile'), { progress: 0 });
  let res;
  let bytes;
  try {
    // Cookies only go to this worker's own server; elsewhere, give a link that works without them.
    res = await fetch(url, { credentials: url.origin === location.origin ? 'same-origin' : 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    bytes = await readBody(res, (f) => setProgress(f));
  } catch (e) {
    return showError(state.t('error.fetch', { detail: e.message || e }), { retry: () => openFromUrl(raw, opts) });
  }
  const name = cleanName(opts.name) || cleanName(nameFromDisposition(res.headers.get('content-disposition'))) || cleanName(nameFromUrl(url));
  const typed = engineForMime(res.headers.get('content-type'));
  return openBytes({ ...opts, name, bytes, url: url.href, type: opts.type || typed?.id });
}

async function readBody(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  const limit = state.config.maxFileMB * 1048576;
  if (total > limit) throw new Error(state.t('error.tooLarge', { size: Math.round(total / 1048576) }));
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got > limit) throw new Error(state.t('error.tooLarge', { size: Math.round(got / 1048576) }));
    onProgress(Math.min(1, got / total));
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

async function openLocalFile(file) {
  if (!file) return;
  setView('engine');
  showOverlay(state.t('overlay.loadingFile'));
  try {
    if (file.size > state.config.maxFileMB * 1048576) throw new Error(state.t('error.tooLarge', { size: Math.round(file.size / 1048576) }));
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes({ name: file.name, bytes, source: 'local' });
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function openNew(engine, opts = {}) {
  setView('engine');
  showOverlay(state.t('overlay.loadingFile'));
  const label = { word: 'landing.newWord', excel: 'landing.newExcel', slides: 'landing.newSlides' }[engine.id] || 'landing.newWord';
  try {
    const res = await fetch(`assets/templates/new.${engine.native}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (state.allowEdit) state.mode = 'edit';
    await openBytes({ ...opts, name: `${state.t(label)}.${engine.native}`, bytes, source: 'new' });
  } catch (e) {
    showError(state.t('error.fetch', { detail: e.message || e }));
  }
}

/** Open `file.bytes` in the engine for its type, checking where its saves may go first. */
async function openBytes(file) {
  setView('engine');
  if (!file.bytes?.length) return showError(state.t('error.empty'));
  const named = cleanName(file.name);
  const engine = (file.type && ENGINES[file.type]) || engineForName(named) || engineForBytes(file.bytes);
  if (!engine) return showError(state.t('error.unsupported', { name: named || '?' }));
  // A name without an extension (a download link) gets the engine's.
  let name = named || `document.${engine.native}`;
  if (!splitName(name).ext || !engine.exts.includes(splitName(name).ext)) {
    const sniffed = engineForBytes(file.bytes);
    if (!splitName(name).ext || sniffed === engine) name = `${splitName(name).stem || 'document'}.${engine.native}`;
  }
  let saveUrl = null;
  if (file.saveUrl) {
    const target = originOf(file.saveUrl);
    const fromTrustedPage = file.fromHost && state.parent.explicit;
    if (!target || !(fromTrustedPage || originAllowed(target, state.config.allowedSaveOrigins))) {
      return showError(state.t('error.saveOrigin', { origin: target || file.saveUrl }));
    }
    saveUrl = new URL(file.saveUrl, location.href).href;
  }
  const method = String(file.saveMethod || 'PUT').toUpperCase();
  state.file = {
    name,
    bytes: file.bytes,
    engine,
    source: file.source || 'local',
    url: file.url || null,
    saveUrl,
    saveMethod: method === 'POST' ? 'POST' : 'PUT',
    saveHeaders: plainHeaders(file.saveHeaders),
    ackSaves: !!file.ackSaves,
  };
  setDirty(false);
  await mountEngine();
}

function plainHeaders(h) {
  if (!h || typeof h !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length < 4096) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The engine iframe

const installed = new Map();

async function engineInstalled(engine) {
  if (!installed.has(engine.id)) {
    installed.set(
      engine.id,
      fetch(`${engine.dir}index.html`, { method: 'HEAD', cache: 'no-cache' })
        .then((r) => r.ok)
        .catch(() => false),
    );
  }
  return installed.get(engine.id);
}

async function mountEngine() {
  const { engine } = state.file;
  state.frame?.destroy();
  state.frame = null;
  render();
  showOverlay(state.t('overlay.loadingEngine', { engine: engine.name }), { text: state.t('overlay.hint') });
  if (!(await engineInstalled(engine))) {
    installed.delete(engine.id);
    return showError(state.t('error.engineMissing', { engine: engine.name, id: engine.id }), { retry: () => mountEngine() });
  }
  state.frame = new EngineFrame(engine, state.mode, await state.webgl);
  notifyParent('ufile:loading', { name: state.file.name, engine: engine.id, mode: state.mode });
}

class EngineFrame {
  constructor(engine, mode, webgl) {
    this.engine = engine;
    this.mode = mode;
    this.ready = false;
    this.opened = false;
    // The engine switches between viewing and editing in place (else it is reloaded).
    this.modes = false;
    const q = new URLSearchParams({ host: 'parent', mode });
    q.set('author', state.author || state.t('user.default'));
    if (webgl) q.set('webgl', '');
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'engine__frame';
    this.iframe.title = `${engine.name} — ${engine.app}`;
    this.iframe.allow = 'clipboard-read; clipboard-write; fullscreen';
    this.iframe.src = `${engine.dir}index.html?${q}`;
    $('engine-host').append(this.iframe);
    // The first visit downloads the engine (a few megabytes) and compiles it.
    this.timer = setTimeout(() => this.fail(state.t('error.engineTimeout')), 120000);
  }

  get window() {
    return this.iframe.contentWindow;
  }

  post(kind, data, transfer) {
    this.window?.postMessage({ type: `${this.engine.prefix}:${kind}`, ...data }, location.origin, transfer || []);
  }

  onReady(msg) {
    if (this.ready || this !== state.frame) return;
    this.ready = true;
    this.modes = msg.modes === true;
    clearTimeout(this.timer);
    setOverlayTitle(state.t('overlay.opening'));
    const copy = state.file.bytes.slice();
    this.post('open', { name: state.file.name, bytes: copy.buffer }, [copy.buffer]);
    // An engine that can't open the file says so itself; don't keep it covered meanwhile.
    this.timer = setTimeout(() => this.onOpened({ ok: true, late: true }), 20000);
  }

  onOpened(msg) {
    if (this.opened || this !== state.frame) return;
    this.opened = true;
    clearTimeout(this.timer);
    hideOverlay();
    if (msg.ok === false) toast(`${state.t('error.open')}: ${msg.error || state.file.name}`, 'error', 8000);
    if (!embedded) this.iframe.focus();
    notifyParent('ufile:opened', { name: state.file.name, engine: this.engine.id, mode: this.mode, ok: msg.ok !== false, error: msg.error });
  }

  /** Switch the open engine to viewing or editing without reloading it. */
  setMode(mode) {
    this.mode = mode;
    this.post('mode', { mode });
  }

  fail(message, detail) {
    if (this !== state.frame) return;
    clearTimeout(this.timer);
    showError(message, { detail, retry: () => mountEngine() });
  }

  /** Press Ctrl+S (⌘S on a Mac) in the engine: its own Save, which hands the file back to us. */
  pressSave() {
    const win = this.window;
    const canvas = win?.document?.querySelector('canvas');
    if (!this.ready || !canvas) return false;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const init = { key: 's', code: 'KeyS', keyCode: 83, which: 83, bubbles: true, cancelable: true, ctrlKey: !mac, metaKey: mac };
    win.focus();
    canvas.focus();
    canvas.dispatchEvent(new win.KeyboardEvent('keydown', init));
    canvas.dispatchEvent(new win.KeyboardEvent('keyup', init));
    return true;
  }

  destroy() {
    clearTimeout(this.timer);
    this.iframe.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// Saving

async function onEngineSave(name, bytes) {
  const file = state.file;
  if (!file) return;
  const save = state.mode === 'edit' && isDocumentSave(file.name, name, file.engine);
  if (!save) {
    // An export (PDF, pictures…), or a copy saved while viewing: it goes to the user's computer.
    downloadBytes(name, bytes);
    toast(state.t('toast.exported', { name }), 'success');
    notifyParent('ufile:export', { name, size: bytes.length });
    settleSaveWaiter(false);
    return;
  }
  setStatus(state.t('status.saving'));
  try {
    const where = await storeDocument(name, bytes);
    file.bytes = bytes;
    file.name = cleanName(name) || file.name;
    const label = where === 'download' ? state.t('status.savedDownload') : state.t('status.saved');
    setStatus(`${label} · ${clock()}`, 'saved', 6000);
    $('file-name').textContent = file.name;
    notifyParent('ufile:saved', { name: file.name, size: bytes.length, to: where });
    settleSaveWaiter(true);
  } catch (e) {
    setStatus(state.t('status.saveFailed'), 'error');
    toast(`${state.t('status.saveFailed')}: ${e.message || e}`, 'error', 8000);
    notifyParent('ufile:error', { code: 'save', message: String(e.message || e) });
    settleSaveWaiter(false);
  }
}

/** Store a save: at saveUrl, with the embedding page, or as a download. Returns which. */
async function storeDocument(name, bytes) {
  const file = state.file;
  if (file.saveUrl) {
    const res = await fetch(file.saveUrl, {
      method: file.saveMethod,
      body: bytes,
      headers: { 'Content-Type': mimeFor(name), 'X-UFile-Name': encodeURIComponent(name), ...file.saveHeaders },
      credentials: originOf(file.saveUrl) === location.origin ? 'same-origin' : 'omit',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    return 'url';
  }
  if (parentGetsBytes()) {
    const saveId = ++ackSeq;
    const copy = bytes.slice();
    window.parent.postMessage({ type: 'ufile:save', saveId, name, mime: mimeFor(name), size: bytes.length, bytes: copy.buffer }, state.parent.origin, [copy.buffer]);
    if (file.ackSaves) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          acks.delete(saveId);
          reject(new Error('the page did not confirm the save'));
        }, 120000);
        acks.set(saveId, { resolve, reject, timer });
      });
    }
    return 'host';
  }
  downloadBytes(name, bytes);
  return 'download';
}

/** Ask the engine to save; resolves true once the save is stored, false if it wasn't. */
function saveAndWait() {
  if (!state.frame?.ready || state.mode !== 'edit') {
    if (state.mode === 'view') toast(state.t('toast.viewOnlySave'), 'warning');
    return Promise.resolve(false);
  }
  settleSaveWaiter(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.saveWaiter = null;
      setStatus();
      toast(state.t('toast.saveNoResponse'), 'warning', 8000);
      resolve(false);
    }, 20000);
    state.saveWaiter = { resolve, timer };
    if (!state.frame.pressSave()) settleSaveWaiter(false);
    else setStatus(state.t('status.saving'));
  });
}

function settleSaveWaiter(ok) {
  const w = state.saveWaiter;
  if (!w) return;
  state.saveWaiter = null;
  clearTimeout(w.timer);
  w.resolve(ok);
}

function downloadBytes(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(name) }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadCurrent() {
  if (!state.file) return;
  if (state.dirty) toast(state.t('toast.downloadDirty'), 'warning', 7000);
  downloadBytes(state.file.name, state.file.bytes);
}

// ---------------------------------------------------------------------------------------------
// Modes, closing

async function setMode(mode, { fromHost = false } = {}) {
  if (mode !== 'view' && mode !== 'edit') return;
  if (mode === 'edit' && !state.allowEdit) return;
  if (mode === state.mode) return;
  const inPlace = !!state.frame?.ready && state.frame.modes;
  if (state.file && state.dirty && state.mode === 'edit') {
    // Switching in place keeps unsaved changes in the editor; reloading it would lose them.
    const choice = fromHost ? 'save' : await choose(state.t('confirm.switchTitle'), state.t('confirm.switchText'));
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await saveAndWait())) return;
  }
  state.mode = mode;
  if (!embedded) localStore('ufile.mode', mode);
  render();
  notifyParent('ufile:modeChanged', { mode });
  if (!state.file) return;
  if (inPlace) {
    state.frame.setMode(mode);
    if (!embedded && mode === 'edit') state.frame.iframe.focus();
  } else {
    setDirty(false);
    await mountEngine();
  }
}

async function closeDocument({ force = false } = {}) {
  if (!force && state.dirty) {
    const choice = await choose(state.t('confirm.closeTitle'), state.t('confirm.closeText'));
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await saveAndWait())) return;
  }
  state.frame?.destroy();
  state.frame = null;
  state.file = null;
  setDirty(false);
  hideOverlay();
  setView(embedded && params.has('embed') ? 'waiting' : 'landing');
  notifyParent('ufile:closed', {});
}

/** Ask save / don't save / cancel; resolves to 'save', 'discard' or 'cancel'. */
function choose(title, text) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering

function setView(view) {
  app.dataset.view = view;
}

function render() {
  app.dataset.mode = state.mode;
  app.dataset.edit = state.allowEdit ? 'on' : 'off';
  for (const seg of [$('mode-switch'), $('landing-mode')]) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  }
  const file = state.file;
  const badge = $('file-badge');
  if (file) {
    badge.dataset.type = file.engine.id;
    badge.textContent = file.engine.badge;
    $('file-name').textContent = file.name;
    document.title = `${file.name} — UFile`;
  } else {
    document.title = `UFile — ${state.t('app.tagline')}`;
  }
  setStatus();
}

function setDirty(dirty) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  app.dataset.dirty = String(dirty);
  setStatus();
  notifyParent('ufile:dirty', { dirty });
}

/** The status line under the file name; without `text`, what the document's state says. */
function setStatus(text, tone = '', holdMs = 0) {
  const el = $('file-status');
  clearTimeout(state.statusTimer);
  if (text) {
    el.textContent = text;
    el.dataset.tone = tone;
    if (holdMs) state.statusTimer = setTimeout(() => setStatus(), holdMs);
    return;
  }
  const file = state.file;
  if (!file) {
    el.textContent = '';
    el.dataset.tone = '';
  } else if (state.dirty) {
    el.textContent = state.t('status.unsaved');
    el.dataset.tone = 'unsaved';
  } else {
    el.textContent = `${file.engine.name} · ${size(file.bytes.length)}`;
    el.dataset.tone = '';
  }
}

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function clock() {
  return new Date().toLocaleTimeString(state.lang, { hour: '2-digit', minute: '2-digit' });
}

function showOverlay(title, { text = '', progress = null } = {}) {
  const o = $('overlay');
  o.hidden = false;
  o.classList.remove('is-error');
  setOverlayTitle(title);
  $('overlay-text').textContent = text;
  $('overlay-detail').hidden = true;
  $('overlay-actions').hidden = true;
  $('overlay-progress').hidden = progress === null;
  if (progress !== null) setProgress(progress);
}

function setOverlayTitle(title) {
  $('overlay-title').textContent = title;
}

function setProgress(fraction) {
  $('overlay-progress').hidden = false;
  $('overlay-progress-bar').style.width = `${Math.round(fraction * 100)}%`;
}

function hideOverlay() {
  $('overlay').hidden = true;
}

let retryAction = null;

function showError(message, { detail = '', retry = null } = {}) {
  if (app.dataset.view !== 'engine') setView('engine');
  const o = $('overlay');
  o.hidden = false;
  o.classList.add('is-error');
  setOverlayTitle(state.t('error.title'));
  $('overlay-text').textContent = message;
  $('overlay-progress').hidden = true;
  $('overlay-detail').hidden = !detail;
  $('overlay-detail').textContent = detail || '';
  $('overlay-actions').hidden = false;
  retryAction = retry;
  $('btn-retry').hidden = !retry;
  $('btn-error-close').hidden = embedded && params.has('embed');
  notifyParent('ufile:error', { code: 'open', message, detail: detail || undefined });
}

function toast(text, tone = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------------------------------------
// Controls

function setupToolbar() {
  for (const b of $('mode-switch').querySelectorAll('button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('btn-save').addEventListener('click', () => saveAndWait());
  $('btn-download').addEventListener('click', () => downloadCurrent());
  $('btn-close').addEventListener('click', () => closeDocument());
  $('btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $('btn-retry').addEventListener('click', () => retryAction?.());
  $('btn-error-close').addEventListener('click', () => closeDocument({ force: true }));
}

function setupLanding() {
  const select = $('lang-select');
  for (const { code, name } of LANGUAGES) select.append(new Option(name, code, false, code === state.lang));
  select.value = state.lang;
  select.addEventListener('change', () => setLanguage(select.value));

  for (const b of $('landing-mode').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      if (b.dataset.mode === 'edit' && !state.allowEdit) return;
      state.mode = b.dataset.mode;
      localStore('ufile.mode', state.mode);
      render();
    });
  }

  const input = $('file-input');
  input.accept = ACCEPT;
  $('btn-choose').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    openLocalFile(input.files?.[0]);
    input.value = '';
  });
  $('drop').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  $('url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('url-input').value.trim();
    if (url) openFromUrl(url, { source: 'url' });
  });

  for (const b of document.querySelectorAll('[data-new]')) b.addEventListener('click', () => openNew(ENGINES[b.dataset.new]));

  // Files dropped anywhere on the landing page.
  let depth = 0;
  const landingShown = () => app.dataset.view === 'landing';
  window.addEventListener('dragenter', (e) => {
    if (!landingShown() || !e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    $('drop').classList.add('is-over');
  });
  window.addEventListener('dragleave', () => {
    if (depth > 0 && --depth === 0) $('drop').classList.remove('is-over');
  });
  window.addEventListener('dragover', (e) => {
    if (landingShown()) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!landingShown()) return;
    e.preventDefault();
    depth = 0;
    $('drop').classList.remove('is-over');
    openLocalFile(e.dataTransfer?.files?.[0]);
  });
}
