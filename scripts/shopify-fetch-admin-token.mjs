/**
 * Haalt een nieuwe Admin API access token via Client Credentials Grant (Custom app)
 * en zet SHOPIFY_ACCESS_TOKEN in .env (regel vervangen). Daarna: npm run vercel:env:shopify + deploy.
 *
 * Vereist: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET in .env
 *
 * Gebruik: node scripts/shopify-fetch-admin-token.mjs
 */
import '../server/loadEnv.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exchangeShopifyClientCredentials } from '../server/shopifyClientCredentials.js';
import { fetchShop } from '../server/shopify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

const shopInput = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

if (!shopInput || !clientId || !clientSecret) {
  console.error('Vul SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID en SHOPIFY_CLIENT_SECRET in .env');
  process.exit(1);
}

const { shop, data } = await exchangeShopifyClientCredentials({
  shopInput,
  clientId,
  clientSecret,
});

const newToken = String(data.access_token || '').trim();
if (!newToken) {
  console.error('Shopify gaf geen access_token.');
  process.exit(1);
}

let raw = fs.readFileSync(envPath, 'utf8');
if (/^SHOPIFY_ACCESS_TOKEN=/m.test(raw)) {
  raw = raw.replace(/^SHOPIFY_ACCESS_TOKEN=.*$/m, `SHOPIFY_ACCESS_TOKEN=${newToken}`);
} else {
  raw += `\nSHOPIFY_ACCESS_TOKEN=${newToken}\n`;
}
fs.writeFileSync(envPath, raw, 'utf8');

const cfg = { shopDomain: shop, accessToken: newToken };
let shopName = null;
let verifyNote = '';
try {
  shopName = (await fetchShop(cfg))?.name ?? null;
} catch (e) {
  verifyNote =
    ' (shop.json-test overgeslagen: ' +
    (e instanceof Error ? e.message.slice(0, 120) : String(e)) +
    ' — token staat wél in .env; probeer zo opnieuw bij 429.)';
}

const masked = newToken.length > 10 ? `${newToken.slice(0, 7)}…${newToken.slice(-4)}` : '…';

console.log(
  JSON.stringify({
    ok: true,
    shop,
    shopName,
    tokenMasked: masked,
    note: '.env bijgewerkt. Daarna: npm run vercel:env:shopify && npm run deploy:vercel' + verifyNote,
  })
);
