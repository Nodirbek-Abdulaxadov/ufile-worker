#!/usr/bin/env node
// UFile server: serves the worker (public/) and, optionally, a small file store the worker can
// open documents from and save them back to (/api/files). No dependencies; Node 18 or newer.
//
//   node server/server.mjs                         # http://127.0.0.1:8080
//   node server/server.mjs --host 0.0.0.0 --port 80 --frame-ancestors "https://intranet.example.com"
//
// Options (or environment variables):
//   --host HOST               UFILE_HOST       address to listen on            (127.0.0.1)
//   --port PORT               UFILE_PORT       port                            (8080)
//   --root DIR                UFILE_ROOT       the site                        (public/)
//   --storage DIR             UFILE_STORAGE    the file store                  (storage/)
//   --no-storage              UFILE_STORAGE=off  no /api/files at all
//   --max-upload-mb N         UFILE_MAX_UPLOAD_MB  largest save accepted      (300)
//   --frame-ancestors LIST    UFILE_FRAME_ANCESTORS  pages that may embed the worker, space
//                             separated CSP sources ("*" by default; "'self'" is always added)
//   --cors ORIGINS            UFILE_CORS       origins (comma separated) that may call /api/files
//                             from their own pages ("" by default: only the worker's own)
//   --embed-only              UFILE_EMBED_ONLY=1  serve the worker only inside an <iframe> (the SDK's
//                             index.html?embed=1): no landing page, no demo, no page opened in a tab
//
// Sign-in (environment only): UFILE_OIDC_ISSUER, UFILE_OIDC_CLIENT_ID and UFILE_PUBLIC_URL make
// every page and file need an OpenID Connect sign-in; the rest is in server/auth.mjs.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createAuth } from './auth.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function option(name, env, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return process.env[env] ?? fallback;
}

const HOST = option('host', 'UFILE_HOST', '127.0.0.1');
const PORT = Number(option('port', 'UFILE_PORT', '8080'));
const ROOT = resolve(option('root', 'UFILE_ROOT', join(HERE, '..', 'public')));
const STORAGE_OPT = process.argv.includes('--no-storage') ? 'off' : option('storage', 'UFILE_STORAGE', join(HERE, '..', 'storage'));
const STORAGE = STORAGE_OPT === 'off' ? null : resolve(STORAGE_OPT);
const MAX_UPLOAD = Number(option('max-upload-mb', 'UFILE_MAX_UPLOAD_MB', '300')) * 1048576;
const FRAME_ANCESTORS = option('frame-ancestors', 'UFILE_FRAME_ANCESTORS', '*').trim() || '*';
const CORS = new Set(
  option('cors', 'UFILE_CORS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const EMBED_ONLY = process.argv.includes('--embed-only') || ['1', 'true'].includes(String(process.env.UFILE_EMBED_ONLY).toLowerCase());
let AUTH;
try {
  AUTH = createAuth();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Documents the store keeps (what the engines open).
const STORED = new Set([
  'pdf', 'docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'odt', 'rtf', 'txt', 'md', 'html', 'htm',
  'xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv', 'pptx', 'potx', 'ppsx',
]);
const STORED_TYPES = {
  pdf: 'application/pdf',
  docx: TYPES['.docx'],
  xlsx: TYPES['.xlsx'],
  pptx: TYPES['.pptx'],
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.txt', '.md', '.ttf', '.otf']);
const gzipCache = new Map();

function securityHeaders(res, html) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (html) {
    // The engines are framed by the worker, which a page may frame: every ancestor must be allowed.
    const ancestors = FRAME_ANCESTORS === '*' ? '*' : `'self' ${FRAME_ANCESTORS}`;
    res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}

function json(res, status, body, extra) {
  send(res, status, body, 'application/json; charset=utf-8', extra);
}

// ---------------------------------------------------------------------------------------------
// Static files

function cacheControl(path) {
  const rel = path.slice(ROOT.length).split(sep).join('/');
  // Behind a sign-in only the browser keeps a copy, never a shared cache.
  const forever = `${AUTH ? 'private' : 'public'}, max-age=31536000, immutable`;
  // Trunk names the engines' files after their content: they never change.
  if (/^\/engines\/[^/]+\/.+-[0-9a-f]{8,}[^/]*\.(js|wasm|css)$/.test(rel)) return forever;
  // The font pack keeps each font release in a folder named after it (scripts/fetch-fonts.sh).
  if (/^\/fonts\/[^/]+\/[^/]+\.(ttf|otf)$/.test(rel)) return forever;
  return 'no-cache';
}

// --embed-only: a page loads only in a frame. Browsers mark a page opened in a tab with
// Sec-Fetch-Dest: document; the worker's own page also needs the SDK's ?embed=1 (the engines'
// pages, framed by the worker, don't), and the demo is off.
function embeddable(req, path) {
  if (req.headers['sec-fetch-dest'] === 'document') return false;
  const rel = path.slice(ROOT.length).split(sep).join('/');
  if (rel === '/demo.html') return false;
  if (rel === '/index.html') return new URL(req.url, 'http://localhost').searchParams.get('embed') === '1';
  return true;
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'bad path');
  }
  if (rel.includes('\0')) return send(res, 400, 'bad path');
  let path = normalize(join(ROOT, rel));
  if (path !== ROOT && !path.startsWith(ROOT + sep)) return send(res, 403, 'forbidden');
  let info;
  try {
    info = statSync(path);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) return send(res, 301, '', 'text/plain', { Location: `${pathname}/` });
      path = join(path, 'index.html');
      info = statSync(path);
    }
  } catch {
    return send(res, 404, 'not found');
  }
  const ext = extname(path).toLowerCase();
  if (EMBED_ONLY && ext === '.html' && !embeddable(req, path)) return send(res, 404, 'not found');
  const type = TYPES[ext] || 'application/octet-stream';
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl(path), ETag: etag, Vary: 'Accept-Encoding' };
  securityHeaders(res, ext === '.html');
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accept = String(req.headers['accept-encoding'] || '');
  // Precompressed copies (scripts/precompress.mjs) first, then gzip made here for small files.
  for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
    if (!new RegExp(`\\b${enc}\\b`).test(accept) || !existsSync(path + suffix)) continue;
    const zipped = statSync(path + suffix);
    res.writeHead(200, { ...headers, 'Content-Encoding': enc, 'Content-Length': zipped.size });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(path + suffix).pipe(res);
  }
  if (/\bgzip\b/.test(accept) && COMPRESSIBLE.has(ext) && info.size > 1024 && info.size < 8 * 1048576) {
    let cached = gzipCache.get(path);
    if (!cached || cached.etag !== etag) {
      cached = { etag, data: gzipSync(readFileSync(path), { level: 6 }) };
      gzipCache.set(path, cached);
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': cached.data.length });
    return res.end(req.method === 'HEAD' ? undefined : cached.data);
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  return createReadStream(path).pipe(res);
}

// ---------------------------------------------------------------------------------------------
// File store

/** A stored file's path from its URL name, or null when the name isn't acceptable. */
function storedPath(raw) {
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!name || name.length > 200 || name.startsWith('.') || /[\\/\u0000-\u001f\u007f]/.test(name)) return null;
  const ext = extname(name).slice(1).toLowerCase();
  if (!STORED.has(ext)) return null;
  return { name, path: join(STORAGE, name), ext };
}

