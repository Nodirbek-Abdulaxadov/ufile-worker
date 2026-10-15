// Sign-in with an OpenID Connect provider. With UFILE_OIDC_ISSUER set, every page, file and API
// call needs a session: /auth/login starts one (Authorization Code + PKCE), /auth/callback
// finishes it, /auth/logout ends it (and the provider's), /auth/me says who is signed in. The
// session is a signed cookie; the server keeps nothing.
//
//   UFILE_OIDC_ISSUER         the provider, e.g. https://platform.musanna.uz
//   UFILE_OIDC_CLIENT_ID      this site's client
//   UFILE_OIDC_CLIENT_SECRET  its secret, for a confidential client (a public one has PKCE alone)
//   UFILE_OIDC_SCOPES         what to ask for                              ("openid profile")
//   UFILE_PUBLIC_URL          the address people open, e.g. https://docs.musanna.uz; the provider
//                             sends them back to <it>/auth/callback
//   UFILE_SESSION_SECRET      the key sessions are signed with (unset: a random one per start, so a
//                             restart signs everyone out)
//   UFILE_SESSION_HOURS       how long a sign-in lasts                     (12)
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION = 'ufile_session';
// One cookie per sign-in under way (keyed by its state), so two tabs signing in don't collide.
const FLOW = 'ufile_oidc_';
const FLOW_SECONDS = 600;

const now = () => Math.floor(Date.now() / 1000);
const random = (bytes) => randomBytes(bytes).toString('base64url');

