import crypto from 'crypto';
import { normalizeShop, writeShopifySession } from './shopifySession.js';

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

/** @type {Map<string, { shop: string; at: number }>} */
const oauthStates = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (now - v.at > 15 * 60 * 1000) oauthStates.delete(k);
  }
}, 60 * 1000);

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
    oauthStates.set(state, { shop, at: Date.now() });
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
    const pending = oauthStates.get(state);

    if (!code || !state || !shop || !pending || pending.shop !== shop) {
      oauthStates.delete(state);
      return res.status(400).send(
        'Ongeldige OAuth-response. Probeer opnieuw via /koppel.html. Controleer of de redirect-URL in je Shopify-app exact overeenkomt met SHOPIFY_REDIRECT_URI (standaard: ' +
          defaultRedirect +
          ').'
      );
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

    if (!verifyOAuthHmac(req.query, clientSecret || '')) {
      oauthStates.delete(state);
      return res.status(400).send('HMAC-validatie mislukt (query gemanipuleerd of verkeerde app secret).');
    }

    oauthStates.delete(state);

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
