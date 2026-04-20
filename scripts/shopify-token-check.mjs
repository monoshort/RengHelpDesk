/**
 * Test Admin API (shop.json) met dezelfde volgorde als de app (OAuth met refresh eerst, dan .env).
 * Geen secrets in output. Run vanaf repo-root: node scripts/shopify-token-check.mjs
 */
import '../server/loadEnv.js';
import {
  shopifyCredentialAttempts,
  ensureShopifySessionAccessTokenFresh,
  hydrateShopifySessionFromDatabase,
} from '../server/shopifySession.js';
import { fetchShop, normShopHost } from '../server/shopify.js';

await hydrateShopifySessionFromDatabase();
await ensureShopifySessionAccessTokenFresh();
const attempts = shopifyCredentialAttempts();
const ver = process.env.SHOPIFY_API_VERSION?.trim() || '2025-10';

if (attempts.length === 0) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: 'no_credentials',
      hint: 'Zet SHOPIFY_SHOP_DOMAIN + SHOPIFY_ACCESS_TOKEN in .env, of koppel via /koppel.html (OAuth).',
    })
  );
  process.exit(1);
}

let lastErr = null;
for (const att of attempts) {
  const cfg = { shopDomain: att.shopDomain, accessToken: att.accessToken };
  try {
    const shopInfo = await fetchShop(cfg);
    console.log(
      JSON.stringify({
        ok: true,
        apiVersion: ver,
        shop: normShopHost(cfg.shopDomain),
        shopName: shopInfo?.name ?? null,
        credentialSource: att.source,
      })
    );
    process.exit(0);
  } catch (e) {
    lastErr = e instanceof Error ? e.message : String(e);
  }
}

console.log(
  JSON.stringify({
    ok: false,
    apiVersion: ver,
    shop: normShopHost(attempts[0]?.shopDomain || ''),
    triedSources: attempts.map((a) => a.source),
    message: (lastErr || 'Alle pogingen mislukt').slice(0, 400),
  })
);
process.exit(1);
