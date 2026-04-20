import {
  ensureShopifySessionAccessTokenFresh,
  readShopifySession,
  shopifyPreferEnvTokenOverEphemeralSession,
  writeShopifySession,
  hydrateShopifySessionFromDatabase,
} from './shopifySession.js';
import { exchangeShopifyClientCredentials } from './shopifyClientCredentials.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION?.trim() || '2025-10';

/**
 * Laagste `created_at` voor orderlijsten (REST `created_at_min`). Standaard ~3 maanden.
 * Zet `SHOPIFY_ORDERS_CREATED_WITHIN_DAYS=0` om geen ondergrens toe te passen (alle orders; trager).
 * @returns {string | null} ISO 8601 (UTC) of null = geen filter
 */
export function shopifyOrdersCreatedAtMinIso() {
  const raw = process.env.SHOPIFY_ORDERS_CREATED_WITHIN_DAYS;
  if (raw != null && String(raw).trim() === '0') return null;
  const d = Number(raw ?? '');
  const days = Number.isFinite(d) && d > 0 ? Math.min(365 * 5, Math.floor(d)) : 90;
  return new Date(Date.now() - days * 86400000).toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shopifyFetchTimeoutMs() {
  const n = Number(process.env.SHOPIFY_FETCH_TIMEOUT_MS || '');
  if (Number.isFinite(n) && n >= 8000 && n <= 180_000) return n;
  return 55_000;
}

/**
 * @param {AbortSignal | undefined | null} userSignal
 * @param {number} timeoutMs
 */
function combineUserAndTimeoutSignal(userSignal, timeoutMs) {
  if (timeoutMs <= 0) return userSignal ?? undefined;
  if (typeof AbortSignal === 'undefined' || !('timeout' in AbortSignal)) return userSignal ?? undefined;
  const t = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return t;
  if ('any' in AbortSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([userSignal, t]);
  }
  return t;
}

/** @param {unknown} e */
function isAbortError(e) {
  return Boolean(e && typeof e === 'object' && ('name' in e ? e.name === 'AbortError' : false));
}

/** @param {unknown} e */
function isRetriableFetchFailure(e) {
  if (isAbortError(e)) return false;
  const err = /** @type {NodeJS.ErrnoException & { cause?: unknown }} */ (e);
  const code = err?.code;
  if (code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE')
    return true;
  const msg = String(err?.message || e || '').toLowerCase();
  if (/fetch failed|network|socket|und_err|connect/i.test(msg)) return true;
  return err?.cause != null && isRetriableFetchFailure(err.cause);
}

function parseShopifyRetryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(120_000, Math.max(400, sec * 1000));
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return Math.min(120_000, Math.max(400, t - Date.now()));
  return null;
}

/** Tokens om na 401 te proberen: zelfde volgorde als shopifyCredentialAttempts (Vercel+env → env eerst). */
function tokensFor401Retry(cfg, shop) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  const add = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const session = readShopifySession();
  const envTok = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const envOk = Boolean(envTok && (!envShop || normShopHost(envShop) === shop));
  const vercelEnvFirst = shopifyPreferEnvTokenOverEphemeralSession() && envOk;

  if (vercelEnvFirst) {
    add(envTok);
    if (session?.accessToken && normShopHost(session.shopDomain) === shop) add(session.accessToken);
  } else {
    if (session?.accessToken && normShopHost(session.shopDomain) === shop) add(session.accessToken);
    if (envOk) add(envTok);
  }
  add(cfg.accessToken);
  return out;
}

/** @type {Promise<string | null> | null} */
let cc401HealInflight = null;

/**
 * Na OAuth-refresh + token-rotatie nog steeds 401: één keer Client Credentials (Custom app) en token in gedeelde sessie.
 * Wijzigt geen Vercel-/hosting-env (SHOPIFY_ACCESS_TOKEN); daarvoor is aparte tooling nodig.
 * @param {string} shop genormaliseerde host (…myshopify.com)
 */
async function tryHeal401WithClientCredentials(shop) {
  const opt = String(process.env.SHOPIFY_AUTO_CC_ON_401 ?? '1').trim().toLowerCase();
  if (opt === '0' || opt === 'false' || opt === 'no') return null;

  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const shopNorm = normShopHost(shop);
  if (!shopNorm || !/\.myshopify\.com$/i.test(shopNorm)) return null;

  const run = async () => {
    try {
      const { shop: sShop, data } = await exchangeShopifyClientCredentials({
        shopInput: shopNorm,
        clientId,
        clientSecret,
      });
      const normS = normShopHost(sShop);
      if (normS !== shopNorm) {
        console.warn('[shopify] auto client-credentials: shop mismatch', normS, shopNorm);
        return null;
      }
      await writeShopifySession(normS, {
        access_token: data.access_token,
        ...(data.expires_in != null && Number.isFinite(Number(data.expires_in))
          ? { expires_in: Number(data.expires_in) }
          : {}),
        ...(data.scope ? { scope: String(data.scope) } : {}),
      });
      await hydrateShopifySessionFromDatabase();
      console.info('[shopify] auto client-credentials: nieuwe Admin-token in sessie opgeslagen');
      return String(data.access_token);
    } catch (e) {
      console.warn('[shopify] auto client-credentials:', e instanceof Error ? e.message : e);
      return null;
    }
  };

  if (!cc401HealInflight) {
    cc401HealInflight = run().finally(() => {
      cc401HealInflight = null;
    });
  }
  return cc401HealInflight;
}

/**
 * Admin API `fetch`: 401 → refresh + meerdere tokens; 429 / 5xx → backoff + retry (configureerbaar via env).
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {string|URL} url
 * @param {RequestInit} [init]
 */
