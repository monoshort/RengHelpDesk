import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  postgresShopifySessionEnabled,
  pgLoadShopifySessionDoc,
  pgSaveShopifySessionDoc,
} from './shopifySessionPostgres.js';

export { postgresShopifySessionEnabled };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** OAuth-sessie uit Postgres (alle instances delen dezelfde refresh/access). */
let _pgSessionMem = null;
export const SESSION_FILE =
  process.env.SHOPIFY_SESSION_FILE?.trim() ||
  (process.env.VERCEL
    ? path.join('/tmp', 'reng_shopify_token.json')
    : path.join(__dirname, '..', '.shopify_token.json'));

function sleepSyncMs(ms) {
  const t = Date.now() + Math.max(0, ms);
  while (Date.now() < t) {}
}

/** Atomisch wegschrijven (temp + rename) — minder kans op half geschreven JSON bij crash/stroom. */
function atomicWriteFileSync(filePath, utf8) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const max = 6;
  for (let attempt = 0; attempt < max; attempt++) {
    const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    try {
      fs.writeFileSync(tmp, utf8, 'utf8');
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch {
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* Windows EBUSY: wacht en probeer rename opnieuw */
          }
        }
        fs.renameSync(tmp, filePath);
        return;
      }
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
      if (attempt < max - 1 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
        sleepSyncMs(40 + attempt * 90);
        continue;
      }
      throw e;
    }
  }
}

/** JSON kan getallen als string bevatten; zonder parse werd refresh overgeslagen. */
function readEpochMsFromJson(raw) {
  if (raw == null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return undefined;
  return n;
}

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

/**
 * @returns {{
 *   shopDomain: string;
 *   accessToken: string;
 *   refreshToken?: string;
 *   expiresAt?: number;
 *   refreshTokenExpiresAt?: number;
 *   scope?: string;
 * } | null}
 */
function readShopifySessionOnce() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  let raw;
  try {
    raw = fs.readFileSync(SESSION_FILE, 'utf8');
  } catch {
    return null;
  }
  if (!raw || raw.length > 2_000_000) return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    console.warn('[shopifySession] Sessiebestand is geen geldige JSON; genegeerd:', SESSION_FILE);
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  return sessionFromDoc(/** @type {Record<string, unknown>} */ (j));
}

/**
 * @param {Record<string, unknown> | null | undefined} j
 * @returns {{
 *   shopDomain: string;
 *   accessToken: string;
 *   refreshToken?: string;
 *   expiresAt?: number;
 *   refreshTokenExpiresAt?: number;
 *   scope?: string;
 * } | null}
 */
function sessionFromDoc(j) {
  const tok = j?.access_token != null ? String(j.access_token).trim() : '';
  const shop = j?.shop != null ? String(j.shop).trim() : '';
  if (!tok || !shop) return null;
  return {
    shopDomain: shop,
    accessToken: tok,
    refreshToken: j.refresh_token ? String(j.refresh_token) : undefined,
    expiresAt: readEpochMsFromJson(j.expires_at),
    refreshTokenExpiresAt: readEpochMsFromJson(j.refresh_token_expires_at),
    scope: j.scope ? String(j.scope) : undefined,
  };
}

/** Zelfde als sessie-JSON (shop + access_token + …), o.a. voor per-gebruiker opslag. */
export function shopifySessionFromJsonDoc(j) {
  return sessionFromDoc(/** @type {Record<string, unknown>} */ (j));
}

/** Eén lopende hydrate: parallelle requests delen dezelfde Postgres-read. */
let _hydrateShopifyInflight = null;

/** Laadt OAuth uit Postgres in geheugen (meerdere instances). */
export async function hydrateShopifySessionFromDatabase() {
  if (!postgresShopifySessionEnabled()) return;
  if (_hydrateShopifyInflight) return _hydrateShopifyInflight;
  _hydrateShopifyInflight = (async () => {
    try {
      const envShop = normalizeShop(process.env.SHOPIFY_SHOP_DOMAIN || '') || '';
      const hint = envShop || (_pgSessionMem?.shopDomain ? String(_pgSessionMem.shopDomain) : '');
      const doc = await pgLoadShopifySessionDoc(hint);
      _pgSessionMem = doc ? sessionFromDoc(doc) : null;
    } catch (e) {
      console.error('[shopifySession] Postgres sessie laden mislukt:', e instanceof Error ? e.message : e);
      _pgSessionMem = null;
    } finally {
      _hydrateShopifyInflight = null;
    }
  })();
  return _hydrateShopifyInflight;
}

