/*!
 * UFile embed SDK: puts the UFile worker (PDF, Word, Excel and PowerPoint viewer and editor) in
 * an <iframe> on your page and talks to it.
 *
 *   <script src="https://docs.example.com/sdk/ufile.js"></script>
 *   <div id="doc" style="height: 80vh"></div>
 *   <script>
 *     const editor = UFile.mount('#doc', {
 *       url: 'https://files.example.com/report.docx',   // or file: a File / Blob / ArrayBuffer
 *       mode: 'edit',                                   // 'view' | 'edit'
 *       onSave: async (file) => { await upload(file.blob, file.name); },
 *     });
 *   </script>
 *
 * See README.md (API) for every option, method and event.
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var script = document.currentScript;
  // The worker lives one folder up from this script (…/sdk/ufile.js → …/).
  var DEFAULT_SERVER = script && script.src ? new URL('../', script.src).href : null;

  function UFileEditor(target, options) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('UFile.mount: no element ' + target);
    this.options = options || {};
    this.server = new URL(this.options.server || DEFAULT_SERVER || './', location.href).href;
    if (!/\/$/.test(this.server)) this.server += '/';
    this.origin = new URL(this.server).origin;
    this.ready = false;
    this.dirty = false;
    this.mode = this.options.mode === 'view' ? 'view' : 'edit';
    this._pending = null;
    this._handlers = {};

    var q = new URLSearchParams({ embed: '1', mode: this.mode });
    if (this.options.lang) q.set('lang', this.options.lang);
    if (this.options.allowEdit === false) q.set('allowEdit', '0');
    if (this.options.toolbar === false) q.set('toolbar', '0');

    var frame = document.createElement('iframe');
    frame.src = this.server + 'index.html?' + q.toString();
    frame.title = this.options.title || 'UFile';
    frame.allow = 'clipboard-read; clipboard-write; fullscreen';
    frame.setAttribute('allowfullscreen', '');
    frame.className = this.options.className || '';
    frame.style.cssText = 'display:block;width:100%;border:0;height:' + (this.options.height || '100%');
    this.iframe = frame;

    var self = this;
    this._onMessage = function (event) {
      if (event.source !== frame.contentWindow || event.origin !== self.origin) return;
      var msg = event.data;
      if (msg && typeof msg.type === 'string' && msg.type.indexOf('ufile:') === 0) self._receive(msg);
    };
    window.addEventListener('message', this._onMessage);
    this._onBeforeUnload = function (e) {
      if (self.dirty && self.options.guardUnload !== false) e.preventDefault();
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);
    el.appendChild(frame);

    if (this.options.file || this.options.url || this.options.new) this.open(this.options);
  }

  UFileEditor.prototype._post = function (msg, transfer) {
    this.iframe.contentWindow.postMessage(msg, this.origin, transfer || []);
  };

  UFileEditor.prototype._emit = function (name, value) {
    var key = 'on' + name.charAt(0).toUpperCase() + name.slice(1);
    if (typeof this.options[key] === 'function') {
      try {
        this.options[key](value);
      } catch (e) {
        console.error(e);
      }
    }
    (this._handlers[name] || []).forEach(function (fn) {
      try {
        fn(value);
      } catch (e) {
        console.error(e);
      }
    });
  };

  UFileEditor.prototype._receive = function (msg) {
    var self = this;
    switch (msg.type) {
      case 'ufile:ready':
        this.ready = true;
        this._emit('ready', { version: msg.version });
        if (this._pending) {
          var pending = this._pending;
          this._pending = null;
          this._send(pending);
        }
        break;
      case 'ufile:opened':
        this._emit('opened', { name: msg.name, engine: msg.engine, mode: msg.mode, ok: msg.ok, error: msg.error });
        break;
      case 'ufile:dirty':
        this.dirty = !!msg.dirty;
        this._emit('dirty', this.dirty);
        break;
      case 'ufile:save': {
        var file = { name: msg.name, mime: msg.mime, size: msg.size, bytes: msg.bytes, blob: new Blob([msg.bytes], { type: msg.mime }) };
        var done = function (ok, error) {
          self._post({ type: 'ufile:saveResult', saveId: msg.saveId, ok: ok, error: error ? String(error.message || error) : undefined });
        };
        if (typeof this.options.onSave !== 'function') {
          done(true);
          break;
        }
        Promise.resolve()
          .then(function () {
            return self.options.onSave(file);
          })
          .then(
            function () {
              done(true);
            },
            function (e) {
              done(false, e);
            },
          );
        break;
      }
      case 'ufile:saved':
        this._emit('saved', { name: msg.name, size: msg.size, to: msg.to });
        break;
      case 'ufile:export':
        this._emit('export', { name: msg.name, size: msg.size });
        break;
      case 'ufile:modeChanged':
        this.mode = msg.mode;
        this._emit('modeChange', msg.mode);
        break;
      case 'ufile:error':
        this._emit('error', { code: msg.code, message: msg.message, detail: msg.detail });
        break;
      case 'ufile:closed':
        this.dirty = false;
        this._emit('close');
        break;
      default:
        break;
    }
  };

  /** Build the ufile:open message (reading a File or Blob first) and send it once the worker is up. */
  UFileEditor.prototype.open = function (opts) {
    var self = this;
    opts = opts || {};
    var msg = {
      type: 'ufile:open',
      name: opts.name || (opts.file && opts.file.name) || undefined,
      url: opts.url ? new URL(opts.url, location.href).href : undefined,
      new: opts.new,
      engine: opts.engine,
      mode: opts.mode || this.mode,
      allowEdit: opts.allowEdit === undefined ? this.options.allowEdit : opts.allowEdit,
      lang: opts.lang || this.options.lang,
      author: opts.author || this.options.author,
      saveUrl: opts.saveUrl ? new URL(opts.saveUrl, location.href).href : undefined,
      saveMethod: opts.saveMethod,
      saveHeaders: opts.saveHeaders,
      ackSaves: typeof this.options.onSave === 'function',
    };
    var file = opts.file;
    // A copy is sent (and transferred), so the caller's buffer stays usable.
    var bytes = !file
      ? Promise.resolve(null)
      : file instanceof Blob
        ? file.arrayBuffer()
        : file instanceof ArrayBuffer
          ? Promise.resolve(file.slice(0))
          : ArrayBuffer.isView(file)
            ? Promise.resolve(new Uint8Array(file.buffer, file.byteOffset, file.byteLength).slice().buffer)
            : Promise.reject(new Error('UFile: file must be a File, Blob, ArrayBuffer or typed array'));
    return bytes.then(function (buffer) {
      if (buffer) msg.bytes = buffer;
      self.dirty = false;
      if (self.ready) self._send(msg);
      else self._pending = msg;
    });
  };

  UFileEditor.prototype._send = function (msg) {
    this._post(msg, msg.bytes ? [msg.bytes] : []);
  };

  /** Switch between 'view' and 'edit'; unsaved changes are saved first. */
  UFileEditor.prototype.setMode = function (mode) {
    this._post({ type: 'ufile:setMode', mode: mode });
  };

  /** Save, as the Save button does. The file arrives through onSave (or at saveUrl). */
  UFileEditor.prototype.save = function () {
    this._post({ type: 'ufile:save' });
  };

  /** Download the document as last saved. */
  UFileEditor.prototype.download = function () {
    this._post({ type: 'ufile:download' });
  };

  /** Close the document (unsaved changes are dropped). */
  UFileEditor.prototype.close = function () {
    this._post({ type: 'ufile:close' });
  };

  /** Listen to an event: ready, opened, dirty, saved, export, modeChange, error, close. */
  UFileEditor.prototype.on = function (name, fn) {
    (this._handlers[name] = this._handlers[name] || []).push(fn);
    return this;
  };

  /** Remove the iframe and stop listening. */
  UFileEditor.prototype.destroy = function () {
    window.removeEventListener('message', this._onMessage);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    this.iframe.remove();
  };

  global.UFile = {
    version: VERSION,
    mount: function (target, options) {
      return new UFileEditor(target, options);
    },
  };
})(window);