export async function shopifyAdminFetch(cfg, url, init = {}) {
  const shop = normShopHost(cfg.shopDomain);
  const maxAttempts = Math.min(
    12,
    Math.max(1, Number(process.env.SHOPIFY_FETCH_MAX_ATTEMPTS || '') || 7)
  );
  const timeoutMs = shopifyFetchTimeoutMs();

  async function doFetch(token) {
    const extra =
      init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
        ? { ...init.headers }
        : {};
    delete extra['X-Shopify-Access-Token'];
    delete extra['x-shopify-access-token'];
    const signal = combineUserAndTimeoutSignal(init.signal, timeoutMs);
    return fetch(url, {
      method: init.method,
      body: init.body,
      signal,
      headers: {
        Accept: 'application/json',
        ...extra,
        'X-Shopify-Access-Token': token,
      },
    });
  }

  let activeToken = cfg.accessToken;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await doFetch(activeToken);
    } catch (e) {
      if (attempt < maxAttempts - 1 && isRetriableFetchFailure(e)) {
        await sleep(Math.min(20_000, 400 * 2 ** attempt + Math.random() * 350));
        continue;
      }
      throw e;
    }

    if (res.status === 401) {
      for (let round = 0; round < 2 && res.status === 401; round++) {
        await ensureShopifySessionAccessTokenFresh();
        await sleep(round === 0 ? 80 + Math.random() * 120 : 200 + Math.random() * 280);
        for (const t of tokensFor401Retry(cfg, shop)) {
          activeToken = t;
          try {
            res = await doFetch(t);
          } catch (e) {
            if (isRetriableFetchFailure(e)) {
              await sleep(250 + Math.random() * 200);
              try {
                res = await doFetch(t);
              } catch {
                break;
              }
            } else {
              throw e;
            }
          }
          if (res.status !== 401) break;
        }
      }
      if (res.status === 401) {
        const healedTok = await tryHeal401WithClientCredentials(shop);
        if (healedTok) {
          activeToken = healedTok;
          try {
            res = await doFetch(healedTok);
          } catch (e) {
            if (isRetriableFetchFailure(e)) {
              await sleep(300 + Math.random() * 200);
              res = await doFetch(healedTok);
            } else {
              throw e;
            }
          }
        }
      }
    }

    if (res.ok) return res;

    if (res.status === 429 && attempt < maxAttempts - 1) {
      const w = parseShopifyRetryAfterMs(res) ?? Math.min(40_000, 800 * 2 ** attempt);
      await sleep(w + Math.random() * 400);
      continue;
    }

    const retryableHttp =
      (res.status >= 500 && res.status <= 599) || res.status === 408 || res.status === 425;
    if (retryableHttp && attempt < maxAttempts - 1) {
      await sleep(Math.min(25_000, 550 * 2 ** attempt + Math.random() * 400));
      continue;
    }

    return res;
  }

  return doFetch(activeToken);
}

export function normShopHost(domain) {
  return String(domain || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

/**
 * @param {{ shopDomain: string, accessToken: string }} cfg
 */
export async function fetchShop(cfg) {
  const shop = normShopHost(cfg.shopDomain);
  const url = `https://${shop}/admin/api/${API_VERSION}/shop.json`;
  const res = await shopifyAdminFetch(cfg, url, {});
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify shop ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = await res.json();
  const s = body.shop;
  if (!s) return null;

  const maxLen = 4000;
  /** @type {{ key: string; value: string }[]} */
  const allFields = Object.keys(s)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const val = s[key];
      let value;
      if (val === null || val === undefined) value = '—';
      else if (typeof val === 'object') {
        try {
          value = JSON.stringify(val);
        } catch {
          value = String(val);
        }
      } else value = String(val);
      if (value.length > maxLen) value = `${value.slice(0, maxLen)}…`;
      return { key, value };
    });

  return {
    name: s.name ?? null,
    email: s.email ?? null,
    phone: s.phone ?? null,
    domain: s.domain ?? null,
    primaryDomain: s.primary_domain_host ?? s.domain ?? null,
    currency: s.currency ?? 'EUR',
    ianaTimezone: s.iana_timezone ?? null,
    country: s.country_name ?? s.country_code ?? null,
    planName: s.plan_name ?? null,
    shopOwner: s.shop_owner ?? null,
    address: [s.address1, s.zip, s.city].filter(Boolean).join(', ') || null,
    allFields,
    _source: 'GET /admin/api/{version}/shop.json',
  };
}

/**
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {{ limit?: number }} [query]
 */
export async function fetchRecentOrders(cfg, query = {}) {
  const shop = normShopHost(cfg.shopDomain);
  const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 250);
  const url = new URL(`https://${shop}/admin/api/${API_VERSION}/orders.json`);
  url.searchParams.set('status', 'any');
  url.searchParams.set('limit', String(limit));
  const minCreated = shopifyOrdersCreatedAtMinIso();
  if (minCreated) url.searchParams.set('created_at_min', minCreated);

  const res = await shopifyAdminFetch(cfg, url, {});

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify orders ${res.status}: ${text.slice(0, 400)}`);
  }

  const body = await res.json();
  return Array.isArray(body.orders) ? body.orders : [];
}

/**
 * Zoekt orders op ordernaam (zoals in Admin: #1001 of T0046587).
 * Losse API-call; gebruik als fallback als de order niet in de cache/recente lijst staat.
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {string} nameHint
 * @returns {Promise<any[]>}
 */
export async function fetchOrdersMatchingName(cfg, nameHint) {
  const shop = normShopHost(cfg.shopDomain);
  const raw = String(nameHint || '').trim();
  if (!raw) return [];
  /** @type {string[]} */
  const variants = [];
  variants.push(raw);
  if (!raw.startsWith('#')) variants.push(`#${raw}`);
  else variants.push(raw.slice(1));
  const seen = new Set();
  /** @type {any[]} */
  const merged = [];
  for (const name of variants) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const url =
      `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&limit=10&name=` +
      encodeURIComponent(name);
    let res = await shopifyAdminFetch(cfg, url, {});
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      res = await shopifyAdminFetch(cfg, url, {});
    }
    if (!res.ok) continue;
    const body = await res.json().catch(() => ({}));
    const batch = Array.isArray(body.orders) ? body.orders : [];
    for (const o of batch) merged.push(o);
    if (merged.length) break;
  }
  return merged;
}

