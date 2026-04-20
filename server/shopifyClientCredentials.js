import { normalizeShop } from './shopifySession.js';

/**
 * Shopify Admin API: Client Credentials Grant (Custom app).
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials
 * @param {{ shopInput: string; clientId: string; clientSecret: string }}
 */
export async function exchangeShopifyClientCredentials({ shopInput, clientId, clientSecret }) {
  const shop = normalizeShop(shopInput || '');
  if (!shop) {
    throw new Error('Ongeldig shop-domein. Gebruik bijv. toddie-nl of toddie-nl.myshopify.com.');
  }
  const cid = String(clientId || '').trim();
  const sec = String(clientSecret || '').trim();
  if (!cid || !sec) {
    throw new Error('SHOPIFY_CLIENT_ID en SHOPIFY_CLIENT_SECRET ontbreken in .env.');
  }

  const url = `https://${shop}/admin/oauth/access_token`;
  const jsonBody = JSON.stringify({
    client_id: cid,
    client_secret: sec,
    grant_type: 'client_credentials',
  });

  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: jsonBody,
  });
  let data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: sec,
        grant_type: 'client_credentials',
      }).toString(),
    });
    data = await res.json().catch(() => ({}));
  }

  if (!res.ok || !data.access_token) {
    const msg =
      (data && (data.error_description || data.error)) ||
      (await res.text().catch(() => '')) ||
      `HTTP ${res.status}`;
    throw new Error(String(msg).trim().slice(0, 500) || 'Geen access_token van Shopify.');
  }

  return { shop, data };
}