function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

async function api(req, res, pathname) {
  const origin = req.headers.origin;
  const cors = origin && CORS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Disposition', Vary: 'Origin' }
    : {};
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, X-UFile-Name', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  // A page on another origin may only call the store when --cors names it.
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && !CORS.has(origin)) {
    return json(res, 403, { error: 'origin not allowed' });
  }
  if (pathname === '/api/files' || pathname === '/api/files/') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, cors);
    const files = [];
    for (const name of await readdir(STORAGE)) {
      const ext = extname(name).slice(1).toLowerCase();
      if (name.startsWith('.') || !STORED.has(ext)) continue;
      const s = await stat(join(STORAGE, name));
      if (s.isFile()) files.push({ name, size: s.size, modified: s.mtime.toISOString() });
    }
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return json(res, 200, { files }, cors);
  }
  const target = storedPath(pathname.slice('/api/files/'.length));
  if (!target) return json(res, 400, { error: 'bad file name' }, cors);
  switch (req.method) {
    case 'GET':
    case 'HEAD': {
      let s;
      try {
        s = await stat(target.path);
      } catch {
        return json(res, 404, { error: 'not found' }, cors);
      }
      res.writeHead(200, {
        ...cors,
        'Content-Type': STORED_TYPES[target.ext] || 'application/octet-stream',
        'Content-Length': s.size,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(target.name)}`,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(target.path).pipe(res);
    }
    case 'PUT':
    case 'POST': {
      const body = await readBody(req, MAX_UPLOAD);
      if (!body.length) return json(res, 400, { error: 'empty body' }, cors);
      // Write a copy, then swap it in: a failed save never leaves half a file.
      const tmp = join(STORAGE, `.${target.name}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tmp, body);
      await rename(tmp, target.path);
      return json(res, 200, { name: target.name, size: body.length }, cors);
    }
    case 'DELETE':
      await rm(target.path, { force: true });
      return json(res, 200, { name: target.name, deleted: true }, cors);
    default:
      return json(res, 405, { error: 'method not allowed' }, cors);
  }
}

// ---------------------------------------------------------------------------------------------

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error(`no index.html in ${ROOT}`);
  process.exit(1);
}
if (STORAGE) mkdirSync(STORAGE, { recursive: true });

const server = createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.UFILE_QUIET !== '1') console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  });
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (pathname === '/healthz') return send(res, 200, 'ok');
    if (AUTH) {
      if (pathname.startsWith('/auth/')) return await AUTH.route(req, res, url);
      if (!AUTH.user(req)) return AUTH.challenge(req, res, url);
    }
    if (pathname === '/api/files' || pathname.startsWith('/api/files/')) {
      if (!STORAGE) return json(res, 404, { error: 'the file store is off' });
      return await api(req, res, pathname);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UFile: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/  (site: ${ROOT}${STORAGE ? `, files: ${STORAGE}` : ''}${EMBED_ONLY ? ', embed only' : ''}${AUTH ? `, sign-in: ${AUTH.issuer}` : ''})`);
});