/**
 * Zoekt orders op klant-e-mail als losse fallback buiten de lokale cache.
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {string} email
 * @returns {Promise<any[]>}
 */
export async function fetchOrdersMatchingEmail(cfg, email) {
  const shop = normShopHost(cfg.shopDomain);
  const raw = String(email || '').trim().toLowerCase();
  if (!raw || !raw.includes('@')) return [];
  const url =
    `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&limit=20&email=` +
    encodeURIComponent(raw);
  let res = await shopifyAdminFetch(cfg, url, {});
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after')) || 2;
    await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
    res = await shopifyAdminFetch(cfg, url, {});
  }
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  const batch = Array.isArray(body.orders) ? body.orders : [];
  return batch.filter((o) => {
    const e =
      o.email ||
      o.contact_email ||
      o.customer?.email ||
      o.shipping_address?.email ||
      o.billing_address?.email ||
      '';
    return String(e).trim().toLowerCase() === raw;
  });
}

/**
 * Parseert Shopify `Link`-header (cursor-paginatie).
 * @param {string | null | undefined} linkHeader
 * @param {'next'|'previous'} rel
 * @returns {string | null}
 */
export function parseLinkRel(linkHeader, rel) {
  if (!linkHeader || typeof linkHeader !== 'string') return null;
  const parts = linkHeader.split(',');
  for (const p of parts) {
    const s = p.trim();
    const m = s.match(/^<([^>]+)>;\s*rel="([^"]+)"/);
    if (m && m[2] === rel) return m[1];
    const m2 = s.match(/^<([^>]+)>;\s*rel=([^;\s]+)/);
    if (m2) {
      const r = m2[2].replace(/^["']|["']$/g, '');
      if (r === rel) return m2[1];
    }
  }
  return null;
}

/**
 * Haalt orders op in pagina's (max 250 per call) tot er geen volgende pagina is of het maximum is bereikt.
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {{ maxOrders?: number; pageSize?: number; createdAtMinIso?: string | null }} [opts]
 */
export async function fetchAllRecentOrders(cfg, opts = {}) {
  const shop = normShopHost(cfg.shopDomain);
  const pageSize = Math.min(250, Math.max(1, Number(opts.pageSize) || 250));
  const envCap = Number(process.env.SHOPIFY_ORDERS_MAX || '');
  const maxOrders = Math.min(
    50000,
    Math.max(1, Number(opts.maxOrders) || (Number.isFinite(envCap) && envCap > 0 ? envCap : 250))
  );
  const createdMin = String(opts.createdAtMinIso ?? '').trim();
  /** @type {any[]} */
  const all = [];
  let requestUrl = `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&limit=${pageSize}`;
  if (createdMin) requestUrl += `&created_at_min=${encodeURIComponent(createdMin)}`;

  for (let guard = 0; guard < 500; guard++) {
    const res = await shopifyAdminFetch(cfg, requestUrl, {});
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      guard--;
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify orders ${res.status}: ${text.slice(0, 400)}`);
    }
    const body = await res.json();
    const batch = Array.isArray(body.orders) ? body.orders : [];
    for (const o of batch) {
      if (all.length >= maxOrders) break;
      all.push(o);
    }
    if (all.length >= maxOrders) break;
    if (batch.length < pageSize) break;
    const link = res.headers.get('link') || res.headers.get('Link');
    const next = parseLinkRel(link, 'next');
    if (!next) break;
    requestUrl = next;
  }

  return all;
}

/**
 * Orders gewijzigd sinds `updated_at_min` (ISO 8601). Zelfde paginatie als fetchAllRecentOrders.
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {{ updatedAtMinIso: string; maxOrders?: number; pageSize?: number; createdAtMinIso?: string | null }} opts
 */
export async function fetchOrdersUpdatedSince(cfg, opts) {
  const shop = normShopHost(cfg.shopDomain);
  const pageSize = Math.min(250, Math.max(1, Number(opts.pageSize) || 250));
  const maxOrders = Math.min(
    10000,
    Math.max(1, Number(opts.maxOrders) || 5000)
  );
  const min = String(opts.updatedAtMinIso || '').trim();
  if (!min) {
    throw new Error('fetchOrdersUpdatedSince: updatedAtMinIso ontbreekt');
  }
  const createdMin = String(opts.createdAtMinIso ?? '').trim();
  /** @type {any[]} */
  const all = [];
  let requestUrl =
    `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&limit=${pageSize}` +
    `&updated_at_min=${encodeURIComponent(min)}`;
  if (createdMin) requestUrl += `&created_at_min=${encodeURIComponent(createdMin)}`;

  for (let guard = 0; guard < 500; guard++) {
    const res = await shopifyAdminFetch(cfg, requestUrl, {});
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      guard--;
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify orders ${res.status}: ${text.slice(0, 400)}`);
    }
    const body = await res.json();
    const batch = Array.isArray(body.orders) ? body.orders : [];
    for (const o of batch) {
      if (all.length >= maxOrders) break;
      all.push(o);
    }
    if (all.length >= maxOrders) break;
    if (batch.length < pageSize) break;
    const link = res.headers.get('link') || res.headers.get('Link');
    const next = parseLinkRel(link, 'next');
    if (!next) break;
    requestUrl = next;
  }

  return all;
}

