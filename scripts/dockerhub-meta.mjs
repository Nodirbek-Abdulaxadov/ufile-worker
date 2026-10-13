// Fill in the image's Docker Hub page: the short description and categories from docker/hub.json,
// and the repository overview from docker/README.md.
//
//   node scripts/dockerhub-meta.mjs
//
// It signs in with the account `docker login` saved in ~/.docker/config.json (a personal access
// token works); the token is never printed. Needs Node 18 or newer.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HUB = 'https://hub.docker.com/v2';

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(ROOT, 'docker/hub.json'), 'utf8'));
const overview = readFileSync(join(ROOT, 'docker/README.md'), 'utf8');
if (meta.description.length > 100) die(`docker/hub.json: the description is ${meta.description.length} characters; Docker Hub allows 100`);
if (overview.length > 25000) die(`docker/README.md is ${overview.length} characters; Docker Hub allows 25000`);

const config = JSON.parse(readFileSync(join(homedir(), '.docker/config.json'), 'utf8'));
const saved = config.auths?.['https://index.docker.io/v1/']?.auth;
if (!saved) die('no Docker Hub login in ~/.docker/config.json (docker login first; credential stores are not read)');
const decoded = Buffer.from(saved, 'base64').toString('utf8');
const colon = decoded.indexOf(':');
const username = decoded.slice(0, colon);
const secret = decoded.slice(colon + 1);

async function call(method, path, body, token) {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const { token } = await call('POST', '/users/login/', { username, password: secret });
if (!token) die('Docker Hub gave no session token');

const repo = `/repositories/${meta.repository}/`;
await call('PATCH', repo, { description: meta.description, full_description: overview }, token);
console.log(`${meta.repository}: description and overview updated`);

const all = await call('GET', '/categories/');
const known = new Map((Array.isArray(all) ? all : all.results || []).map((c) => [c.slug, c]));
const categories = meta.categories.map((slug) => known.get(slug) || die(`unknown Docker Hub category: ${slug}`));
await call('PATCH', `${repo}categories/`, categories.map(({ name, slug }) => ({ name, slug })), token);

const page = await call('GET', repo);
console.log(`categories: ${(page.categories || []).map((c) => c.name).join(', ') || '(none)'}`);
console.log(`https://hub.docker.com/r/${meta.repository}`);
