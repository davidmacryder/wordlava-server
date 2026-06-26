/* wordlava-auth.js — Word Lava authentication service (deploy on Railway)
 * Verifies Google / Microsoft / Apple ID tokens and issues a Word Lava session JWT.
 * Only dependency: jose.  Start: `node wordlava-auth.js`  (Railway provides PORT).
 *
 * Required env vars:
 *   SESSION_JWT_SECRET  long random string — MUST match the one on your stats/relay/matchmaker
 *   GOOGLE_CLIENT_ID    the OAuth client ID the Google ID token is issued for (its `aud`)
 *   MS_CLIENT_ID        your Microsoft Entra Application (client) ID
 *   APPLE_CLIENT_ID     your Apple Services ID (Android/Web) and/or bundle ID (iOS), comma-separated
 *   SESSION_TTL         optional, default 30d
 */
const http = require('http');
const { createRemoteJWKSet, jwtVerify, SignJWT, errors } = require('jose');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = new TextEncoder().encode(
  process.env.SESSION_JWT_SECRET || 'dev-only-change-me-to-a-long-random-secret'
);
const SESSION_TTL = process.env.SESSION_TTL || '30d';
const audList = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Each provider: where to fetch its public signing keys, the issuer to require, and the
// audience(s) (your client/app IDs) the token must be addressed to.
const PROVIDERS = {
  google: {
    jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: audList(process.env.GOOGLE_CLIENT_ID),
  },
  microsoft: {
    jwks: createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys')),
    issuer: null, // multi-tenant: the issuer carries the tenant id, validated by regex below
    audience: audList(process.env.MS_CLIENT_ID),
  },
  apple: {
    jwks: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
    issuer: 'https://appleid.apple.com',
    audience: audList(process.env.APPLE_CLIENT_ID),
  },
};

async function verifyIdToken(provider, idToken) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error('unknown_provider');
  if (!cfg.audience.length) throw new Error(provider + '_not_configured'); // forgot the *_CLIENT_ID env var
  const opts = { audience: cfg.audience };
  if (cfg.issuer) opts.issuer = cfg.issuer;
  const { payload } = await jwtVerify(idToken, cfg.jwks, opts); // throws if signature/exp/aud/iss is wrong
  if (provider === 'microsoft') {
    const ok = typeof payload.iss === 'string' &&
      /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(payload.iss);
    if (!ok) throw new Error('bad_ms_issuer');
  }
  return {
    provider,
    uid: provider + ':' + payload.sub,                 // stable, namespaced user id
    email: payload.email || payload.preferred_username || '',
    name: payload.name || '',
  };
}

async function issueSession(user) {
  return new SignJWT({ provider: user.provider, email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.uid)
    .setIssuedAt()
    .setIssuer('wordlava-auth')
    .setAudience('wordlava')
    .setExpirationTime(SESSION_TTL)
    .sign(SESSION_SECRET);
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });

  const m = req.method === 'POST' && req.url.match(/^\/auth\/(google|microsoft|apple)$/);
  if (!m) return send(res, 404, { error: 'not_found' });
  const provider = m[1];

  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const { idToken } = JSON.parse(data || '{}');
      if (!idToken) return send(res, 400, { error: 'missing_idToken' });
      const user = await verifyIdToken(provider, idToken);
      // ---- TODO (Part F): upsert `user.uid` into your Railway Postgres here ----
      const session = await issueSession(user);
      send(res, 200, {
        session, // <- your own session token; the app stores this and sends it to stats/relay
        profile: { uid: user.uid, name: user.name, email: user.email, provider },
      });
    } catch (e) {
      const isAuth = (e instanceof errors.JOSEError) || /idToken|provider|issuer|configured/.test(e.message);
      send(res, isAuth ? 401 : 500, { error: 'auth_failed', detail: e.message });
    }
  });
});
server.listen(PORT, () => console.log('wordlava-auth listening on :' + PORT));