function stripHtml(s) {
  if (s == null || typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function metafieldValueString(m) {
  if (!m || m.value == null) return '';
  const v = m.value;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Aantal werkdagen uit typische toddie.nl / NL storefront-teksten.
 * @param {string} text
 * @returns {number | null}
 */
export function parseWorkingDaysFromLeadTimeText(text) {
  const s = String(text);
  const patterns = [
    /(?:verzending|levering|bezorging|leverbaar)\s+binnen\s+(\d+)\s*werkdagen?/i,
    /binnen\s+(\d+)\s*werkdagen?/i,
    /(\d+)\s*werkdagen?\s*(?:voor\s*)?(?:lever|bezorg|verzend)/i,
    /within\s+(\d+)\s*business\s*days?/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Math.min(120, Math.max(1, parseInt(m[1], 10)));
  }
  return null;
}

/**
 * @param {string} isoStart order created_at
 * @param {number} n
 */
export function formatEndOfBusinessDaysNl(isoStart, n) {
  const num = Math.min(Math.max(Math.floor(Number(n)), 1), 120);
  const d = new Date(isoStart);
  if (Number.isNaN(d.getTime())) return null;
  let left = num;
  let guard = 0;
  while (left > 0 && guard < 400) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left -= 1;
    guard += 1;
  }
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      dateStyle: 'medium',
      timeZone: 'Europe/Amsterdam',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Zoekt zinnen als "In productie, verzending binnen 10 werkdagen" in platte tekst / metavelden.
 * @param {string} blob
 * @returns {{ hint: string; workingDays: number | null } | null}
 */
export function extractProductionLeadFromBlob(blob) {
  if (!blob || typeof blob !== 'string') return null;
  const flat = blob.replace(/\s+/g, ' ').trim();
  if (!flat) return null;

  const wd = parseWorkingDaysFromLeadTimeText(flat);
  let hint = null;

  const inProd = flat.match(
    /in\s+productie[^.]{0,160}(?:\.|$)|in\s+productie,?\s*verzending\s+binnen\s+\d+\s*werkdagen?[^.]*/i
  );
  if (inProd) {
    hint = inProd[0].trim().slice(0, 220);
  } else if (/in\s+productie/i.test(flat)) {
    const i = flat.search(/in\s+productie/i);
    hint = flat.slice(i, i + 200).trim();
  } else if (wd != null) {
    const m = flat.match(
      /[^.]{0,40}(?:verzend|lever)\w*\s+binnen\s+\d+\s*werkdagen?[^.]{0,60}/i
    );
    if (m) hint = m[0].trim().slice(0, 200);
  }

  if (!hint && wd == null) return null;
  if (!hint && wd != null) hint = `Levertijd: ca. ${wd} werkdagen (uit productgegevens)`;
  const wdFinal = wd ?? parseWorkingDaysFromLeadTimeText(hint);
  return { hint: hint.slice(0, 240), workingDays: wdFinal };
}

/** Tekst die in de Admin-timeline wijst op een mail/notificatie naar de klant (Shopify + apps zoals Sendcloud). */
const CUSTOMER_EMAIL_TIMELINE_HINT =
  /(e-?mail|email)\s+(was\s+)?sent|sent\s+(a\s+)?[\w\s'-]*\s*(e-?mail|email)\s+to|sent\s+[\w\s'-]+\s+an?\s+(e-?mail|email)|confirmation\s+(e-?mail|email)|shipping\s+confirmation|delivery\s+confirmation|verzend(bevestiging|ings?(e-?mail|mail)?)|bevestigings(e-?mail|mail)|klant.*(gemaild|notificatie)|customer.*notif/i;

/**
 * @param {any} e Shopify order event
 */
function orderEventToCustomerMailLine(e) {
  const desc = e.description && String(e.description).trim();
  const msg = stripHtml(e.message || '');
  const text = `${desc || ''} ${msg}`.trim();
  if (!text) return null;
  const verb = e.verb != null ? String(e.verb) : '';
  if (verb === 'mail_sent') {
    return { at: e.created_at, description: desc || msg, verb, author: e.author || null };
  }
  if (verb === 'comment' && !CUSTOMER_EMAIL_TIMELINE_HINT.test(text)) {
    return null;
  }
  if (!CUSTOMER_EMAIL_TIMELINE_HINT.test(text)) {
    return null;
  }
  const line = desc || msg;
  return { at: e.created_at, description: line, verb: verb || null, author: e.author || null };
}

/**
 * Shopify order-timeline: alle meldingen die naar de klant gemailed / ge-e-maild zijn (standaard `mail_sent`,
 * plus app-regels zoals "Sendcloud sent a shipping confirmation email to …").
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {string|number} orderId
 * @returns {Promise<Array<{ at: string; description: string; verb?: string | null; author?: string | null }>>}
 */
export async function fetchOrderMailSentEvents(cfg, orderId) {
  const shop = normShopHost(cfg.shopDomain);
  const url = new URL(
    `https://${shop}/admin/api/${API_VERSION}/orders/${orderId}/events.json`
  );
  url.searchParams.set('limit', '250');

  const res = await shopifyAdminFetch(cfg, url, {});

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify events ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  const events = Array.isArray(body.events) ? body.events : [];
  /** @type {Map<string, { at: string; description: string; verb?: string | null; author?: string | null }>} */
  const byKey = new Map();
  for (const e of events) {
    const row = orderEventToCustomerMailLine(e);
    if (!row || !row.at || !row.description) continue;
    const key = `${row.at}\0${row.description}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );
}

/**
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {(string|number)[]} orderIds
 * @returns {Promise<Record<string, Array<{ at: string; description: string; verb?: string | null; author?: string | null }>>>}
 */
export async function fetchMailLogsForOrderIds(cfg, orderIds) {
  const unique = [...new Set(orderIds.map(String))];
  /** @type {Record<string, Array<{ at: string; description: string }>>} */
  const map = {};
  const concurrency = Math.min(
    20,
    Math.max(1, Number(process.env.SHOPIFY_EVENTS_CONCURRENCY || 14))
  );
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= unique.length) return;
      const id = unique[i];
      try {
        map[id] = await fetchOrderMailSentEvents(cfg, id);
      } catch {
        map[id] = [];
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return map;
}

function escapeHtmlForPreview(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Ruwe timeline-HTML uit Shopify: scripts eruit, riskante handlers weg (preview in iframe).
 * @param {string} html
 */
function sanitizeTimelineMessageHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html.slice(0, 400_000);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  s = s.replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  s = s.replace(/href\s*=\s*(["'])\s*javascript:[^"']*\1/gi, 'href="#"');
  return s;
}

function messageLooksLikeHtml(s) {
  return typeof s === 'string' && /<[a-z][\s\S]*>/i.test(s);
}

/**
 * @param {string} href
 * @param {string} shopHost
 */
function absolutizeShopifyUrl(href, shopHost) {
  if (!href || typeof href !== 'string') return '';
  let h = href.trim().replace(/&amp;/g, '&');
  if (h.startsWith('//')) return `https:${h}`;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('/')) return `https://${shopHost}${h}`;
  return h;
}

/**
 * @param {string} messageHtml
 * @param {string} shopHost
 */
function extractAnchorsAndPdfs(messageHtml, shopHost) {
  /** @type {{ url: string; label: string }[]} */
  const anchors = [];
  const re = /<a[^>]*\bhref\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(messageHtml || '')) !== null) {
    const abs = absolutizeShopifyUrl(m[2], shopHost);
    const label = stripHtml(m[3]).slice(0, 160) || abs;
    if (abs) anchors.push({ url: abs, label });
  }
  const pdfUrls = [
    ...new Set(
      anchors
        .map((a) => a.url)
        .filter((u) => /\.pdf(\?|#|$)/i.test(u) || (/\/invoice/i.test(u) && /\.pdf/i.test(u)))
    ),
  ];
  return { anchors, pdfUrls };
}

/**
 * @param {string} text
 */
function invoiceRefsFromText(text) {
  const set = new Set();
  if (!text) return [];
  const re = /\bINV[-–][A-Z]{2,5}[-–]\d+[A-Z0-9-]*\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    set.add(m[0].replace(/–/g, '-').toUpperCase());
  }
  return [...set];
}

/**
 * @param {string} html
 * @param {string} fallback
 */
function guessEmailSubjectFromTimeline(html, fallback) {
  const t = html && html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) {
    const s = stripHtml(t[1]).trim();
    if (s) return s.slice(0, 220);
  }
  const og = html && html.match(/property=["']og:title["'][^>]*content=["']([^"']*)/i);
  if (og) {
    const s = stripHtml(og[1]).trim();
    if (s) return s.slice(0, 220);
  }
  const fb = stripHtml(fallback || '').trim();
  if (fb.length <= 200) return fb || 'E-mail';
  return `${fb.slice(0, 197)}…`;
}

/**
 * Volledige Shopify order-timeline (events.json), verrijkt voor UI: PDF-links, factuurreferenties, mailpreview-HTML.
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {string|number} orderId
 */
export async function fetchOrderTimelineEvents(cfg, orderId) {
  const shop = normShopHost(cfg.shopDomain);
  const url = new URL(`https://${shop}/admin/api/${API_VERSION}/orders/${orderId}/events.json`);
  url.searchParams.set('limit', '250');

  const res = await shopifyAdminFetch(cfg, url, {});

  if (!res.ok) {
    const text = await res.text();
    const err = /** @type {Error & { status?: number }} */ (
      Object.assign(new Error(`Shopify events ${res.status}: ${text.slice(0, 200)}`), {
        status: res.status,
      })
    );
    throw err;
  }

  const body = await res.json();
  const events = Array.isArray(body.events) ? body.events : [];
  /** @type {any[]} */
  const rows = [];

  for (const e of events) {
    const desc = e.description != null ? String(e.description).trim() : '';
    const msgRaw = e.message != null ? String(e.message) : '';
    const msgPlain = stripHtml(msgRaw);
    const verb = e.verb != null ? String(e.verb) : '';
    const mailRow = orderEventToCustomerMailLine(e);
    const customerEmailEvent = mailRow !== null;
    const { anchors, pdfUrls } = extractAnchorsAndPdfs(msgRaw, shop);
    const invoiceRefs = invoiceRefsFromText(`${desc} ${msgPlain}`);
    let previewHtml = '';
    if (msgRaw.trim()) {
      previewHtml = messageLooksLikeHtml(msgRaw)
        ? sanitizeTimelineMessageHtml(msgRaw)
        : `<p>${escapeHtmlForPreview(msgRaw.trim())}</p>`;
    } else if (desc) {
      previewHtml = `<p>${escapeHtmlForPreview(desc)}</p>`;
    }
    const previewSubject = guessEmailSubjectFromTimeline(msgRaw, desc || msgPlain);
    const deliveredLikely =
      /\bdelivered\b|✓\s*delivered|email\s+was\s+sent|succesvol\s+verzonden|successfully\s+sent/i.test(
        `${desc} ${msgPlain}`
      );

    rows.push({
      id: e.id,
      created_at: e.created_at,
      verb: verb || null,
      description: desc || null,
      messagePlain: msgPlain || null,
      author: e.author != null ? String(e.author) : null,
      path: e.path != null ? String(e.path) : null,
      customerEmailEvent,
      pdfUrls,
      anchors: anchors.slice(0, 32),
      invoiceRefs,
      previewHtml: previewHtml || null,
      previewSubject,
      deliveredLikely,
    });
  }

  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return rows;
}

/**
 * Admin/Storefront payloads gebruiken soms numerieke id, soms GID-strings.
 * @param {string|number|null|undefined} id
 * @returns {number|null}
 */
export function shopifyNumericId(id) {
  if (id == null || id === '') return null;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  const s = String(id).trim();
  const gid = s.match(/ProductVariant\/(\d+)\s*$/i) || s.match(/Product\/(\d+)\s*$/i);
  if (gid) return Number(gid[1]);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sommige API-responses geven line_item.image mee (preview), handig zonder apart product-endpoint.
 * @param {any} li
 * @returns {string | null}
 */
export function extractLineItemImageUrl(li) {
  if (!li || typeof li !== 'object') return null;
  const raw =
    li.image ??
    li.featured_image ??
    li.variant_image ??
    li.variant?.image ??
    li.variant?.featured_image;
  if (!raw) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s || null;
  }
  const u = raw.src || raw.url || raw.original_src || raw.preview_image?.src;
  return u && String(u).trim() ? String(u).trim() : null;
}

/**
 * @param {any} product
 * @param {string|number|null|undefined} variantId
 * @param {any[] | null} [imagesOverride] bijv. /products/:id/images.json of storefront .json
 * @returns {string|null}
 */
function resolveVariantImageSrc(product, variantId, imagesOverride) {
  if (!product) return null;
  const imgs = Array.isArray(imagesOverride) && imagesOverride.length
    ? imagesOverride
    : Array.isArray(product.images)
      ? product.images
      : [];
  const byId = new Map(
    imgs.map((im) => [Number(im.id), String(im.src || im.url || '').trim()]).filter(([, s]) => s)
  );

  const vidn = shopifyNumericId(variantId);
  if (vidn != null) {
    const v = (product.variants || []).find((x) => shopifyNumericId(x.id) === vidn);
    if (v?.image_id != null) {
      const src = byId.get(Number(v.image_id));
      if (src) return src;
    }
    // Veel shops koppelen variant ↔ foto via image.variant_ids i.p.v. variant.image_id.
    for (const im of imgs) {
      const ids = Array.isArray(im.variant_ids) ? im.variant_ids : [];
      if (ids.map((x) => shopifyNumericId(x)).some((n) => n === vidn)) {
        const s = String(im.src || im.url || '').trim();
        if (s) return s;
      }
    }
  }
  const featured = product.image?.src || product.image?.url;
  if (featured && String(featured).trim()) return String(featured).trim();
  const first = imgs[0]?.src || imgs[0]?.url;
  if (first && String(first).trim()) return String(first).trim();
  return null;
}

/**
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {string|number} productId
 */
async function fetchProductJson(cfg, productId) {
  const shop = normShopHost(cfg.shopDomain);
  const url = `https://${shop}/admin/api/${API_VERSION}/products/${productId}.json`;
  const maxTry = 3;
  for (let attempt = 0; attempt < maxTry; attempt++) {
    const res = await shopifyAdminFetch(cfg, url, {});
    if (res.status === 429 && attempt < maxTry - 1) {
      const wait = Number(res.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      continue;
    }
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return body.product ?? null;
  }
  return null;
}

/**
 * Losse images-lijst (sommige shops/API-versies vullen product.images niet in één call).
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {string|number} productId
 */
async function fetchProductImagesList(cfg, productId) {
  const shop = normShopHost(cfg.shopDomain);
  const url = `https://${shop}/admin/api/${API_VERSION}/products/${productId}/images.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await shopifyAdminFetch(cfg, url, {});
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      continue;
    }
    if (!res.ok) return [];
    const body = await res.json().catch(() => ({}));
    return Array.isArray(body.images) ? body.images : [];
  }
  return [];
}

/**
 * Publiek JSON-endpoint van de storefront (zelfde data als theme); werkt zonder read_products,
 * zolang het product online staat.
 * @param {string} storeBaseUrl bijv. https://toddie.nl
 * @param {string} handle
 */
async function fetchStorefrontProductByHandle(storeBaseUrl, handle) {
  const base = String(storeBaseUrl || '').replace(/\/$/, '');
  const h = String(handle || '').trim();
  if (!base || !h) return null;
  const url = `${base}/products/${encodeURIComponent(h)}.json`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'RengHelpDesk/1.0 (+https://shopify.dev)',
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 && attempt < 2) {
        const wait = Number(res.headers.get('retry-after')) || 2;
        await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
        continue;
      }
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return body?.product ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {string|number} productId
 */
async function fetchProductMetafields(cfg, productId) {
  const shop = normShopHost(cfg.shopDomain);
  const url = new URL(
    `https://${shop}/admin/api/${API_VERSION}/products/${productId}/metafields.json`
  );
  url.searchParams.set('limit', '250');
  const res = await shopifyAdminFetch(cfg, url, {});
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.metafields) ? body.metafields : [];
}

/**
 * Haalt per uniek product: handles, optioneel miniatuur-map, en productie-/levertijdtekst (metavelden + body).
 * Vereist read_products.
 * @param {{ shopDomain: string, accessToken: string }} cfg
 * @param {any[]} orders
 * @param {{ loadImages?: boolean; storefrontBaseUrl?: string | null; onlyProductIds?: Set<number> | null }} [opts]
 * storefrontBaseUrl: fallback voor afbeeldingen via /products/{handle}.json (publiek).
 * onlyProductIds: alleen deze product-id's ophalen (voor incrementele cache).
 * @returns {Promise<{ imageMap: Record<string, string | null>, handles: Record<string, string>, productionByProductId: Record<string, { hint: string; workingDays: number | null }> }>}
 */
export async function fetchProductThumbnailData(cfg, orders, opts = {}) {
  const loadImages = opts.loadImages !== false;
  const storefrontBaseUrl = opts.storefrontBaseUrl != null ? opts.storefrontBaseUrl : null;
  const only = opts.onlyProductIds instanceof Set ? opts.onlyProductIds : null;
  /** @type {Record<string, string | null>} */
  const imageMap = {};
  /** @type {Record<string, string>} */
  const handles = {};
  /** @type {Record<string, { hint: string; workingDays: number | null }>} */
  const productionByProductId = {};
  const productIds = new Set();
  for (const o of orders) {
    for (const li of o.line_items || []) {
      if (li.product_id != null) {
        const n = Number(li.product_id);
        if (!only || only.has(n)) productIds.add(n);
      }
    }
  }
  const list = [...productIds];
  const conc = Math.min(
    12,
    Math.max(1, Number(process.env.SHOPIFY_PRODUCT_FETCH_CONCURRENCY || 8))
  );
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const pid = list[i];
      try {
        const product = await fetchProductJson(cfg, pid);
        if (!product) continue;
        if (product.handle) handles[String(pid)] = String(product.handle);

        const bodyText = stripHtml(product.body_html || '').slice(0, 5000);
        let mfBlob = '';
        try {
          const metafields = await fetchProductMetafields(cfg, pid);
          mfBlob = metafields.map((m) => metafieldValueString(m)).join('\n');
        } catch {
          mfBlob = '';
        }
        const combined = [bodyText, mfBlob].filter(Boolean).join('\n');
        const prodHint = extractProductionLeadFromBlob(combined);
        if (prodHint) productionByProductId[String(pid)] = prodHint;

        if (loadImages) {
          let merged = Array.isArray(product.images) ? product.images : [];
          if (!merged.length) {
            merged = await fetchProductImagesList(cfg, pid);
          }
          if (
            !merged.length &&
            storefrontBaseUrl &&
            product.handle &&
            String(product.handle).trim()
          ) {
            const sf = await fetchStorefrontProductByHandle(
              storefrontBaseUrl,
              String(product.handle).trim()
            );
            if (sf && Array.isArray(sf.images) && sf.images.length) {
              merged = sf.images;
            }
          }
          for (const v of product.variants || []) {
            const vn = shopifyNumericId(v.id);
            const src = resolveVariantImageSrc(product, v.id, merged);
            if (vn != null) {
              imageMap[`${pid}:${vn}`] = src;
              imageMap[`${pid}:${String(v.id)}`] = src;
            }
          }
          imageMap[`${pid}:`] = resolveVariantImageSrc(product, null, merged);
        }
      } catch {
        /* negeer per product */
      }
    }
  }

  await Promise.all(Array.from({ length: conc }, () => worker()));
  return { imageMap, handles, productionByProductId };
}

/**
 * @param {Record<string, string | null>} imageMap
 * @param {number|string|null|undefined} productId
 * @param {number|string|null|undefined} variantId
 */
function lookupLineImage(imageMap, productId, variantId) {
  if (productId == null) return null;
  const pid = shopifyNumericId(productId);
  if (pid == null) return null;
  const vid = shopifyNumericId(variantId);
  const keys = [];
  if (vid != null) {
    keys.push(`${pid}:${vid}`, `${pid}:${String(variantId).trim()}`);
  }
  if (variantId != null && variantId !== '') {
    keys.push(`${pid}:${variantId}`);
  }
  keys.push(`${pid}:`);
  for (const k of keys) {
    const u = imageMap[k];
    if (u && String(u).trim()) return String(u).trim();
  }
  return null;
}

/**
 * Eén rij per order met alle relevante Shopify-velden voor het dashboard.
 * @param {any[]} orders
 * @param {string} shopDomain host zonder protocol
 * @param {{ imageMap?: Record<string, string | null>; handles?: Record<string, string>; storeBaseUrl?: string | null; productionByProductId?: Record<string, { hint: string; workingDays: number | null }> }} [thumbs]
 */
export function ordersToRichOrderRows(orders, shopDomain, thumbs = {}) {
  const host = normShopHost(shopDomain);
  const adminBase = `https://${host}/admin`;
  const imageMap = thumbs.imageMap || {};
  const handles = thumbs.handles || {};
  const storeBase = (thumbs.storeBaseUrl && String(thumbs.storeBaseUrl).replace(/\/$/, '')) || null;
  const productionByProductId = thumbs.productionByProductId || {};

  return orders.map((order) => {
    const email =
      order.email ||
      order.contact_email ||
      order.customer?.email ||
      order.shipping_address?.email ||
      order.billing_address?.email ||
      null;

    const ship = order.shipping_address;
    const bill = order.billing_address;
    const cust = order.customer;
    const first = cust?.first_name || ship?.first_name || bill?.first_name || '';
    const last = cust?.last_name || ship?.last_name || bill?.last_name || '';
    const customerDisplayName = `${first} ${last}`.trim() || null;

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const previewCap = Number(process.env.SHOPIFY_ORDER_LINE_ITEMS_PREVIEW || '');
    const maxLines = Math.min(
      500,
      Math.max(1, Number.isFinite(previewCap) && previewCap > 0 ? previewCap : 250)
    );
    const parts = lineItems.slice(0, maxLines).map((li) => {
      const title = (li.title || 'Item').slice(0, 80);
      return `${title} ×${li.quantity ?? 1}`;
    });
    let lineItemsSummary = parts.join(' · ');
    if (lineItems.length > maxLines) {
      lineItemsSummary += ` · +${lineItems.length - maxLines} meer`;
    }

    /** @type {{ title: string; quantity: number; imageUrl: string | null; productUrl: string | null; sku: string | null; variantTitle: string | null; unitPrice: string | null; linePrice: string | null; productionHint: string | null; productionWorkingDays: number | null; productionShipByLabel: string | null }[]} */
    const lineItemsPreview = lineItems.slice(0, maxLines).map((li) => {
      const pid = li.product_id;
      const vid = li.variant_id;
      const fromLine = extractLineItemImageUrl(li);
      const imageUrl = fromLine || lookupLineImage(imageMap, pid, vid);
      let productUrl = null;
      if (storeBase && pid != null && handles[String(pid)]) {
        productUrl = `${storeBase}/products/${encodeURIComponent(handles[String(pid)])}`;
      }
      const qty = Number(li.quantity) || 1;
      const unit = li.price != null && li.price !== '' ? Number(li.price) : NaN;
      const linePrice =
        Number.isFinite(unit) && qty > 0 ? String(Number((unit * qty).toFixed(2))) : null;
      const unitPrice = Number.isFinite(unit) ? String(li.price) : null;
      const vt = li.variant_title != null ? String(li.variant_title).trim() : '';
      const variantTitle =
        vt && vt.toLowerCase() !== 'default title' ? vt : null;
      const sku = li.sku != null && String(li.sku).trim() ? String(li.sku).trim() : null;

      let productionHint = null;
      let productionWorkingDays = null;
      let productionShipByLabel = null;
      if (pid != null) {
        const pr = productionByProductId[String(pid)];
        if (pr?.hint) {
          productionHint = pr.hint;
          productionWorkingDays =
            pr.workingDays != null && Number.isFinite(pr.workingDays) ? pr.workingDays : null;
          if (productionWorkingDays != null && order.created_at) {
            productionShipByLabel = formatEndOfBusinessDaysNl(
              order.created_at,
              productionWorkingDays
            );
          }
        }
      }

      return {
        title: li.title || 'Item',
        quantity: qty,
        imageUrl,
        productUrl,
        sku,
        variantTitle,
        unitPrice,
        linePrice,
        productionHint,
        productionWorkingDays,
        productionShipByLabel,
      };
    });

    const shipMoney = order.total_shipping_price_set?.shop_money?.amount;
    const totalShipping =
      shipMoney != null ? String(shipMoney) : order.shipping_lines?.[0]?.price ?? null;

    /** @type {{ company: string | null; number: string; url: string | null }[]} */
    const trackings = [];
    const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
    if (fulfillments.length === 0) {
      trackings.push({ company: null, number: '', url: null });
    } else {
      for (const f of fulfillments) {
        const nums = [
          ...(Array.isArray(f.tracking_numbers) ? f.tracking_numbers : []),
          f.tracking_number,
        ].filter(Boolean);
        const companies = Array.isArray(f.tracking_company)
          ? f.tracking_company
          : [f.tracking_company].filter(Boolean);
        const urls = Array.isArray(f.tracking_urls) ? f.tracking_urls : [];
        if (nums.length === 0) {
          trackings.push({
            company: companies[0] ? String(companies[0]) : null,
            number: '',
            url: urls[0] ? String(urls[0]) : null,
          });
        } else {
          nums.forEach((num, i) => {
            const comp = companies[i] ?? companies[0];
            const u = urls[i] ?? urls[0];
            trackings.push({
              company: comp != null && comp !== '' ? String(comp) : null,
              number: String(num),
              url: u != null && u !== '' ? String(u) : null,
            });
          });
        }
      }
    }

    const shipLines = ship
      ? [ship.address1, ship.address2, [ship.zip, ship.city].filter(Boolean).join(' '), ship.country]
          .filter(Boolean)
          .join('\n')
      : null;

    return {
      shopifyOrderId: order.id,
      shopifyOrderName: order.name,
      adminOrderUrl: `${adminBase}/orders/${order.id}`,
      customerEmail: email,
      customerDisplayName,
      phone: order.phone || ship?.phone || bill?.phone || null,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      processedAt: order.processed_at,
      canceledAt: order.cancelled_at ?? order.canceled_at,
      cancelReason: order.cancel_reason,
      testOrder: Boolean(order.test),
      financialStatus: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      displayFinancialStatus: order.display_financial_status || order.financial_status,
      displayFulfillmentStatus: order.display_fulfillment_status || order.fulfillment_status,
      currency: order.currency || 'EUR',
      totalPrice: order.total_price,
      subtotalPrice: order.subtotal_price,
      totalTax: order.total_tax,
      totalShipping,
      totalDiscounts: order.total_discounts,
      lineItemsSummary: lineItemsSummary || '—',
      lineItemsPreview,
      lineItemsCount: lineItems.length,
      shippingSummary: ship
        ? [ship.city, ship.country, ship.zip].filter(Boolean).join(' · ') || '—'
        : '—',
      shippingLines: shipLines,
      shippingMethod: order.shipping_lines?.map((s) => s.title).filter(Boolean).join(', ') || null,
      paymentGatewayNames: Array.isArray(order.payment_gateway_names)
        ? order.payment_gateway_names
        : [],
      tags: typeof order.tags === 'string' && order.tags.trim() ? order.tags.split(/\s*,\s*/) : [],
      note: order.note ? String(order.note) : null,
      sourceName: order.source_name || null,
      referringSite: order.referring_site || null,
      trackings,
    };
  });
}
