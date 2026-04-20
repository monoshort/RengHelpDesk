/**
 * Handmatig een nieuwe token in het sessiebestand zetten zonder andere velden te wissen.
 *
 * Gmail (.google_gmail_token.json):
 *   node scripts/merge-token.mjs gmail --access-token "ya29...."
 *   node scripts/merge-token.mjs gmail --refresh-token "1//...."
 *
 * Shopify (.shopify_token.json) — shop moet al in het bestand staan:
 *   node scripts/merge-token.mjs shopify --shop jouwshop.myshopify.com --access-token "shpat_..."
 */
import '../server/loadEnv.js';
import { mergeGmailTokens } from '../server/gmailSession.js';
import { mergeShopifySession, normalizeShop } from '../server/shopifySession.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return '';
  return process.argv[i + 1] ? String(process.argv[i + 1]) : '';
}

const mode = process.argv[2];

if (mode === 'gmail') {
  const access_token = arg('--access-token');
  const refresh_token = arg('--refresh-token');
  const expiry_date = arg('--expiry-date');
  if (!access_token && !refresh_token) {
    console.error('Gebruik: node scripts/merge-token.mjs gmail --access-token "..." [--refresh-token "..."] [--expiry-date 1234567890]');
    process.exit(1);
  }
  await mergeGmailTokens(
    {
      ...(access_token ? { access_token } : {}),
      ...(refresh_token ? { refresh_token } : {}),
      ...(expiry_date ? { expiry_date: Number(expiry_date) } : {}),
    },
    undefined
  );
  console.log('OK: .google_gmail_token.json bijgewerkt (merge).');
  process.exit(0);
}

if (mode === 'shopify') {
  const shopRaw = arg('--shop');
  const access_token = arg('--access-token');
  const refresh_token = arg('--refresh-token');
  const shop = normalizeShop(shopRaw);
  if (!shop || !access_token) {
    console.error(
      'Gebruik: node scripts/merge-token.mjs shopify --shop jouwshop.myshopify.com --access-token "shpat_..." [--refresh-token "shprt_..."]'
    );
    process.exit(1);
  }
  await mergeShopifySession(shop, {
    access_token,
    ...(refresh_token ? { refresh_token } : {}),
  });
  console.log('OK: .shopify_token.json bijgewerkt (merge).');
  process.exit(0);
}

console.error('Gebruik: node scripts/merge-token.mjs gmail|shopify ...');
process.exit(1);
