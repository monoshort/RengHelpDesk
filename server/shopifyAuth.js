import crypto from 'crypto';
import { parseCookies } from './dashboardAuth.js';
import { normalizeShop, writeShopifySession } from './shopifySession.js';

const OAUTH_COOKIE = 'reng_oauth';
const OAUTH_MAX_AGE_SEC = 15 * 60;

/**
 * @param {import('express').Request} req
 */
function oauthCookieSecure(req) {
  if (process.env.DASHBOARD_COOKIE_SECURE === 'true') {
    if (req.secure) return true;
    const raw = req.headers['x-forwarded-proto'];
    const first = typeof raw === 'string' ? raw.split(',')[0].trim().toLowerCase() : '';
    return first === 'https';
  }
  return (
    Boolean(req.secure) ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase() === 'https'
  );
}

/**
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 * @param {{ state: string; shop: string; at: number }} payload
 */
function setOauthPendingCookie(res, req, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const flags = ['Path=/', 'HttpOnly', `SameSite=Lax`, `Max-Age=${OAUTH_MAX_AGE_SEC}`];
  if (oauthCookieSecure(req)) flags.push('Secure');
  res.append('Set-Cookie', `${OAUTH_COOKIE}=${encodeURIComponent(body)}; ${flags.join('; ')}`);
}

/**
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 */
function clearOauthPendingCookie(res, req) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (oauthCookieSecure(req)) flags.push('Secure');
  res.append('Set-Cookie', `${OAUTH_COOKIE}=; ${flags.join('; ')}`);
}

/**
 * @param {Record<string, unknown>} query
 * @param {string} secret
 */
function queryValue(q, key) {
  const v = q[key];
  if (v == null) return '';
  return Array.isArray(v) ? String(v[0]) : String(v);
}

function verifyOAuthHmac(query, secret) {
  if (String(process.env.OAUTH_SKIP_HMAC_VERIFY).toLowerCase() === 'true') {
    return true;
  }
  const hmac = queryValue(query, 'hmac');
  if (!hmac || !secret) return false;
  const keys = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort();
  const message = keys.map((k) => `${k}=${queryValue(query, k)}`).join('&');
  const generatedHash = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedHash, 'utf8'),
      Buffer.from(hmac, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ port: number }} opts
 */
export function mountShopifyAuth(app, opts) {
  const defaultRedirect =
    process.env.SHOPIFY_REDIRECT_URI?.trim() ||
    `http://localhost:${opts.port}/api/auth/callback`;

  app.get('/api/auth/install', (req, res) => {
    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    const shop = normalizeShop(
      typeof req.query.shop === 'string' ? req.query.shop : ''
    );
    if (!clientId || !clientSecret) {
      return res.status(400).send(
        'Zet SHOPIFY_CLIENT_ID en SHOPIFY_CLIENT_SECRET in .env (je Shopify app).'
      );
    }
    if (!shop) {
      return res.status(400).send(
        'Geef een geldige shop op, bv. jouwshop of jouwshop.myshopify.com (query ?shop=).'
      );
    }
    const redirectUri = defaultRedirect;
    const scopes =
      process.env.SHOPIFY_SCOPES?.trim() ||
      'read_orders,read_customers,read_products';
    const state = crypto.randomBytes(20).toString('hex');
    setOauthPendingCookie(res, req, { state, shop, at: Date.now() });
    const url =
      `https://${shop}/admin/oauth/authorize?` +
      new URLSearchParams({
        client_id: clientId,
        scope: scopes,
        redirect_uri: redirectUri,
        state,
      }).toString();
    res.redirect(302, url);
  });

  app.get('/api/auth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const shopQ = typeof req.query.shop === 'string' ? req.query.shop : '';
    const shop = normalizeShop(shopQ);
    let pending = null;
    try {
      const raw = parseCookies(req.headers.cookie || '')[OAUTH_COOKIE];
      if (raw) {
        const decoded = Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8');
        pending = JSON.parse(decoded);
      }
    } catch {
      pending = null;
    }
    const pendingOk =
      pending &&
      typeof pending.state === 'string' &&
      pending.state === state &&
      normalizeShop(String(pending.shop || '')) === shop &&
      typeof pending.at === 'number' &&
      Date.now() - pending.at < OAUTH_MAX_AGE_SEC * 1000;

    if (!code || !state || !shop || !pendingOk) {
      clearOauthPendingCookie(res, req);
      return res.status(400).send(
        'Ongeldige OAuth-response. Probeer opnieuw via /koppel.html. Controleer of de redirect-URL in je Shopify-app exact overeenkomt met SHOPIFY_REDIRECT_URI (standaard: ' +
          defaultRedirect +
          '). Op serverless (Vercel): cookies aan, zelfde browser als bij start koppelen.'
      );
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

    if (!verifyOAuthHmac(req.query, clientSecret || '')) {
      clearOauthPendingCookie(res, req);
      return res.status(400).send('HMAC-validatie mislukt (query gemanipuleerd of verkeerde app secret).');
    }

    clearOauthPendingCookie(res, req);

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: defaultRedirect,
      }),
    });

    const data = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !data.access_token) {
      const msg =
        data.error_description ||
        data.error ||
        (await tokenRes.text().catch(() => '')) ||
        'Geen access_token';
      return res
        .status(400)
        .send(`Token-uitwisseling mislukt: ${msg}. Controleer client id/secret en redirect-URL.`);
    }

    writeShopifySession(shop, data.access_token);
    res.redirect(302, '/?gekoppeld=1');
  });
}
