// Precompress an engine's files (.wasm, .js, .css, .html, .json, .svg) or the font pack's
// (.ttf, .otf) next to them as .br and .gz, so the server can send them compressed without
// compressing on every request.
//
//   node scripts/precompress.mjs public/engines/word
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const COMPRESSIBLE = new Set(['.wasm', '.js', '.mjs', '.css', '.html', '.json', '.svg', '.ttf', '.otf']);
const MIN_BYTES = 1024;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/precompress.mjs <dir>');
  process.exit(2);
}

for (const path of files(dir)) {
  if (!COMPRESSIBLE.has(extname(path))) continue;
  const data = readFileSync(path);
  if (data.length < MIN_BYTES) continue;
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = gzipSync(data, { level: 9 });
  if (br.length < data.length) writeFileSync(`${path}.br`, br);
  if (gz.length < data.length) writeFileSync(`${path}.gz`, gz);
  const mb = (n) => (n / 1048576).toFixed(2);
  console.log(`  ${path.slice(dir.length + 1)}: ${mb(data.length)} MB → br ${mb(br.length)} MB, gz ${mb(gz.length)} MB`);
}