/** Leest sessie: Postgres (gedeeld) of lokaal bestand. */
export function readShopifySession() {
  if (postgresShopifySessionEnabled()) return _pgSessionMem;
  for (let i = 0; i < 4; i++) {
    try {
      return readShopifySessionOnce();
    } catch {
      if (i === 3) return null;
    }
    const until = Date.now() + 35 + i * 55;
    while (Date.now() < until) {}
  }
  return null;
}

/**
 * @param {string} shopDomain
 * @param {string | {
 *   access_token: string;
 *   expires_in?: number;
 *   refresh_token?: string;
 *   refresh_token_expires_in?: number;
 *   scope?: string;
 * }} accessTokenOrPayload
 */
export async function writeShopifySession(shopDomain, accessTokenOrPayload) {
  /** @type {Record<string, unknown>} */
  let doc;
  if (typeof accessTokenOrPayload === 'string') {
    const existing = readShopifySession();
    if (existing && existing.shopDomain === shopDomain) {
      doc = {
        shop: shopDomain,
        access_token: accessTokenOrPayload,
        ...(existing.refreshToken ? { refresh_token: existing.refreshToken } : {}),
        ...(existing.expiresAt != null ? { expires_at: existing.expiresAt } : {}),
        ...(existing.refreshTokenExpiresAt != null
          ? { refresh_token_expires_at: existing.refreshTokenExpiresAt }
          : {}),
        ...(existing.scope ? { scope: existing.scope } : {}),
      };
    } else {
      doc = { shop: shopDomain, access_token: accessTokenOrPayload };
    }
  } else {
    const p = accessTokenOrPayload;
    const now = Date.now();
    const existing = readShopifySession();
    const same = existing?.shopDomain === shopDomain;
    doc = {
      shop: shopDomain,
      access_token: p.access_token,
      ...(p.expires_in != null && Number.isFinite(Number(p.expires_in))
        ? { expires_at: now + Number(p.expires_in) * 1000 }
        : same && existing?.expiresAt != null
          ? { expires_at: existing.expiresAt }
          : {}),
      ...(p.refresh_token
        ? { refresh_token: String(p.refresh_token) }
        : same && existing?.refreshToken
          ? { refresh_token: existing.refreshToken }
          : {}),
      ...(p.refresh_token_expires_in != null && Number.isFinite(Number(p.refresh_token_expires_in))
        ? { refresh_token_expires_at: now + Number(p.refresh_token_expires_in) * 1000 }
        : same && existing?.refreshTokenExpiresAt != null
          ? { refresh_token_expires_at: existing.refreshTokenExpiresAt }
          : {}),
      ...(p.scope ? { scope: String(p.scope) } : same && existing?.scope ? { scope: existing.scope } : {}),
    };
  }
  if (postgresShopifySessionEnabled()) {
    try {
      await pgSaveShopifySessionDoc(doc);
      _pgSessionMem = sessionFromDoc(doc);
    } catch (e) {
      console.error('[shopifySession] Postgres sessie schrijven mislukt:', e instanceof Error ? e.message : e);
      throw Object.assign(
        new Error(
          'Kan OAuth-sessie niet naar Postgres schrijven. Controleer DATABASE_URL en migratierechten (tabel reng_shopify_oauth).'
        ),
        { code: 'SHOPIFY_SESSION_PG_WRITE' }
      );
    }
    return;
  }

  try {
    for (let w = 0; w < 4; w++) {
      try {
        atomicWriteFileSync(SESSION_FILE, JSON.stringify(doc, null, 2));
        break;
      } catch (e) {
        const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
        if (w < 3 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, 60 + w * 120));
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if (process.env.VERCEL) {
      console.error('[shopifySession] writeShopifySession failed on Vercel:', e);
      throw Object.assign(
        new Error(
          'Kan OAuth-token niet wegschrijven op Vercel. Zet SHOPIFY_ACCESS_TOKEN en SHOPIFY_SHOP_DOMAIN in Vercel → Environment Variables, of DATABASE_URL voor gedeelde OAuth in Postgres.'
        ),
        { code: 'SHOPIFY_SESSION_WRITE' }
      );
    }
    throw e;
  }
}

/**
 * Velden in `.shopify_token.json` bijwerken; ongenoemde velden blijven uit het bestand behouden (zelfde shop).
 * @param {string} shopDomain
 * @param {Partial<{ access_token: string; expires_in: number; refresh_token: string; refresh_token_expires_in: number; scope: string }>} partial
 */
export async function mergeShopifySession(shopDomain, partial) {
  await hydrateShopifySessionFromDatabase();
  const shop = normalizeShop(shopDomain);
  if (!shop) throw new Error('mergeShopifySession: ongeldige shop.');
  if (!partial || typeof partial !== 'object') {
    throw new Error('mergeShopifySession: tweede argument moet een object zijn.');
  }
  const cur = readShopifySession();
  if (!cur || cur.shopDomain !== shop) {
    throw new Error(
      'mergeShopifySession: geen bestaand sessiebestand voor deze shop. Gebruik eerst OAuth (/koppel.html) of writeShopifySession met volledige token.'
    );
  }
  /** @type {{ access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }} */
  const payload = {
    access_token:
      typeof partial.access_token === 'string' ? partial.access_token : cur.accessToken,
  };
  if (partial.expires_in != null) payload.expires_in = Number(partial.expires_in);
  if (partial.refresh_token != null) payload.refresh_token = String(partial.refresh_token);
  if (partial.refresh_token_expires_in != null) {
    payload.refresh_token_expires_in = Number(partial.refresh_token_expires_in);
  }
  if (partial.scope != null) payload.scope = String(partial.scope);
  await writeShopifySession(shop, payload);
}

/** Seriële ketting: geen parallelle refresh naar Shopify. */
let shopifyRefreshTail = Promise.resolve();

/** Na mislukte refresh even geen nieuwe POST (voorkomt spam bij invalid_grant). */
let shopifyRefreshBackoffUntil = 0;

/**
 * Vernieuwt bij OAuth-sessie (`.shopify_token.json`) een verlopende access token via `refresh_token`
 * (Shopify “expiring offline” tokens, zie shop.dev) en schrijft de nieuwe waarden weg.
 * Ontbrekende of als string opgeslagen `expires_at` triggert nu ook een refresh (voorheen werd die overgeslagen).
 * @returns {Promise<void>}
 */
export function ensureShopifySessionAccessTokenFresh() {
  const run = shopifyRefreshTail.then(() => refreshShopifySessionIfNeeded());
  shopifyRefreshTail = run.catch(() => {});
  return run;
}

async function refreshShopifySessionIfNeeded() {
  await hydrateShopifySessionFromDatabase();

  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;

  /* Op Vercel met vaste env-token is /tmp-sessie niet gedeeld; refresh alleen ruis en mislukte writes. */
  if (shopifyPreferEnvTokenOverEphemeralSession()) return;

  const session = readShopifySession();
  if (!session?.shopDomain || !session?.accessToken) return;
  if (!session.refreshToken) return;

  const marginSec = Number(process.env.SHOPIFY_ACCESS_REFRESH_MARGIN_SEC || '');
  const marginMs =
    Number.isFinite(marginSec) && marginSec > 0
      ? Math.min(3_600_000, Math.max(60_000, marginSec * 1000))
      : 600_000;
  if (session.expiresAt != null && session.expiresAt > Date.now() + marginMs) return;

  if (session.refreshTokenExpiresAt != null && session.refreshTokenExpiresAt <= Date.now()) {
    console.warn(
      '[shopifySession] Shopify refresh_token is verlopen; koppel de shop opnieuw via /koppel.html.'
    );
    return;
  }

  if (Date.now() < shopifyRefreshBackoffUntil) return;

  const shop = session.shopDomain;
  const url = `https://${shop}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  });

  const refreshTimeoutMs = (() => {
    const n = Number(process.env.SHOPIFY_OAUTH_REFRESH_TIMEOUT_MS || '');
    if (Number.isFinite(n) && n >= 5000 && n <= 120_000) return n;
    return 25_000;
  })();
  const refreshSignal =
    typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? /** @type {AbortSignal} */ (AbortSignal.timeout(refreshTimeoutMs))
      : undefined;

  try {
    const tokenRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: refreshSignal,
    });
    const data = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !data.access_token) {
      shopifyRefreshBackoffUntil = Date.now() + 60_000;
      const detail =
        typeof data === 'object' && data !== null
          ? JSON.stringify(data).slice(0, 500)
          : String(data);
      console.error(
        '[shopifySession] Token refresh mislukt:',
        data.error_description || data.error || tokenRes.status,
        detail.length > 2 ? detail : ''
      );
      await hydrateShopifySessionFromDatabase();
      return;
    }
    await writeShopifySession(shop, {
      access_token: data.access_token,
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
      refresh_token_expires_in: data.refresh_token_expires_in,
      scope: data.scope,
    });
    shopifyRefreshBackoffUntil = 0;
  } catch (e) {
    shopifyRefreshBackoffUntil = Date.now() + 60_000;
    console.error('[shopifySession] Token refresh fout:', e instanceof Error ? e.message : e);
    await hydrateShopifySessionFromDatabase();
  }
}

/** Voor foutmeldingen: wat ontbreekt er aan credentials? */
export async function getShopifyAuthStatus() {
  await hydrateShopifySessionFromDatabase();
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
    shopifySessionPostgres: postgresShopifySessionEnabled(),
  };
}

/**
 * Vercel serverless: /tmp-sessie is per instance en niet gedeeld. Met een vaste token in env
 * moeten alle workers die token gebruiken (niet een willekeurige /tmp-kopie). Postgres-sessie
 * blijft leidend voor OAuth+refresh.
 */
export function shopifyPreferEnvTokenOverEphemeralSession() {
  return (
    String(process.env.VERCEL || '').trim() === '1' &&
    Boolean(process.env.SHOPIFY_ACCESS_TOKEN?.trim()) &&
    !postgresShopifySessionEnabled()
  );
}

/**
 * Tokens om achter elkaar te proberen.
 * OAuth met `refresh_token` (expiring offline) gaat vóór .env: een oude `SHOPIFY_ACCESS_TOKEN` mag
 * een ververste sessie niet maskeren. Zonder refresh-token: .env eerst, dan legacy-sessie.
 * Op Vercel zonder Postgres: .env vóór sessie (gedeeld token over alle instances).
 * @returns {{ shopDomain: string, accessToken: string, source: 'env' | 'session' }[]}
 */
export function shopifyCredentialAttempts() {
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const session = readShopifySession();
  /** @type {{ shopDomain: string, accessToken: string, source: 'env' | 'session' }[]} */
  const attempts = [];

  function push(shopDomain, accessToken, source) {
    if (!shopDomain || !accessToken) return;
    if (attempts.some((a) => a.accessToken === accessToken)) return;
    attempts.push({ shopDomain, accessToken, source });
  }

  if (shopifyPreferEnvTokenOverEphemeralSession()) {
    const shopDomain = envShop || session?.shopDomain;
    if (shopDomain && envToken) push(shopDomain, envToken, 'env');
    if (session?.accessToken && session.shopDomain && session.refreshToken) {
      push(session.shopDomain, session.accessToken, 'session');
    }
    if (session?.accessToken && session.shopDomain && !session.refreshToken) {
      push(session.shopDomain, session.accessToken, 'session');
    }
    return attempts;
  }

  if (session?.accessToken && session.shopDomain && session.refreshToken) {
    push(session.shopDomain, session.accessToken, 'session');
  }
  if (envToken) {
    const shopDomain = envShop || session?.shopDomain;
    if (shopDomain) push(shopDomain, envToken, 'env');
  }
  if (session?.accessToken && session.shopDomain && !session.refreshToken) {
    push(session.shopDomain, session.accessToken, 'session');
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

  if (
    String(process.env.VERCEL || '').trim() === '1' &&
    !postgresShopifySessionEnabled() &&
    !process.env.SHOPIFY_ACCESS_TOKEN?.trim()
  ) {
    hints.push(
      'Meerdere Vercel-instances: zet DATABASE_URL (zelfde als order-cache) zodat OAuth in Postgres wordt gedeeld, óf gebruik SHOPIFY_ACCESS_TOKEN. Zet SHOPIFY_SESSION_STORE=file alleen als je één instance en lokaal bestand wilt.'
    );
  }

  const n = shopifyCredentialAttempts().length;
  if (n === 0) {
    hints.push(
      'Start de server vanuit de map waar package.json en .env staan (bijv. npm start), en herstart na elke wijziging in .env. Op Render/VPS: zet dezelfde variabelen onder Environment.'
    );
  }

  return [...new Set(hints)];
}
