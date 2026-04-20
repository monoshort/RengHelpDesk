/**
 * Per-request: laadt Shopify/Gmail per dashboard-sessie (sid) en bouwt credential-volgorde.
 */
import {
  shopifyCredentialAttempts,
  ensureShopifySessionAccessTokenFresh,
  getShopifyAuthStatus,
  shopifyOverviewSetupHints,
  hydrateShopifySessionFromDatabase,
  shopifySessionFromJsonDoc,
} from './shopifySession.js';
import { loadUserIntegrationDoc, saveUserIntegrationDoc, sanitizeDashboardSid } from './userIntegrationsStore.js';

/** @type {Map<string, Promise<void>>} */
const userShopifyRefreshTails = new Map();

/**
 * Op Vercel met vaste SHOPIFY_ACCESS_TOKEN: die eerst proberen vóór OAuth uit user-integratie.
 * Voorkomt “soms wel / soms niet” als refresh-token of /tmp-sessie tijdelijk faalt terwijl env-token goed is.
 * Zet SHOPIFY_ENV_TOKEN_FIRST=false om oude gedrag (OAuth eerst) te forceren.
 */
function shopifyEnvTokenFirstMergeOrder() {
  const v = String(process.env.SHOPIFY_ENV_TOKEN_FIRST ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return (
    String(process.env.VERCEL || '').trim() === '1' && Boolean(process.env.SHOPIFY_ACCESS_TOKEN?.trim())
  );
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export async function attachUserIntegrations(req, _res, next) {
  try {
    const sid = sanitizeDashboardSid(req.dashboardSid);
    if (!sid) {
      req.userIntegrationShopify = null;
      req.userIntegrationGmail = null;
      return next();
    }
    const [shopifyDoc, gmailDoc] = await Promise.all([
      loadUserIntegrationDoc(sid, 'shopify'),
      loadUserIntegrationDoc(sid, 'gmail'),
    ]);
    req.userIntegrationShopify = shopifyDoc;
    req.userIntegrationGmail = gmailDoc;
  } catch (e) {
    console.error('[requestIntegrations] attach failed:', e instanceof Error ? e.message : e);
    req.userIntegrationShopify = null;
    req.userIntegrationGmail = null;
  }
  next();
}

/**
 * @param {import('express').Request} req
 * @returns {{ shopDomain: string; accessToken: string; source: string }[]}
 */
export function shopifyCredentialAttemptsForRequest(req) {
  const gl = shopifyCredentialAttempts();
  const sid = sanitizeDashboardSid(req?.dashboardSid);
  const raw = sid ? req.userIntegrationShopify : null;
  const parsed = raw && shopifySessionFromJsonDoc(raw);
  if (!parsed?.accessToken || !parsed.shopDomain) return gl;

  const seen = new Set();
  /** @type {{ shopDomain: string; accessToken: string; source: string }[]} */
  const out = [];
  const push = (a) => {
    if (!a?.accessToken || !a.shopDomain || seen.has(a.accessToken)) return;
    seen.add(a.accessToken);
    out.push(a);
  };

  if (shopifyEnvTokenFirstMergeOrder()) {
    for (const a of gl) {
      push({ shopDomain: a.shopDomain, accessToken: a.accessToken, source: a.source });
    }
    push({ shopDomain: parsed.shopDomain, accessToken: parsed.accessToken, source: 'user_session' });
    return out;
  }

  if (parsed.refreshToken) {
    push({ shopDomain: parsed.shopDomain, accessToken: parsed.accessToken, source: 'user_session' });
  }
  for (const a of gl) {
    push({ shopDomain: a.shopDomain, accessToken: a.accessToken, source: a.source });
  }
  if (!parsed.refreshToken) {
    push({ shopDomain: parsed.shopDomain, accessToken: parsed.accessToken, source: 'user_session' });
  }
  return out;
}

/**
 * @param {import('express').Request} req
 */
async function doEnsureUserShopifyTokenFresh(req) {
  const sid = sanitizeDashboardSid(req?.dashboardSid);
  if (!sid || !req.userIntegrationShopify) return;

  const session = shopifySessionFromJsonDoc(req.userIntegrationShopify);
  if (!session?.refreshToken) return;

  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;

  const marginSec = Number(process.env.SHOPIFY_ACCESS_REFRESH_MARGIN_SEC || '');
  const marginMs =
    Number.isFinite(marginSec) && marginSec > 0
      ? Math.min(3_600_000, Math.max(60_000, marginSec * 1000))
      : 600_000;
  if (session.expiresAt != null && session.expiresAt > Date.now() + marginMs) return;

  if (session.refreshTokenExpiresAt != null && session.refreshTokenExpiresAt <= Date.now()) {
    console.warn(
      '[requestIntegrations] Shopify refresh_token verlopen voor gebruiker-sessie;',
      'opnieuw koppelen via /koppel.html.'
    );
    return;
  }

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
      ? AbortSignal.timeout(refreshTimeoutMs)
      : undefined;

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
    console.error(
      '[requestIntegrations] User Shopify refresh mislukt:',
      data.error_description || data.error || tokenRes.status
    );
    return;
  }

  const now = Date.now();
  /** @type {Record<string, unknown>} */
  const nextDoc = {
    shop,
    access_token: data.access_token,
    ...(data.expires_in != null && Number.isFinite(Number(data.expires_in))
      ? { expires_at: now + Number(data.expires_in) * 1000 }
      : {}),
    ...(data.refresh_token
      ? { refresh_token: String(data.refresh_token) }
      : { refresh_token: session.refreshToken }),
    ...(data.refresh_token_expires_in != null && Number.isFinite(Number(data.refresh_token_expires_in))
      ? { refresh_token_expires_at: now + Number(data.refresh_token_expires_in) * 1000 }
      : {}),
    ...(data.scope ? { scope: String(data.scope) } : session.scope ? { scope: session.scope } : {}),
  };
  await saveUserIntegrationDoc(sid, 'shopify', nextDoc);
  req.userIntegrationShopify = nextDoc;
}

/**
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
export function ensureUserShopifyTokenFresh(req) {
  const sid = sanitizeDashboardSid(req?.dashboardSid);
  if (!sid) return Promise.resolve();
  const prev = userShopifyRefreshTails.get(sid) || Promise.resolve();
  const run = prev.then(() => doEnsureUserShopifyTokenFresh(req)).catch(() => {});
  userShopifyRefreshTails.set(sid, run);
  return run;
}

/**
 * @param {import('express').Request} req
 */
export async function ensureShopifyAccessForRequest(req) {
  await ensureUserShopifyTokenFresh(req);
  await hydrateShopifySessionFromDatabase();
  await ensureShopifySessionAccessTokenFresh();
}

/**
 * @param {import('express').Request} req
 */
export async function getShopifyAuthStatusForRequest(req) {
  await hydrateShopifySessionFromDatabase();
  const st = await getShopifyAuthStatus();
  const raw = req?.userIntegrationShopify;
  const u = raw && shopifySessionFromJsonDoc(raw);
  const hasUser = Boolean(u?.accessToken && u.shopDomain);
  return {
    ...st,
    hasToken: Boolean(st.hasToken || hasUser),
    shopDomain: st.shopDomain || u?.shopDomain || null,
    userShopifyLinked: hasUser,
  };
}

/**
 * @param {import('express').Request} req
 * @returns {string[]}
 */
export function shopifyOverviewSetupHintsForRequest(req) {
  const hints = [...shopifyOverviewSetupHints()];
  const raw = req?.userIntegrationShopify;
  const u = raw && shopifySessionFromJsonDoc(raw);
  const hasUserShopify = Boolean(u?.accessToken);
  if (
    String(process.env.VERCEL || '').trim() === '1' &&
    !process.env.DATABASE_URL?.trim()
  ) {
    hints.push(
      'Per-gebruiker koppeling op Vercel: zet DATABASE_URL zodat Shopify/Gmail per sessie bewaard blijft (zonder DB is opslag vluchtig in /tmp).'
    );
  }
  if (!hasUserShopify && !process.env.SHOPIFY_ACCESS_TOKEN?.trim()) {
    hints.push('Koppel Shopify via /koppel.html na inloggen — de token hoort bij jouw dashboard-sessie.');
  }
  return [...new Set(hints)];
}
