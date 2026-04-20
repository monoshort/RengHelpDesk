import './loadEnv.js';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchShop,
  fetchRecentOrders,
  fetchAllRecentOrders,
  ordersToRichOrderRows,
  fetchProductThumbnailData,
  fetchOrderTimelineEvents,
  normShopHost,
} from './shopify.js';
import {
  isOpenAiConfigured,
  findOrderForMailbox,
  enrichOrderRowForAi,
  orderContextPromptBlock,
  noOrderContextPromptBlock,
  orderNameHintsFromSubject,
  generateCustomerReplyDraft,
  generateOverviewDeskInsight,
  buildStandardMailReplyText,
  voornaamFromDisplayName,
} from './aiReply.js';
import { computeDeskHeuristics, deskHintForRow } from './orderInsights.js';
import { getDpdTracking, isLikelyDpdCarrier } from './dpd.js';
import {
  isSmtpConfigured,
  isGmailApiConfigured,
  isMailOutboundConfigured,
  sendOutboundMail,
  getMailSendFromOptions,
  getMailSendChannelLabel,
  isSmtpSendFirst,
} from './mail.js';
import { fetchInboxForUi } from './gmailInbox.js';
import {
  getShopifyAuthStatus,
  shopifyCredentialAttempts,
  ensureShopifySessionAccessTokenFresh,
  writeShopifySession,
  hydrateShopifySessionFromDatabase,
} from './shopifySession.js';
import {
  attachUserIntegrations,
  ensureShopifyAccessForRequest,
  shopifyCredentialAttemptsForRequest,
  getShopifyAuthStatusForRequest,
  shopifyOverviewSetupHintsForRequest,
} from './requestIntegrations.js';
import { mountShopifyAuth } from './shopifyAuth.js';
import { mountGmailAuth } from './gmailAuth.js';
import { getGmailAuthStatus, gmailConnectionHints } from './gmailSession.js';
import { mountDashboardAuthRoutes, dashboardAuthMiddleware } from './dashboardAuth.js';
import {
  resolveOrdersForOverview,
  buildCachedThumbData,
  buildCachedMailLogs,
} from './overviewSync.js';
import { exchangeShopifyClientCredentials } from './shopifyClientCredentials.js';
import { saveUserIntegrationDoc, sanitizeDashboardSid } from './userIntegrationsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = process.env.VERCEL
  ? path.join(process.cwd(), 'static')
  : path.join(__dirname, '..', 'static');

const portEnvRaw = process.env.PORT?.trim();
const portExplicit = portEnvRaw !== undefined && portEnvRaw !== '';
const port = portExplicit ? Number(portEnvRaw) || 3000 : 3000;

const app = express();
if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '512kb' }));
mountDashboardAuthRoutes(app);
app.use(dashboardAuthMiddleware);
app.use((req, res, next) => {
  void attachUserIntegrations(req, res, next).catch(next);
});
mountShopifyAuth(app, { port });
mountGmailAuth(app, { port });

function dpdCreds() {
  const delisId = process.env.DPD_DELIS_ID?.trim();
  const password = process.env.DPD_DELIS_PASSWORD?.trim();
  const useStage = String(process.env.DPD_USE_STAGE).toLowerCase() === 'true';
  if (!delisId || !password) return null;
  return { delisId, password, useStage };
}

/**
 * Pakt de kernvraag uit een klantmail en verwijdert geciteerde thread/signatures.
 * @param {string} incomingText
 * @param {string} snippet
 * @param {string} subject
 */
