import crypto from 'crypto';

const COOKIE_NAME = 'reng_dashboard';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function getDashboardPassword() {
  return process.env.DASHBOARD_PASSWORD?.trim() || 'RengTod123!';
}

function sessionSecret() {
  const env = process.env.DASHBOARD_SESSION_SECRET?.trim();
  if (env) return env;
  return crypto
    .createHash('sha256')
    .update(getDashboardPassword() + '|reng-dashboard-session-v1')
    .digest('hex');
}

/**
 * @param {string} cookieHeader
 */
export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    out[k] = v;
  }
  return out;
}

/**
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqualString(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    try {
      crypto.timingSafeEqual(ba, ba);
    } catch {
      /* length mismatch */
    }
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function signDashboardSession() {
  const exp = Date.now() + MAX_AGE_MS;
  const sid = crypto.randomBytes(24).toString('hex');
  const payload = JSON.stringify({ exp, v: 2, sid });
  const body = Buffer.from(payload, 'utf8');
  const sig = crypto
    .createHmac('sha256', sessionSecret())
    .update(body)
    .digest('base64url');
  const bodyB64 = body.toString('base64url');
  return `${bodyB64}.${sig}`;
}

/**
 * @param {string | undefined} token
 * @returns {{ exp: number; v: number; sid: string } | null}
 */
export function parseDashboardSessionClaimsFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const bodyB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const body = Buffer.from(bodyB64, 'base64url');
    const expected = crypto
      .createHmac('sha256', sessionSecret())
      .update(body)
      .digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const j = JSON.parse(body.toString('utf8'));
    if (typeof j.exp !== 'number' || j.exp < Date.now()) return null;
    if (j.v !== 2 || typeof j.sid !== 'string' || !/^[a-f0-9]{48}$/i.test(j.sid)) return null;
    return { exp: j.exp, v: 2, sid: j.sid.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} token
 */
export function verifyDashboardSession(token) {
  return parseDashboardSessionClaimsFromToken(token) !== null;
}

/**
 * @param {import('express').Request} req
 * @returns {string | null}
 */
export function getDashboardSessionId(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return parseDashboardSessionClaimsFromToken(cookies[COOKIE_NAME])?.sid ?? null;
}

/**
 * @param {import('express').Request} req
 */
export function isDashboardSessionValid(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return parseDashboardSessionClaimsFromToken(cookies[COOKIE_NAME]) !== null;
}

/**
 * `Secure`-vlag alleen op echte HTTPS (of proxy `x-forwarded-proto: https`).
 * Zo werkt lokaal `http://localhost` nog als `DASHBOARD_COOKIE_SECURE=true` in .env staat (bv. gekopieerd van Render).
 * @param {import('express').Request} req
 */
function shouldUseSecureSessionCookie(req) {
  if (process.env.DASHBOARD_COOKIE_SECURE !== 'true') return false;
  if (req.secure) return true;
  const raw = req.headers['x-forwarded-proto'];
  const first = typeof raw === 'string' ? raw.split(',')[0].trim().toLowerCase() : '';
  return first === 'https';
}

/**
 * @param {import('express').Express} app
 */
export function mountDashboardAuthRoutes(app) {
  app.post('/api/dashboard/login', (req, res) => {
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!timingSafeEqualString(pw, getDashboardPassword())) {
      return res.status(401).json({ error: 'Onjuist wachtwoord' });
    }
    const token = signDashboardSession();
    const maxAgeSec = Math.floor(MAX_AGE_MS / 1000);
    const secure = shouldUseSecureSessionCookie(req);
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (secure) flags.push('Secure');
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; ${flags.join('; ')}`
    );
    return res.json({ ok: true });
  });

  app.post('/api/dashboard/logout', (req, res) => {
    const secure = shouldUseSecureSessionCookie(req);
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) flags.push('Secure');
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${flags.join('; ')}`);
    return res.json({ ok: true });
  });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function dashboardAuthMiddleware(req, res, next) {
  const path = req.path || '/';
  const publicAuth =
    path === '/api/auth/callback' ||
    path === '/api/auth/gmail/callback' ||
    path === '/api/auth/gmail/redirect-uri';
  if (
    path === '/login.html' ||
    path === '/api/dashboard/login' ||
    path === '/api/health' ||
    path === '/api/shopify/ping' ||
    publicAuth
  ) {
    return next();
  }
  if (isDashboardSessionValid(req)) {
    req.dashboardSid = getDashboardSessionId(req);
    return next();
  }
  if (path.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(401).json({ error: 'Niet ingelogd', loginRequired: true });
  }
  const nextPath = req.originalUrl || '/';
  const loginUrl =
    '/login.html?next=' + encodeURIComponent(nextPath === '/login.html' ? '/' : nextPath);
  return res.redirect(302, loginUrl);
}
