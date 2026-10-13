// The document engines the worker hosts (each a Craft app built for the browser, in
// engines/<id>/ on this origin) and how files map to them.

export const ENGINES = {
  pdf: {
    id: 'pdf',
    prefix: 'pdfcraft',
    dir: 'engines/pdf/',
    name: 'PDF',
    app: 'PdfCraft',
    exts: ['pdf'],
    // What a save of a document in another format comes back as.
    native: 'pdf',
    badge: 'PDF',
  },
  word: {
    id: 'word',
    prefix: 'wordcraft',
    dir: 'engines/word/',
    name: 'Word',
    app: 'WordCraft',
    exts: ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'odt', 'rtf', 'txt', 'md', 'html', 'htm'],
    native: 'docx',
    badge: 'DOC',
  },
  excel: {
    id: 'excel',
    prefix: 'gridcraft',
    dir: 'engines/excel/',
    name: 'Excel',
    app: 'GridCraft',
    exts: ['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv'],
    native: 'xlsx',
    badge: 'XLS',
  },
  slides: {
    id: 'slides',
    prefix: 'deckcraft',
    dir: 'engines/slides/',
    name: 'PowerPoint',
    app: 'DeckCraft',
    exts: ['pptx', 'potx', 'ppsx'],
    native: 'pptx',
    badge: 'PPT',
  },
};

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  dotm: 'application/vnd.ms-word.template.macroEnabled.12',
  doc: 'application/msword',
  dot: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
};

/** Every extension some engine opens, for the file picker. */
export const ACCEPT = Object.values(ENGINES)
  .flatMap((e) => e.exts)
  .map((ext) => `.${ext}`)
  .join(',');

/** A file name's stem and lower-case extension (`''` when it has none). */
export function splitName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return { stem: base, ext: '' };
  return { stem: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() };
}

export function mimeFor(name) {
  return MIME[splitName(name).ext] || 'application/octet-stream';
}

export function engineForName(name) {
  const { ext } = splitName(name);
  return ext ? Object.values(ENGINES).find((e) => e.exts.includes(ext)) || null : null;
}

export function engineForMime(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  const ext = Object.keys(MIME).find((k) => MIME[k] === type);
  return ext ? engineForName(`x.${ext}`) : null;
}

/** The engine for a file by its content: a PDF, or an OOXML / OpenDocument ZIP package. */
export function engineForBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
  const at = (i, s) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  // A PDF may have junk before its header; readers look in the first kilobyte.
  for (let i = 0; i < Math.min(1024, bytes.length - 5); i++) {
    if (bytes[i] === 0x25 && at(i, '%PDF-')) return ENGINES.pdf;
  }
  if (!at(0, 'PK')) return null;
  const names = zipEntryNames(bytes);
  if (names.some((n) => n.startsWith('word/'))) return ENGINES.word;
  if (names.some((n) => n.startsWith('xl/'))) return ENGINES.excel;
  if (names.some((n) => n.startsWith('ppt/'))) return ENGINES.slides;
  // OpenDocument: the `mimetype` entry comes first, stored uncompressed.
  const head = new TextDecoder().decode(bytes.subarray(0, 120));
  if (head.includes('opendocument.text')) return ENGINES.word;
  if (head.includes('opendocument.spreadsheet')) return ENGINES.excel;
  return null;
}

/** The entry names in a ZIP file's central directory (empty when it can't be read). */
export function zipEntryNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  // The end-of-central-directory record is within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count && n < 5000; n++) {
    if (p + 46 > len || view.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > len) break;
    names.push(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Whether a file the engine hands back (`saved`) is a save of the open document (`opened`) or
 * an export of it. A save keeps the document's name, in its own format or in the engine's
 * native one (a .csv saves as .xlsx, a .doc as .docx); anything else is an export (a PDF of
 * a sheet, the pictures of slides…).
 */
export function isDocumentSave(opened, saved, engine) {
  const a = splitName(opened);
  const b = splitName(saved);
  if (a.stem.toLowerCase() !== b.stem.toLowerCase()) return false;
  return b.ext === a.ext || b.ext === engine.native;
}