/** The sign-in configured by `env`, or null when UFILE_OIDC_ISSUER is unset. */
export function createAuth(env = process.env) {
  const issuer = (env.UFILE_OIDC_ISSUER || '').trim();
  if (!issuer) return null;
  const clientId = (env.UFILE_OIDC_CLIENT_ID || '').trim();
  const publicUrl = (env.UFILE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!clientId) throw new Error('UFILE_OIDC_ISSUER is set but UFILE_OIDC_CLIENT_ID is not');
  if (!/^https?:\/\/[^/]/.test(publicUrl)) throw new Error('UFILE_OIDC_ISSUER is set but UFILE_PUBLIC_URL (https://…) is not');
  if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(issuer)) {
    throw new Error('UFILE_OIDC_ISSUER must be an https:// address');
  }
  const clientSecret = env.UFILE_OIDC_CLIENT_SECRET || '';
  const scopes = (env.UFILE_OIDC_SCOPES || 'openid profile').trim();
  const hours = Number(env.UFILE_SESSION_HOURS || 12);
  if (!(hours > 0)) throw new Error('UFILE_SESSION_HOURS must be a positive number');
  let key = env.UFILE_SESSION_SECRET || '';
  if (!key) {
    key = random(32);
    console.warn('UFILE_SESSION_SECRET is unset: sessions end when the server restarts');
  }
  const redirectUri = `${publicUrl}/auth/callback`;
  const secure = publicUrl.startsWith('https://');

  // The provider's endpoints, read once (and again after a failure).
  let discovery = null;
  async function provider() {
    if (discovery) return discovery;
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const d = await r.json();
    for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint']) {
      if (typeof d[k] !== 'string') throw new Error(`${url}: no ${k}`);
    }
    discovery = d;
    return d;
  }

  const mac = (body) => createHmac('sha256', key).update(body).digest('base64url');
  const sign = (value) => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${mac(body)}`;
  };
  function unsign(token) {
    if (typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const wanted = Buffer.from(mac(body));
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  function cookies(req) {
    const out = new Map();
    for (const part of String(req.headers.cookie || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return out;
  }
  const cookie = (name, value, path, maxAge) =>
    `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  /** Where to go after signing in: a path on this site, never another site. */
  const safeNext = (next) =>
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && !next.startsWith('/auth/')
      ? next
      : '/';

  function redirect(res, location, setCookies = []) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}) });
    res.end();
  }

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    res.end(data);
  }

  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  /** A page saying sign-in failed, with a way to try again. */
  function failed(res, status, detail) {
    const html = `<!doctype html><html lang="uz"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>UFile</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1b1f24}
p.d{color:#5d6772;font-size:14px}a{color:#3657d6}@media(prefers-color-scheme:dark){body{background:#15181c;color:#e8eaed}p.d{color:#9aa3ad}a{color:#8ea4ff}}</style>
<h1>Kirish amalga oshmadi</h1><p>Sign-in failed. <a href="${escape(publicUrl)}/auth/login">Qayta urinish / Try again</a></p><p class="d">${escape(detail)}</p></html>`;
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
  }

  /** The signed-in person ({ sub, name, exp }), or null. */
  function user(req) {
    const s = unsign(cookies(req).get(SESSION));
    return s && typeof s.sub === 'string' && typeof s.exp === 'number' && s.exp > now() ? s : null;
  }

  /**
   * A request without a session: a page opened in the browser goes to sign in and comes back,
   * anything else (files, the engines' requests, the API) is refused.
   */
  function challenge(req, res, url) {
    const dest = req.headers['sec-fetch-dest'];
    const page = req.method === 'GET' && (dest === 'document' || (!dest && /text\/html/.test(String(req.headers.accept || ''))));
    if (page) return redirect(res, `${publicUrl}/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return json(res, 401, { error: 'sign in first' });
  }

  async function login(res, url) {
    const d = await provider();
    const state = random(24);
    const nonce = random(24);
    const verifier = random(32);
    const flow = sign({ s: state, n: nonce, v: verifier, r: safeNext(url.searchParams.get('next')), t: now() });
    const target = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) {
      target.searchParams.set(k, v);
    }
    redirect(res, target.href, [cookie(`${FLOW}${state.slice(0, 12)}`, flow, '/auth/', FLOW_SECONDS)]);
  }

  async function callback(res, req, url) {
    const q = url.searchParams;
    const state = q.get('state') || '';
    const flowCookie = `${FLOW}${state.slice(0, 12)}`;
    const flow = unsign(cookies(req).get(flowCookie));
    res.setHeader('Set-Cookie', [cookie(flowCookie, '', '/auth/', 0)]);
    if (q.get('error')) return failed(res, 401, q.get('error_description') || q.get('error'));
    if (!flow || flow.s !== state || now() - flow.t > FLOW_SECONDS) return failed(res, 400, 'the sign-in expired or was started elsewhere');
    const code = q.get('code');
    if (!code) return failed(res, 400, 'no authorization code');

    const d = await provider();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: flow.v });
    if (clientSecret) body.set('client_secret', clientSecret);
    const r = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = await r.json().catch(() => ({}));
    if (!r.ok || typeof tokens.id_token !== 'string') {
      return failed(res, 502, tokens.error_description || tokens.error || `token endpoint: HTTP ${r.status}`);
    }
    // The ID token came straight from the token endpoint over TLS, which stands in for checking
    // its signature (OpenID Connect Core 1.0, 3.1.3.7 step 6); its claims are checked as usual.
    let claims;
    try {
      claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1] || '', 'base64url').toString('utf8'));
    } catch {
      return failed(res, 502, 'the ID token is unreadable');
    }
    const aud = [].concat(claims.aud ?? []);
    const problem =
      claims.iss !== d.issuer ? 'wrong issuer'
      : !aud.includes(clientId) ? 'wrong audience'
      : aud.length > 1 && claims.azp !== clientId ? 'wrong authorized party'
      : !(claims.exp > now() - 60) ? 'expired'
      : claims.nonce !== flow.n ? 'wrong nonce'
      : typeof claims.sub !== 'string' || !claims.sub ? 'no subject'
      : '';
    if (problem) return failed(res, 502, `ID token: ${problem}`);

    const name =
      [claims.name, [claims.given_name, claims.family_name].filter(Boolean).join(' '), claims.preferred_username, claims.email, claims.phone_number]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .find(Boolean) || '';
    const session = sign({ sub: claims.sub, name: name.slice(0, 200), exp: now() + Math.round(hours * 3600) });
    redirect(res, `${publicUrl}${flow.r}`, [cookie(flowCookie, '', '/auth/', 0), cookie(SESSION, session, '/', Math.round(hours * 3600))]);
  }

  /** End the session here, then at the provider, which sends people back to the start page. */
  async function logout(res) {
    let target = `${publicUrl}/`;
    try {
      const d = await provider();
      if (typeof d.end_session_endpoint === 'string') {
        const u = new URL(d.end_session_endpoint);
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('post_logout_redirect_uri', `${publicUrl}/`);
        target = u.href;
      }
    } catch (e) {
      console.error('sign-out at the provider:', e.message);
    }
    redirect(res, target, [cookie(SESSION, '', '/', 0)]);
  }

  /** Handle /auth/*; anything else there is not found. */
  async function route(req, res, url) {
    try {
      switch (url.pathname) {
        case '/auth/login':
          return await login(res, url);
        case '/auth/callback':
          return await callback(res, req, url);
        case '/auth/logout':
          return await logout(res);
        case '/auth/me': {
          const u = user(req);
          return u ? json(res, 200, { name: u.name, sub: u.sub }) : json(res, 401, { error: 'sign in first' });
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      console.error(`${url.pathname}:`, e);
      if (!res.headersSent) failed(res, 502, `the sign-in provider is unavailable (${e.message})`);
    }
  }

  return { issuer, publicUrl, user, challenge, route };
}