function buildCustomerTopicHint(incomingText, snippet, subject) {
  const source = String(incomingText || '')
    .replace(/\r/g, '')
    .trim();
  let cleaned = source;
  if (cleaned) {
    cleaned = cleaned.split(/\n(?:Van:|From:|Verzonden:|Sent:|Op .* schreef:|On .* wrote:)/i)[0];
    cleaned = cleaned.split(/\n[-_]{2,}\s*Original Message\s*[-_]{2,}/i)[0];
    cleaned = cleaned.split(/\nVerzonden vanuit Outlook/i)[0];
  }

  const lines = cleaned
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/[{}]/.test(x))
    .filter((x) => !/behavior:url\(#default#VML\)/i.test(x))
    .filter((x) => !/^(beste|hallo|hi|hey)[\s,!]*$/i.test(x))
    .filter((x) => !/^(mvg|met vriendelijke groet|vriendelijke groet)/i.test(x))
    .filter((x) => !/^(van|from|verzonden|sent|onderwerp|subject):/i.test(x))
    .filter((x) => !/^>+/.test(x));

  let head = '';
  for (const line of lines) {
    if (line.length < 3) continue;
    head = line;
    break;
  }
  if (!head) {
    head = String(snippet || '').replace(/\s+/g, ' ').trim();
  }
  if (!head) {
    head = String(subject || '').replace(/\s+/g, ' ').trim();
  }
  return head.slice(0, 180);
}

/**
 * Probeert een nette aanspreeknaam te kiezen voor fallback-mails.
 * @param {string} senderDisplayName
 * @param {string} customerEmail
 */
function resolveGreetingName(senderDisplayName, customerEmail) {
  const display = String(senderDisplayName || '')
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .trim();
  const brandish =
    !display ||
    /toddie|shop|store|support|team|klantenservice|no-reply|noreply/i.test(display) ||
    (/^[^\s]+\.[^\s]+$/.test(display) && !/[A-Z]/.test(display));
  if (!brandish) return voornaamFromDisplayName(display);
  const local = String(customerEmail || '').split('@')[0] || '';
  if (/^(info|support|sales|service|contact|admin|noreply|no-reply)$/i.test(local)) return 'daar';
  const token = local
    .replace(/[._+-]+/g, ' ')
    .trim()
    .split(/\s+/)[0];
  if (!token) return 'daar';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Extra contactextractie uit doorgestuurde/contactformuliertekst.
 * @param {string} incomingText
 * @param {string} fallbackEmail
 * @param {string} fallbackName
 */
function extractCustomerContactFromIncoming(incomingText, fallbackEmail, fallbackName) {
  const text = String(incomingText || '');
  const roleInbox = /^(info|support|sales|service|contact|admin|noreply|no-reply)@/i;
  let email = String(fallbackEmail || '').trim();
  let name = String(fallbackName || '').trim();

  const directEmail = text.match(
    /(?:^|\n)\s*E-?mail:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/im
  );
  const fromEmail = text.match(/<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>/i);
  const anyEmail = text.match(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  const pickedEmail = directEmail?.[1] || fromEmail?.[1] || anyEmail?.[1] || '';
  if ((!email || roleInbox.test(email)) && pickedEmail && !roleInbox.test(pickedEmail)) {
    email = pickedEmail.trim();
  }

  const directName = text.match(/(?:^|\n)\s*Naam:\s*([^\n]+)/i);
  const fromName = text.match(/(?:^|\n)\s*(?:Van|From):\s*([^<\n]+)\s*</i);
  const signName = text.match(
    /(?:groet(?:en)?|met vriendelijke groet|mvg|br)[,\s]*\n+([A-Za-z][A-Za-z .'-]{1,40})/i
  );
  const pickedName = directName?.[1] || fromName?.[1] || signName?.[1] || '';
  if (pickedName && (!name || /toddie|shop|support|team|klantenservice/i.test(name))) {
    name = pickedName.trim();
  }

  return { email, name };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/overview', async (req, res) => {
  try {
    await ensureShopifyAccessForRequest(req);
    const attempts = shopifyCredentialAttemptsForRequest(req);
    if (attempts.length === 0) {
      const err = Object.assign(new Error('SHOPIFY_SETUP'), { code: 'SHOPIFY_SETUP' });
      throw err;
    }
    const cfgPrimary = {
      shopDomain: attempts[0].shopDomain,
      accessToken: attempts[0].accessToken,
    };
    const explicitOrderLimit =
      req.query.limit != null && String(req.query.limit).trim() !== '';
    const fullSync =
      String(req.query.fullSync || req.query.full_sync || '').trim() === '1' ||
      String(req.query.fullSync || req.query.full_sync || '').toLowerCase() === 'true';
    const includeMailLog = String(req.query.mailLog ?? '1') !== '0';
    const loadProductImages = String(req.query.productImages ?? '1') !== '0';
    /** @type {number | null} */
    let ordersFetchMax = null;
    let ordersMayBeTruncated = false;

    // shop.json: alle pogingen (zoals /api/shopify/ping) — .env-token kan 401 geven terwijl OAuth-sessie geldig is.
    let shopInfo = null;
    for (const att of attempts) {
      try {
        shopInfo = await fetchShop({
          shopDomain: att.shopDomain,
          accessToken: att.accessToken,
        });
        break;
      } catch {
        /* volgende credential */
      }
    }

    const storeBaseUrl =
      process.env.SHOPIFY_PUBLIC_STORE_URL?.trim() ||
      (shopInfo?.domain
        ? `https://${String(shopInfo.domain).replace(/^https?:\/\//, '')}`
        : null) ||
      (shopInfo?.primaryDomain
        ? `https://${String(shopInfo.primaryDomain).replace(/^https?:\/\//, '')}`
        : null);

    let orders = [];
    let ordersUnavailable = false;
    let ordersUnavailableReason = null;
    let ordersUnavailableDetail = null;
    /** @type {'env'|'session'|null} */
    let ordersTokenSource = null;
    /** @type {{ shopDomain: string, accessToken: string } | null} */
    let ordersCfg = null;
    let lastOrderErr = null;
    /** @type {'off'|'full'|'incremental'|null} */
    let cacheMode = null;
    /** @type {number | null} */
    let cacheDeltaCount = null;
    /** @type {{ kind: string }} */
    let cacheBackend = { kind: 'none' };

    const envCap = Number(process.env.SHOPIFY_ORDERS_MAX || '');
    let ordersCap =
      Number.isFinite(envCap) && envCap > 0 ? Math.min(50000, envCap) : 250;

    /* Vercel: volledige overview (orders + mail + thumbs + DPD) overschrijdt snel 60s → 504. Cap tenzij expliciet ?limit= of env. */
    const onVercel = String(process.env.VERCEL || '').trim() === '1';
    const vercelOverviewMax = (() => {
      const n = Number(process.env.SHOPIFY_VERCEL_OVERVIEW_ORDERS_MAX || '');
      if (Number.isFinite(n) && n >= 5 && n <= 50000) return Math.floor(n);
      /* Default iets lager: minder Shopify event-calls + sneller eerste response op Hobby/Pro. */
      return 96;
    })();
    /** @type {number | null} */
    let overviewVercelCapApplied = null;
    if (onVercel && !explicitOrderLimit) {
      const before = ordersCap;
      ordersCap = Math.min(ordersCap, vercelOverviewMax);
      if (ordersCap < before) overviewVercelCapApplied = ordersCap;
    }

    for (const att of attempts) {
      const c = { shopDomain: att.shopDomain, accessToken: att.accessToken };
      try {
        if (explicitOrderLimit) {
          const lim = Math.min(250, Math.max(1, Number(req.query.limit) || 40));
          ordersFetchMax = lim;
          const r = await resolveOrdersForOverview(c, c.shopDomain, {
            cap: ordersCap,
            fullSync,
            explicitOrderLimit: lim,
          });
          orders = r.orders;
          ordersMayBeTruncated = orders.length >= lim;
          cacheMode = r.cacheMode;
          cacheDeltaCount = r.cacheDeltaCount;
          cacheBackend = r.backend;
        } else {
          ordersFetchMax = ordersCap;
          const r = await resolveOrdersForOverview(c, c.shopDomain, {
            cap: ordersCap,
            fullSync,
            explicitOrderLimit: null,
          });
          orders = r.orders;
          ordersMayBeTruncated = orders.length >= ordersCap;
          cacheMode = r.cacheMode;
          cacheDeltaCount = r.cacheDeltaCount;
          cacheBackend = r.backend;
        }
        ordersCfg = c;
        ordersTokenSource = att.source;
        break;
      } catch (err) {
        lastOrderErr = err;
      }
    }
    if (!ordersCfg) {
      ordersUnavailable = true;
      const msg =
        lastOrderErr instanceof Error ? lastOrderErr.message : String(lastOrderErr ?? '');
      ordersUnavailableDetail = msg.slice(0, 500);
      if (msg.includes('read_orders')) {
        ordersUnavailableReason = 'read_orders_scope';
      } else if (msg.includes('403')) {
        ordersUnavailableReason = 'forbidden';
      } else {
        ordersUnavailableReason = 'error';
      }
    }

    const orderMailLogs =
      orders.length > 0 && includeMailLog && ordersCfg
        ? await buildCachedMailLogs(
            cacheBackend,
            ordersCfg,
            ordersCfg.shopDomain,
            orders,
            true
          )
        : {};
    let thumbData = { imageMap: {}, handles: {}, productionByProductId: {} };
    if (orders.length > 0 && ordersCfg) {
      thumbData = await buildCachedThumbData(
        cacheBackend,
        ordersCfg,
        ordersCfg.shopDomain,
        orders,
        {
          loadImages: loadProductImages,
          storeBaseUrl,
        }
      );
    }
    const rows = ordersToRichOrderRows(orders, (ordersCfg ?? cfgPrimary).shopDomain, {
      imageMap: thumbData.imageMap,
      handles: thumbData.handles,
      storeBaseUrl,
      productionByProductId: thumbData.productionByProductId,
    });
    const productThumbnails =
      loadProductImages &&
      orders.length > 0 &&
      Object.values(thumbData.imageMap).some((u) => u && String(u).length > 0);
    const dpd = dpdCreds();

    const enriched = rows.map((row) => ({ ...row, dpdTrackings: [] }));
    if (dpd) {
      /** @type {{ ri: number; t: { number?: string; company?: string | null } }[]} */
      const dpdJobs = [];
      for (let ri = 0; ri < enriched.length; ri++) {
        const row = enriched[ri];
        for (const t of row.trackings) {
          if (!t.number) continue;
          const tryDpd =
            isLikelyDpdCarrier(t.company) ||
            /^\d{14}$/.test(t.number.replace(/\s/g, ''));
          if (!tryDpd) continue;
          dpdJobs.push({ ri, t });
        }
      }
      const dpdConc = Math.min(
        12,
        Math.max(1, Number(process.env.DPD_TRACKING_CONCURRENCY || 6))
      );
      let dpdCursor = 0;
      async function dpdWorker() {
        for (;;) {
          const i = dpdCursor++;
          if (i >= dpdJobs.length) return;
          const { ri, t } = dpdJobs[i];
          const out = enriched[ri];
          try {
            const d = await getDpdTracking({
              creds: dpd,
              parcelLabelNumber: t.number,
            });
            out.dpdTrackings.push({
              number: t.number,
              company: t.company,
              label: d.label,
              rawStatus: d.rawStatus,
              location: d.location,
              date: d.date,
              description: d.description,
              timeline: d.timeline,
            });
          } catch (e) {
            out.dpdTrackings.push({
              number: t.number,
              company: t.company,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(dpdConc, Math.max(1, dpdJobs.length)) }, () => dpdWorker()));
    }
    for (const out of enriched) {
      const mailLines = orderMailLogs[String(out.shopifyOrderId)] || [];
      out.deskHint = deskHintForRow(out, mailLines);
    }

    let deskHeuristics = null;
    /** @type {{ withCustomerEmail: number; ordersWithMailEvents: number } | null} */
    let deskContext = null;
    if (!ordersUnavailable && enriched.length > 0) {
      deskHeuristics = computeDeskHeuristics(enriched, orderMailLogs);
      let withCustomerEmail = 0;
      let ordersWithMailEvents = 0;
      for (const r of enriched) {
        if (r.customerEmail) withCustomerEmail++;
        const ev = orderMailLogs[String(r.shopifyOrderId)] || [];
        if (ev.length > 0) ordersWithMailEvents++;
      }
      deskContext = { withCustomerEmail, ordersWithMailEvents };
    }

    res.json({
      generatedAt: new Date().toISOString(),
      shopifyConfigured: true,
      vercelOverviewCap: onVercel ? vercelOverviewMax : null,
      overviewVercelCapApplied,
      cacheMode: cacheMode || 'off',
      cacheDeltaCount,
      shopifyShopOnly: Boolean(ordersUnavailable && shopInfo),
      productThumbnails,
      ordersUnavailable,
      ordersUnavailableReason,
      ordersUnavailableDetail,
      ordersTokenSource,
      ordersTriedTokenSources: attempts.map((a) => a.source),
      shop: shopInfo,
      orderCount: orders.length,
      ordersFetchMax,
      ordersMayBeTruncated,
      shopifyAppId: Boolean(process.env.SHOPIFY_CLIENT_ID?.trim()),
      dpdConfigured: Boolean(dpd),
      smtpConfigured: isSmtpConfigured(),
      gmailApiConfigured: isGmailApiConfigured(req),
      mailOutboundConfigured: isMailOutboundConfigured(req),
      openAiConfigured: isOpenAiConfigured(),
      deskHeuristics,
      deskContext,
      orderMailLogs,
      rows: enriched,
    });
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'SHOPIFY_SETUP') {
      const st = await getShopifyAuthStatusForRequest(req);
      const callbackUrl =
        process.env.SHOPIFY_REDIRECT_URI?.trim() ||
        `http://localhost:${port}/api/auth/callback`;
      return res.status(401).json({
        error:
          'Geen Admin API-toegang: er is geen access token (env of OAuth-sessie). Shop-domein kan wel al goed staan.',
        setupRequired: true,
        hasShop: st.hasShop,
        hasToken: st.hasToken,
        shopDomain: st.shopDomain,
        hasOAuthCreds: st.hasOAuthCreds,
        oauthCallbackUrl: callbackUrl,
        credentialAttempts: shopifyCredentialAttemptsForRequest(req).length,
        setupHints: shopifyOverviewSetupHintsForRequest(req),
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Snelle diagnose: toont géén secrets, wel of de API antwoordt. Zelfde credential-volgorde als /api/overview (OAuth met refresh vóór .env). */
app.get('/api/shopify/ping', async (_req, res) => {
  await ensureShopifySessionAccessTokenFresh();
  const attempts = shopifyCredentialAttempts();
  if (attempts.length === 0) {
    const st = await getShopifyAuthStatus();
    if (!st.hasShop) {
      return res.json({
        ok: false,
        step: 'shop',
        message: 'SHOPIFY_SHOP_DOMAIN ontbreekt in .env (en geen geldige OAuth-sessie).',
      });
    }
    return res.json({
      ok: false,
      step: 'token',
      shop: st.shopDomain,
      message:
        'Geen access token. Zet SHOPIFY_ACCESS_TOKEN (shpat_…) in .env, of rond OAuth af via /koppel.html.',
      oauthHint:
        'Als OAuth blijft falen: zet OAUTH_SKIP_HMAC_VERIFY=true in .env voor alleen lokaal testen, of gebruik handmatig de Admin API-token uit Shopify.',
    });
  }
  const ver = process.env.SHOPIFY_API_VERSION?.trim() || '2025-10';
  /** @type {string | null} */
  let lastErr = null;
  for (const att of attempts) {
    const cfg = { shopDomain: att.shopDomain, accessToken: att.accessToken };
    try {
      const shopInfo = await fetchShop(cfg);
      return res.json({
        ok: true,
        apiVersion: ver,
        shop: normShopHost(cfg.shopDomain),
        shopName: shopInfo?.name ?? null,
        credentialSource: att.source,
      });
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return res.json({
    ok: false,
    step: 'api',
    apiVersion: ver,
    shop: normShopHost(attempts[0]?.shopDomain || ''),
    message: (lastErr || 'Alle Shopify-credentials geweigerd.').slice(0, 400),
    triedSources: attempts.map((a) => a.source),
  });
});

/**
 * Haalt Admin API-token via Client Credentials (Custom app) en slaat die op voor de ingelogde dashboard-sessie.
 * Gebruikt SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET uit .env — géén secrets in de browser.
 */
app.post('/api/shopify/token-client-credentials', async (req, res) => {
  try {
    const sid = sanitizeDashboardSid(req.dashboardSid);
    if (!sid) {
      return res.status(401).json({ ok: false, error: 'Niet ingelogd.' });
    }
    const shopInput =
      (typeof req.body?.shop === 'string' && req.body.shop.trim()) ||
      process.env.SHOPIFY_SHOP_DOMAIN?.trim() ||
      '';
    const clientId = process.env.SHOPIFY_CLIENT_ID?.trim() || '';
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim() || '';
    const { shop, data } = await exchangeShopifyClientCredentials({
      shopInput,
      clientId,
      clientSecret,
    });
    const now = Date.now();
    /** @type {Record<string, unknown>} */
    const doc = {
      shop,
      access_token: data.access_token,
      ...(data.expires_in != null && Number.isFinite(Number(data.expires_in))
        ? { expires_at: now + Number(data.expires_in) * 1000 }
        : {}),
      ...(data.scope ? { scope: String(data.scope) } : {}),
    };
    await saveUserIntegrationDoc(sid, 'shopify', doc);
    try {
      await writeShopifySession(shop, {
        access_token: data.access_token,
        ...(data.expires_in != null && Number.isFinite(Number(data.expires_in))
          ? { expires_in: Number(data.expires_in) }
          : {}),
        ...(data.scope ? { scope: String(data.scope) } : {}),
      });
      await hydrateShopifySessionFromDatabase();
    } catch (e) {
      console.warn(
        '[shopify] token-client-credentials: globale sessie niet bijgewerkt:',
        e instanceof Error ? e.message : e
      );
    }
    const tok = String(data.access_token);
    const masked = tok.length > 10 ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : '…';
    res.json({
      ok: true,
      shop,
      message:
        'Token opgeslagen voor deze sessie en (indien mogelijk) gedeelde server-sessie. Ververs het orderoverzicht. Als Vercel nog een oude SHOPIFY_ACCESS_TOKEN heeft, werk die in Vercel bij of zet SHOPIFY_ENV_TOKEN_FIRST=false.',
      tokenMasked: masked,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg.slice(0, 500) });
  }
});

app.get('/api/config', async (req, res) => {
  const st = await getShopifyAuthStatusForRequest(req);
  const callbackUrl =
    process.env.SHOPIFY_REDIRECT_URI?.trim() ||
    `http://localhost:${port}/api/auth/callback`;
  const g = getGmailAuthStatus(req);
  const fixedGmailRedirect = process.env.GOOGLE_REDIRECT_URI?.trim();
  const host = req.get('host') || `localhost:${port}`;
  const proto = req.protocol || 'http';
  const gmailRedirect =
    fixedGmailRedirect || `${proto}://${host}/api/auth/gmail/callback`;
  res.json({
    shopifyReady: st.hasShop && st.hasToken,
    shop: st.shopDomain,
    hasShop: st.hasShop,
    hasToken: st.hasToken,
    hasOAuthCreds: st.hasOAuthCreds,
    shopifySessionPostgres: st.shopifySessionPostgres,
    userShopifyLinked: Boolean(st.userShopifyLinked),
    oauthCallbackUrl: callbackUrl,
    credentialAttempts: shopifyCredentialAttemptsForRequest(req).length,
    setupHints: shopifyOverviewSetupHintsForRequest(req),
    gmailReady: g.hasRefreshToken && g.hasOAuthCreds,
    gmailHasOAuthCreds: g.hasOAuthCreds,
    gmailHasRefreshToken: g.hasRefreshToken,
    gmailSenderEmail: g.senderEmail,
    userGmailLinked: Boolean(g.userGmailLinked),
    gmailUsesSharedEnvToken: Boolean(g.gmailUsesSharedEnvToken),
    gmailOAuthCallbackUrl: gmailRedirect,
    gmailRedirectUsesEnv: Boolean(fixedGmailRedirect),
  });
});

/** Volledige order-timeline (Shopify events) + geparste PDF/factuur/mail-preview velden. */
app.get('/api/orders/:orderId/timeline', async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!/^\d+$/.test(orderId)) {
    return res.status(400).json({ error: 'Alleen numeriek Shopify order-id.' });
  }
  try {
    await ensureShopifyAccessForRequest(req);
    const attempts = shopifyCredentialAttemptsForRequest(req);
    if (attempts.length === 0) {
      return res.status(401).json({ error: 'Shopify niet geconfigureerd.' });
    }
    let lastErr = null;
    for (const att of attempts) {
      try {
        const events = await fetchOrderTimelineEvents(
          { shopDomain: att.shopDomain, accessToken: att.accessToken },
          orderId
        );
        const shop = normShopHost(att.shopDomain);
        return res.json({
          ok: true,
          orderId,
          shopDomain: shop,
          adminOrderUrl: `https://${shop}/admin/orders/${orderId}`,
          events,
        });
      } catch (e) {
        const status = typeof e === 'object' && e && 'status' in e ? Number(e.status) : NaN;
        if (status === 404) {
          return res.status(404).json({ error: 'Order niet gevonden voor dit account.' });
        }
        lastErr = e;
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '');
    return res.status(502).json({ error: message.slice(0, 400) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: message });
  }
});

/**
 * Genereert een klantmail-concept op basis van geplakte inkomende tekst + Shopify-order (match op e-mail) + DPD.
 * Volgende stap in product: inkomende mail via Microsoft Graph / webhook → deze endpoint → SMTP verzenden (eventueel na goedkeuring).
 */
app.post('/api/ai/reply-draft', async (req, res) => {
  try {
    if (!isOpenAiConfigured()) {
      return res.status(400).json({
        error: 'Zet OPENAI_API_KEY in .env om AI-antwoorden te genereren.',
      });
    }
    await ensureShopifyAccessForRequest(req);
    const attempts = shopifyCredentialAttemptsForRequest(req);
    if (attempts.length === 0) {
      return res.status(401).json({ error: 'Shopify niet geconfigureerd.' });
    }
    const body = req.body || {};
    const email = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : '';
    const incomingText = typeof body.incomingText === 'string' ? body.incomingText.trim() : '';
    if (!email || !incomingText) {
      return res.status(400).json({
        error: 'Velden customerEmail en incomingText zijn verplicht.',
      });
    }
    const shopifyOrderName =
      typeof body.shopifyOrderName === 'string' && body.shopifyOrderName.trim()
        ? body.shopifyOrderName.trim()
        : null;
    const incomingSubject =
      typeof body.incomingSubject === 'string' && body.incomingSubject.trim()
        ? body.incomingSubject.trim()
        : undefined;
    const replyStyle =
      typeof body.replyStyle === 'string' && body.replyStyle.trim()
        ? body.replyStyle.trim()
        : undefined;
    const extraInstructions =
      typeof body.extraInstructions === 'string' && body.extraInstructions.trim()
        ? body.extraInstructions.trim()
        : undefined;

    let ordersCfg = null;
    let lastOrderErr = null;
    for (const att of attempts) {
      const c = { shopDomain: att.shopDomain, accessToken: att.accessToken };
      try {
        await fetchRecentOrders(c, { limit: 1 });
        ordersCfg = c;
        break;
      } catch (err) {
        lastOrderErr = err;
      }
    }
    if (!ordersCfg) {
      const msg =
        lastOrderErr instanceof Error ? lastOrderErr.message : String(lastOrderErr ?? '');
      return res.status(503).json({
        error: msg.slice(0, 400) || 'Shopify orders niet bereikbaar.',
      });
    }

    let shopInfo = null;
    try {
      shopInfo = await fetchShop(ordersCfg);
    } catch {
      shopInfo = null;
    }

    const senderDisplayName =
      typeof body.senderDisplayName === 'string' ? body.senderDisplayName.trim() : '';
    const subjectForMatch = [incomingSubject || '', shopifyOrderName || ''].filter(Boolean).join(' ');
    const order = await findOrderForMailbox(ordersCfg, {
      customerEmail: email,
      senderName: senderDisplayName,
      subjectHint: subjectForMatch,
    });
    const orderHints = orderNameHintsFromSubject(incomingSubject || '');
    const searchKeywords = {
      email: email || '',
      senderName: senderDisplayName || '',
      orderHintsFromSubject: orderHints,
    };

    const dpd = dpdCreds();
    const enriched = order ? await enrichOrderRowForAi(order, ordersCfg.shopDomain, dpd, ordersCfg) : null;

    if (!enriched) {
      const contextBlock = noOrderContextPromptBlock({
        shopName: shopInfo?.name ?? null,
        customerEmail: email,
        senderName: senderDisplayName,
        orderHintsFromSubject: orderHints,
      });
      const draft = await generateCustomerReplyDraft({
        shopName: shopInfo?.name ?? null,
        orderContextBlock: contextBlock,
        incomingSubject,
        incomingBody: incomingText,
        replyStyle,
        extraInstructions,
        noOrderMatch: true,
      });
      return res.json({
        ok: true,
        subject: draft.subject,
        body: draft.body,
        model: draft.model,
        matchedOrderName: null,
        customerMatched: false,
        searchKeywords,
      });
    }

    const contextBlock = orderContextPromptBlock(enriched, shopInfo?.name ?? null);
    const draft = await generateCustomerReplyDraft({
      shopName: shopInfo?.name ?? null,
      orderContextBlock: contextBlock,
      incomingSubject,
      incomingBody: incomingText,
      replyStyle,
      extraInstructions,
    });
    res.json({
      ok: true,
      subject: draft.subject,
      body: draft.body,
      model: draft.model,
      matchedOrderName: enriched.shopifyOrderName,
      customerMatched: true,
      searchKeywords,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/**
 * Vast antwoord (geen OpenAI) met Shopify-order + DPD-tijdlijn voor de mail-UI.
 */
app.post('/api/mail/standard-reply', async (req, res) => {
  try {
    const body = req.body || {};
    const email = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : '';
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Geldig customerEmail is verplicht.' });
    }
    const shopifyOrderName =
      typeof body.shopifyOrderName === 'string' && body.shopifyOrderName.trim()
        ? body.shopifyOrderName.trim()
        : null;
    const subject = typeof body.subject === 'string' ? body.subject : '';
    const snippet = typeof body.snippet === 'string' ? body.snippet : '';
    const incomingText = typeof body.incomingText === 'string' ? body.incomingText.trim() : '';
    let senderDisplayName =
      typeof body.senderDisplayName === 'string' ? body.senderDisplayName.trim() : '';
    let effectiveEmail = email;
    if (incomingText) {
      const extracted = extractCustomerContactFromIncoming(incomingText, email, senderDisplayName);
      if (extracted.email && extracted.email.includes('@')) effectiveEmail = extracted.email;
      if (extracted.name) senderDisplayName = extracted.name;
    }

    await ensureShopifyAccessForRequest(req);
    let ordersCfg = null;
    let lastOrderErr = null;
    for (const att of shopifyCredentialAttemptsForRequest(req)) {
      const c = { shopDomain: att.shopDomain, accessToken: att.accessToken };
      try {
        await fetchRecentOrders(c, { limit: 1 });
        ordersCfg = c;
        break;
      } catch (err) {
        lastOrderErr = err;
      }
    }
    if (!ordersCfg) {
      return res.status(503).json({
        error:
          lastOrderErr instanceof Error
            ? lastOrderErr.message.slice(0, 400)
            : 'Shopify niet bereikbaar.',
      });
    }

    let shopInfo = null;
    try {
      shopInfo = await fetchShop(ordersCfg);
    } catch {
      shopInfo = null;
    }

    const topicHint = buildCustomerTopicHint(incomingText, snippet, subject);

    const replySubject = (() => {
      const raw = String(subject || '').trim();
      if (/^re:\s*/i.test(raw)) return raw;
      return raw ? `Re: ${raw}` : 'Re: uw bericht';
    })();

    const subjectForMatch = [subject, snippet, shopifyOrderName || ''].filter(Boolean).join(' ');
    const order = await findOrderForMailbox(ordersCfg, {
      customerEmail: effectiveEmail,
      senderName: senderDisplayName,
      subjectHint: subjectForMatch,
    });

    if (!order) {
      const vn = resolveGreetingName(senderDisplayName, effectiveEmail);
      const fallback = buildStandardMailReplyText(
        {
          shopifyOrderName: null,
          customerDisplayName: null,
          dpdTrackings: [],
          trackings: [],
          fulfillmentStatus: null,
        },
        vn,
        topicHint,
        { shopName: shopInfo?.name ?? null }
      );
      return res.json({
        ok: true,
        subject: replySubject,
        body: fallback,
        matchedOrderName: null,
        hasDpd: false,
      });
    }

    const dpd = dpdCreds();
    const enriched = await enrichOrderRowForAi(order, ordersCfg.shopDomain, dpd, ordersCfg);
    if (!enriched) {
      return res.status(500).json({ error: 'Kon ordercontext niet opbouwen.' });
    }

    const vn = voornaamFromDisplayName(enriched.customerDisplayName);
    let text = '';
    let model = null;
    if (isOpenAiConfigured() && incomingText) {
      try {
        const contextBlock = orderContextPromptBlock(enriched, shopInfo?.name ?? null);
        const aiDraft = await generateCustomerReplyDraft({
          shopName: shopInfo?.name ?? null,
          orderContextBlock: contextBlock,
          incomingSubject: subject || undefined,
          incomingBody: incomingText,
          replyStyle: 'vriendelijk',
        });
        text = aiDraft.body;
        model = aiDraft.model;
      } catch {
        text = '';
      }
    }
    if (!text) {
      text = buildStandardMailReplyText(enriched, vn, topicHint, {
        shopName: shopInfo?.name ?? null,
      });
    }

    res.json({
      ok: true,
      subject: replySubject,
      body: text,
      matchedOrderName: enriched.shopifyOrderName,
      hasDpd: Boolean((enriched.dpdTrackings || []).filter((d) => !d.error).length),
      dpdSummary: (() => {
        const first = (enriched.dpdTrackings || []).find((d) => d && !d.error && (d.label || d.rawStatus));
        if (!first) return null;
        const parts = [first.label || first.rawStatus];
        if (first.date) parts.push(first.date);
        if (first.location) parts.push(first.location);
        return parts.filter(Boolean).join(' · ');
      })(),
      model,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Shopify-order + status bij geselecteerde mail (e-mail, afzendernaam, #order in onderwerp). */
app.get('/api/mail/order-context', async (req, res) => {
  try {
    await ensureShopifyAccessForRequest(req);
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const subject = typeof req.query.subject === 'string' ? req.query.subject.trim() : '';

    let ordersCfg = null;
    for (const att of shopifyCredentialAttemptsForRequest(req)) {
      const c = { shopDomain: att.shopDomain, accessToken: att.accessToken };
      try {
        await fetchRecentOrders(c, { limit: 1 });
        ordersCfg = c;
        break;
      } catch {
        /* next */
      }
    }
    if (!ordersCfg) {
      return res.status(503).json({ ok: false, error: 'Shopify niet geconfigureerd.' });
    }

    const orderHints = orderNameHintsFromSubject(subject);
    const searchKeywords = {
      email: email || '',
      senderName: name || '',
      orderHintsFromSubject: orderHints,
    };

    const order = await findOrderForMailbox(ordersCfg, {
      customerEmail: email,
      senderName: name,
      subjectHint: subject,
    });
    if (!order) {
      return res.json({ ok: true, match: null, searchKeywords });
    }

    const dpd = dpdCreds();
    const enriched = await enrichOrderRowForAi(order, ordersCfg.shopDomain, dpd, ordersCfg);
    if (!enriched) {
      return res.json({ ok: true, match: null, searchKeywords });
    }

    const shop = normShopHost(ordersCfg.shopDomain);
    const oid = enriched.shopifyOrderId;
    res.json({
      ok: true,
      searchKeywords,
      match: {
        shopifyOrderName: enriched.shopifyOrderName,
        shopifyOrderId: oid,
        customerDisplayName: enriched.customerDisplayName,
        displayFinancialStatus: enriched.displayFinancialStatus,
        displayFulfillmentStatus: enriched.displayFulfillmentStatus,
        lineItemsSummary: enriched.lineItemsSummary,
        adminOrderUrl: `https://${shop}/admin/orders/${oid}`,
        dpdTrackings: (enriched.dpdTrackings || []).map((d) =>
          d.error
            ? {
                number: d.number,
                error: true,
                errorMessage: typeof d.error === 'string' ? d.error : String(d.error ?? ''),
              }
            : { number: d.number, label: d.label, date: d.date, location: d.location }
        ),
        trackings: (enriched.trackings || []).map((t) => ({
          company: t.company,
          number: t.number,
          url: t.url,
        })),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: message.slice(0, 400) });
  }
});

/**
 * AI-interpretatie van het batch-overzicht (tellingen + samples). Geen her-fetch van Shopify.
 */
app.post('/api/ai/desk-insight', async (req, res) => {
  try {
    if (!isOpenAiConfigured()) {
      return res.status(400).json({
        error: 'Zet OPENAI_API_KEY in .env voor AI-inzicht.',
      });
    }
    const body = req.body || {};
    const deskHeuristics = body.deskHeuristics;
    if (!deskHeuristics || typeof deskHeuristics !== 'object') {
      return res.status(400).json({
        error: 'Body moet deskHeuristics bevatten (zoals in GET /api/overview).',
      });
    }
    const shopName =
      typeof body.shopName === 'string' && body.shopName.trim()
        ? body.shopName.trim()
        : null;
    const orderCount = Number(body.orderCount);
    const payload = {
      shopName,
      orderCount: Number.isFinite(orderCount) ? orderCount : null,
      ordersMayBeTruncated: Boolean(body.ordersMayBeTruncated),
      deskContext: body.deskContext && typeof body.deskContext === 'object' ? body.deskContext : null,
      deskHeuristics,
    };
    const insight = await generateOverviewDeskInsight(payload);
    res.json({ ok: true, ...insight });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/**
 * Google OAuth token endpoint: verlopen/ingetrokken refresh token, verkeerde client_secret, enz.
 * @param {unknown} e
 */
function isGmailInvalidGrantError(e) {
  const parts = [];
  if (e instanceof Error) {
    parts.push(e.message);
    if ('cause' in e && e.cause instanceof Error) parts.push(e.cause.message);
  } else parts.push(String(e ?? ''));
  const blob = parts.join(' ').toLowerCase();
  if (blob.includes('invalid_grant')) return true;
  if (e && typeof e === 'object' && 'response' in e) {
    const raw = /** @type {{ response?: { data?: unknown } }} */ (e).response?.data;
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : null;
    if (d && String(d.error || '').toLowerCase() === 'invalid_grant') return true;
    if (d && String(d.error_description || '').toLowerCase().includes('invalid_grant')) return true;
  }
  if (blob.includes('token has been expired') || blob.includes('token has been revoked')) return true;
  return false;
}

/** Inbox van gekoppeld Gmail-account (vereist OAuth-scope gmail.readonly). */
app.get('/api/mail/inbox', async (req, res) => {
  try {
    if (!isGmailApiConfigured(req)) {
      const { hints } = gmailConnectionHints(req);
      return res.status(503).json({
        ok: false,
        error: 'Gmail niet gekoppeld.',
        gmailConfigured: false,
        hints,
      });
    }
    const maxQ = req.query.maxResults != null ? Number(req.query.maxResults) : 40;
    const maxResults = Number.isFinite(maxQ) ? maxQ : 40;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const result = await fetchInboxForUi({ req, maxResults, q });
    res.json({ ok: true, source: 'gmail', ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isGmailInvalidGrantError(e)) {
      return res.status(403).json({
        ok: false,
        error:
          'Gmail-token geweigerd door Google (invalid_grant). Koppel Gmail opnieuw via gmail-koppel.html, of vernieuw GOOGLE_GMAIL_REFRESH_TOKEN in Vercel/.env als je die handmatig gebruikt.',
        gmailInvalidGrant: true,
      });
    }
    let httpStatus;
    if (e && typeof e === 'object' && 'response' in e) {
      const r = /** @type {{ response?: { status?: number } }} */ (e).response;
      httpStatus = r?.status;
    }
    if (httpStatus === 403 || /Insufficient Permission/i.test(msg)) {
      return res.status(403).json({
        ok: false,
        error:
          'Inbox lezen vereist de OAuth-scope gmail.readonly. Voeg die toe in Google Cloud (OAuth consent → Scopes), trek app-toegang in bij Google en koppel opnieuw via /gmail-koppel.html.',
        needsGmailReadonly: true,
      });
    }
    if (httpStatus === 429 || /\b(429|rate|quota|UserRateLimit)\b/i.test(msg)) {
      return res.status(429).json({
        ok: false,
        error: 'Gmail API-limiet bereikt. Wacht even en probeer opnieuw.',
        rateLimited: true,
      });
    }
    res.status(500).json({ ok: false, error: msg.slice(0, 400) });
  }
});

app.get('/api/mail/from-options', (req, res) => {
  try {
    if (!isMailOutboundConfigured(req)) {
      return res.status(400).json({
        error:
          'Geen mail-uitgang: koppel Gmail of SMTP (zie .env / gmail-koppel.html).',
      });
    }
    const { defaultFrom, options } = getMailSendFromOptions(req);
    res.json({ ok: true, defaultFrom, options, smtpSendFirst: isSmtpSendFirst() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post('/api/mail/send', async (req, res) => {
  try {
    if (!isMailOutboundConfigured(req)) {
      return res.status(400).json({
        error:
          'Geen mail-uitgang: koppel Gmail via /gmail-koppel.html (of zet GOOGLE_* in .env), of vul SMTP_HOST + SMTP_FROM in .env.',
      });
    }
    const { to, subject, text, html, replyTo, from, threadId } = req.body || {};
    const toStr = typeof to === 'string' ? to.trim() : '';
    const subStr = typeof subject === 'string' ? subject.trim() : '';
    const textStr = typeof text === 'string' ? text.trim() : '';
    if (!toStr || !subStr || !textStr) {
      return res.status(400).json({ error: 'Velden to, subject en text zijn verplicht.' });
    }
    const fromStr = typeof from === 'string' && from.trim() ? from.trim() : undefined;
    const threadIdStr =
      typeof threadId === 'string' && threadId.trim() ? threadId.trim() : undefined;
    await sendOutboundMail({
      req,
      to: toStr,
      subject: subStr,
      text: textStr,
      html: typeof html === 'string' ? html : undefined,
      replyTo: typeof replyTo === 'string' ? replyTo.trim() : undefined,
      from: fromStr,
      threadId: threadIdStr,
    });
    res.json({ ok: true, via: getMailSendChannelLabel(req) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Na alle API-routes: statische bestanden (anders kan `/api/...` soms verkeerd door static gaan). */
app.use(express.static(publicDir));

export default app;

// Op Vercel (serverless) geen listen. Lokaal kan VERCEL=1 blijven staan na `vercel pull`; `npm start` moet wél luisteren.
// `VERCEL_URL` is gezet op deployments; `npm_lifecycle_event=start` bij `npm start`.
const skipListen =
  process.env.VERCEL === '1' &&
  process.env.npm_lifecycle_event !== 'start' &&
  Boolean(process.env.VERCEL_URL?.trim());

if (!skipListen) {
  const portMaxFallback = portExplicit ? port : port + 25;

  /** @param {number} p */
  function tryListen(p) {
    const server = http.createServer(app);
    server.listen(p, () => {
      // eslint-disable-next-line no-console
      console.log(`Dashboard: http://localhost:${p}`);
      if (!portExplicit && p !== port) {
        // eslint-disable-next-line no-console
        console.warn(
          `Poort ${port} was bezet; server draait nu op ${p}. Open die URL in de browser. Zet PORT=${p} in .env als dit vast moet, of stop het andere proces op ${port}.`
        );
      }
    });
    server.on('error', (err) => {
      const e = /** @type {NodeJS.ErrnoException} */ (err);
      const canBump = e.code === 'EADDRINUSE' && !portExplicit && p < portMaxFallback;
      server.close(() => {
        if (canBump) {
          tryListen(p + 1);
          return;
        }
        if (e.code === 'EADDRINUSE') {
          // eslint-disable-next-line no-console
          console.error(
            `Poort ${p} is al in gebruik. Stop de andere Node/terminal (of het oude "npm start"), of zet een andere poort in .env (PORT=...) en pas SHOPIFY_REDIRECT_URI + Shopify redirect-URL aan.`
          );
        } else {
          // eslint-disable-next-line no-console
          console.error(e);
        }
        process.exit(1);
      });
    });
  }

  tryListen(port);
}
