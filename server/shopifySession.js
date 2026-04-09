import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = path.join(__dirname, '..', '.shopify_token.json');

/** @param {string | undefined} input */
export function normalizeShop(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.+$/, '');
  if (!s) return null;
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}

export function readShopifySession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!j?.access_token || !j?.shop) return null;
    return { shopDomain: String(j.shop), accessToken: String(j.access_token) };
  } catch {
    return null;
  }
}

/**
 * @param {string} shopDomain
 * @param {string} accessToken
 */
export function writeShopifySession(shopDomain, accessToken) {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ shop: shopDomain, access_token: accessToken }, null, 2),
    'utf8'
  );
}

/** Voor foutmeldingen: wat ontbreekt er aan credentials? */
export function getShopifyAuthStatus() {
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const session = readShopifySession();
  const shop = envShop || session?.shopDomain || '';
  const token = envToken || session?.accessToken || '';
  return {
    hasShop: Boolean(shop),
    hasToken: Boolean(token),
    shopDomain: shop || null,
    hasOAuthCreds: Boolean(
      process.env.SHOPIFY_CLIENT_ID?.trim() && process.env.SHOPIFY_CLIENT_SECRET?.trim()
    ),
    hasSessionFile: Boolean(session?.accessToken),
  };
}

/**
 * Tokens om achter elkaar te proberen: eerst .env, dan OAuth-sessie als die een andere token heeft.
 * @returns {{ shopDomain: string, accessToken: string, source: 'env' | 'session' }[]}
 */
export function shopifyCredentialAttempts() {
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const session = readShopifySession();
  /** @type {{ shopDomain: string, accessToken: string, source: 'env' | 'session' }[]} */
  const attempts = [];
  if (envToken) {
    const shopDomain = envShop || session?.shopDomain;
    if (shopDomain) {
      attempts.push({ shopDomain, accessToken: envToken, source: 'env' });
    }
  }
  if (session?.accessToken && session.shopDomain) {
    const dup = attempts.some((a) => a.accessToken === session.accessToken);
    if (!dup) {
      attempts.push({
        shopDomain: session.shopDomain,
        accessToken: session.accessToken,
        source: 'session',
      });
    }
  }
  return attempts;
}

/**
 * Korte hints (zonder secrets) als het overzicht geen credentials kan laden.
 * @returns {string[]}
 */
export function shopifyOverviewSetupHints() {
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const session = readShopifySession();
  /** @type {string[]} */
  const hints = [];

  if (!envToken && !session?.accessToken) {
    hints.push(
      'Geen Admin API-token geladen: zet SHOPIFY_ACCESS_TOKEN (begint met shpat_) in .env óf koppel de shop via /koppel.html (OAuth → .shopify_token.json).'
    );
  }
  if (!envShop && !session?.shopDomain) {
    hints.push(
      'Geen shop-domein: zet SHOPIFY_SHOP_DOMAIN in .env (bijv. toddie-nl.myshopify.com — met .myshopify.com).'
    );
  }
  if (envToken && !envShop && !session?.shopDomain) {
    hints.push(
      'Er is een token in .env, maar SHOPIFY_SHOP_DOMAIN ontbreekt. Vul het interne Shopify-domein in (Admin → Instellingen → Domeinen).'
    );
  }
  if (!envToken && !session?.accessToken) {
    const cid = process.env.SHOPIFY_CLIENT_ID?.trim();
    const cs = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    if (!cid || !cs) {
      hints.push('Voor OAuth: zet SHOPIFY_CLIENT_ID en SHOPIFY_CLIENT_SECRET in .env (App-ontwikkeling → API-credentials).');
    }
  }

  const n = shopifyCredentialAttempts().length;
  if (n === 0) {
    hints.push(
      'Start de server vanuit de map waar package.json en .env staan (bijv. npm start), en herstart na elke wijziging in .env. Op Render/VPS: zet dezelfde variabelen onder Environment.'
    );
  }

  return [...new Set(hints)];
}
