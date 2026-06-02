import './loadEnv.js';
import http from 'http';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchShop,
  fetchRecentOrders,
  fetchAllRecentOrders,
  shopifyOrdersCreatedWithinDaysEffective,
  ordersToRichOrderRows,
  fetchProductThumbnailData,
  fetchOrderTimelineEvents,
  normShopHost,
  searchOrdersForDashboard,
} from './shopify.js';
import {
  isOpenAiConfigured,
  findOrderForMailbox,
  enrichOrderRowForAi,
  orderContextPromptBlock,
  orderContextBlockForCustomerMail,
  isCustomerMailOrderRelated,
  noOrderContextPromptBlock,
  mergeMailOrderHints,
  generateCustomerReplyDraft,
  generateOverviewDeskInsight,
  buildStandardMailReplyText,
  voornaamFromDisplayName,
  customerReplyLanguageLabel,
  detectCustomerReplyLanguage,
  summarizeDpdTrackings,
  hasUsableDpdData,
} from './aiReply.js';
import {
  resolveDeskKnowledge,
  isDeskKnowledgeEnabled,
  listDeskKnowledgeIntents,
} from './deskKnowledge.js';
import {
  translateIncomingMailToDutch,
  plainTextFromMailHtml,
} from './mailTranslate.js';
import { computeDeskHeuristics, deskHintForRow } from './orderInsights.js';
import { getDpdTracking, shouldQueryDpdTracking } from './dpd.js';
import {
  isSmtpConfigured,
  isGmailApiConfigured,
  isMailOutboundConfigured,
  sendOutboundMail,
  getMailSendFromOptions,
  getMailSendChannelLabel,
  isSmtpSendFirst,
  isGmailInvalidGrantError,
} from './mail.js';
import { fetchInboxForUi } from './gmailInbox.js';
import {
  fetchGraphInboxForUi,
  fetchGraphMessageForUi,
  fetchGraphFoldersForUi,
  fetchGraphAttachmentBytes,
  patchGraphMessageRead,
} from './graphInbox.js';
import { isGraphMailConfigured, graphConnectionHints } from './graphMail.js';
import { useGraphForInbound, resolveMailRoutingSummary } from './mailRouting.js';
import {
  loadWorkspaceSettings,
  saveWorkspaceSettings,
  mergeWorkspaceSettings,
  isAiEnabledForSettings,
  isAiAutoTranslateForSettings,
  isDeskKnowledgeEnabledForSettings,
} from './workspaceSettings.js';
import { buildPlatformSettingsPayload } from './platformSettings.js';
import { getDpdCredsFromPlatform } from './platformConfig.js';
import {
  ensurePlatformConfigLoaded,
  mergePlatformConfigPatch,
} from './platformConfigStore.js';
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
import {
  getGmailAuthStatus,
  gmailConnectionHints,
  isGmailSharedEnvMailboxMode,
} from './gmailSession.js';
import { mountDashboardAuthRoutes, dashboardAuthMiddleware } from './dashboardAuth.js';
import { extractCustomerContactFromText } from './mailContactExtract.js';
import {
  resolveOrdersForOverview,
  buildCachedThumbData,
  buildCachedMailLogs,
} from './overviewSync.js';
import { exchangeShopifyClientCredentials } from './shopifyClientCredentials.js';
import {
  saveUserIntegrationDoc,
  deleteUserIntegrationDoc,
  sanitizeDashboardSid,
} from './userIntegrationsStore.js';

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
app.use(compression({ threshold: 2048 }));
app.use(express.json({ limit: '512kb' }));
mountDashboardAuthRoutes(app);
app.use(dashboardAuthMiddleware);
app.use((req, res, next) => {
  void attachUserIntegrations(req, res, next).catch(next);
});
app.use((req, res, next) => {
  void ensurePlatformConfigLoaded()
    .then(() => next())
    .catch((e) => {
      console.error('[platformConfig] startup load:', e instanceof Error ? e.message : e);
      next();
    });
});
mountShopifyAuth(app, { port });
mountGmailAuth(app, { port });

if (String(process.env.VERCEL || '').trim() === '1' && !process.env.DATABASE_URL?.trim()) {
  console.warn(
    '[reng] Vercel zonder DATABASE_URL: gebruik Postgres voor gedeelde Shopify-/Gmail-koppelingen, of vaste SHOPIFY_ACCESS_TOKEN + GOOGLE_GMAIL_REFRESH_TOKEN in env. Anders leven OAuth-koppelingen in /tmp en zijn ze niet betrouwbaar over tijd/instances.'
  );
}

function dpdCreds() {
  return getDpdCredsFromPlatform();
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
 * @param {string} [replyTo]
 */
function extractCustomerContactFromIncoming(incomingText, fallbackEmail, fallbackName, replyTo) {
  return extractCustomerContactFromText({
    text: String(incomingText || ''),
    fallbackEmail: String(fallbackEmail || ''),
    fallbackName: String(fallbackName || ''),
    replyTo: String(replyTo || ''),
  });
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
    const fast = ['1', 'true', 'yes'].includes(String(req.query.fast ?? '').trim().toLowerCase());
    /** Standaard: mail aan. Bij fast: uit tenzij expliciet ?mailLog=1 */
    const includeMailLog =
      req.query.mailLog !== undefined && String(req.query.mailLog).trim() !== ''
        ? String(req.query.mailLog).trim() !== '0'
        : !fast;
    const loadProductImages = String(req.query.productImages ?? '1') !== '0';
    /** Standaard: DPD aan. Bij fast: uit tenzij expliciet ?dpd=1 */
    const runDpdLookup =
      req.query.dpd !== undefined && String(req.query.dpd).trim() !== ''
        ? String(req.query.dpd).trim() !== '0'
        : !fast;
    /** @type {number | null} */
    let ordersFetchMax = null;
    let ordersMayBeTruncated = false;

    // shop.json parallel met order-fetch: scheelt ~1 round-trip. Overslaan als publieke URL al in .env staat.
    const publicStoreUrl = process.env.SHOPIFY_PUBLIC_STORE_URL?.trim();
    const shopInfoPromise = publicStoreUrl
      ? Promise.resolve(null)
      : (async () => {
          for (const att of attempts) {
            try {
              return await fetchShop({
                shopDomain: att.shopDomain,
                accessToken: att.accessToken,
              });
            } catch {
              /* volgende credential */
            }
          }
          return null;
        })();

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
      return 72;
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

    const shopInfo = await shopInfoPromise;
    const storeBaseUrl =
      publicStoreUrl ||
      (shopInfo?.domain
        ? `https://${String(shopInfo.domain).replace(/^https?:\/\//, '')}`
        : null) ||
      (shopInfo?.primaryDomain
        ? `https://${String(shopInfo.primaryDomain).replace(/^https?:\/\//, '')}`
        : null);

    const [orderMailLogs, thumbData] = await Promise.all([
      orders.length > 0 && includeMailLog && ordersCfg
        ? buildCachedMailLogs(
            cacheBackend,
            ordersCfg,
            ordersCfg.shopDomain,
            orders,
            true
          )
        : Promise.resolve(/** @type {Record<string, unknown[]>} */ ({})),
      orders.length > 0 && ordersCfg
        ? buildCachedThumbData(
            cacheBackend,
            ordersCfg,
            ordersCfg.shopDomain,
            orders,
            {
              loadImages: loadProductImages,
              storeBaseUrl,
              skipMetafields: fast,
            }
          )
        : Promise.resolve({
            imageMap: {},
            handles: {},
            productionByProductId: {},
          }),
    ]);
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
    if (dpd && runDpdLookup) {
      /** @type {{ ri: number; t: { number?: string; company?: string | null } }[]} */
      const dpdJobs = [];
      for (let ri = 0; ri < enriched.length; ri++) {
        const row = enriched[ri];
        for (const t of row.trackings) {
          if (!shouldQueryDpdTracking(t)) continue;
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
      /** null = geen datums-filter; anders: alleen orders met created_at in dit venster (Shopify REST). */
      ordersCreatedWithinDays: shopifyOrdersCreatedWithinDaysEffective(),
      shopifyAppId: Boolean(process.env.SHOPIFY_CLIENT_ID?.trim()),
      dpdConfigured: Boolean(dpd),
      smtpConfigured: isSmtpConfigured(),
      gmailApiConfigured: isGmailApiConfigured(req),
      graphMailConfigured: isGraphMailConfigured(),
      mailInboundProvider: useGraphForInbound(req) ? 'graph' : 'gmail',
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
    gmailSharedMailboxMode: Boolean(g.gmailSharedMailboxMode),
    gmailOAuthCallbackUrl: gmailRedirect,
    gmailRedirectUsesEnv: Boolean(fixedGmailRedirect),
    graphMailConfigured: isGraphMailConfigured(),
    graphMailbox: isGraphMailConfigured()
      ? process.env.MICROSOFT_GRAPH_MAILBOX?.trim() || 'info@toddie.nl'
      : null,
    mailInboundProvider: useGraphForInbound(req) ? 'graph' : 'gmail',
    mailRouting: resolveMailRoutingSummary(req),
    dpdConfigured: Boolean(dpdCreds()),
    settingsUrl: '/instellingen.html',
  });
});

/** Platforminstellingen — koppelingen, status en bewerkbare voorkeuren (commercieel dashboard). */
app.get('/api/settings', async (req, res) => {
  try {
    const sid = sanitizeDashboardSid(req.dashboardSid);
    if (!sid) {
      return res.status(401).json({ ok: false, error: 'Niet ingelogd.', loginRequired: true });
    }
    const preferences =
      req.workspaceSettings || (await loadWorkspaceSettings(sid));
    const payload = await buildPlatformSettingsPayload(req, preferences);
    res.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: message });
  }
});

app.patch('/api/settings', async (req, res) => {
  try {
    const sid = sanitizeDashboardSid(req.dashboardSid);
    if (!sid) {
      return res.status(401).json({ ok: false, error: 'Niet ingelogd.', loginRequired: true });
    }
    const current =
      req.workspaceSettings || (await loadWorkspaceSettings(sid));
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let saved = current;
    if (body.preferences && typeof body.preferences === 'object') {
      saved = await saveWorkspaceSettings(
        sid,
        mergeWorkspaceSettings(
          /** @type {Partial<import('./workspaceSettings.js').WorkspaceSettings>} */ (
            body.preferences
          ),
          current
        )
      );
      req.workspaceSettings = saved;
    }
    if (body.platformConfig && typeof body.platformConfig === 'object') {
      await mergePlatformConfigPatch(
        /** @type {Record<string, string>} */ (body.platformConfig)
      );
    }
    const payload = await buildPlatformSettingsPayload(req, saved);
    res.json({ ok: true, saved: true, ...payload });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: message });
  }
});

app.post('/api/settings/disconnect/shopify', async (req, res) => {
  try {
    const sid = sanitizeDashboardSid(req.dashboardSid);
    if (!sid) {
      return res.status(401).json({ ok: false, error: 'Niet ingelogd.', loginRequired: true });
    }
    await deleteUserIntegrationDoc(sid, 'shopify');
    req.userIntegrationShopify = null;
    res.json({ ok: true, message: 'Shopify-koppeling voor jouw account verwijderd.' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Klant-/ordertrefzoek buiten de geladen overview-lijst (GraphQL + REST).
 * Query: ?q=  (min. 2 tekens)
 */
app.get('/api/orders/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ ok: true, rows: [], orderMailLogs: {} });
  }
  try {
    await ensureShopifyAccessForRequest(req);
    const attempts = shopifyCredentialAttemptsForRequest(req);
    if (attempts.length === 0) {
      return res.status(401).json({ error: 'Shopify niet geconfigureerd.' });
    }
    const publicStoreUrl = process.env.SHOPIFY_PUBLIC_STORE_URL?.trim();
    let storeBaseUrl = publicStoreUrl || null;
    if (!storeBaseUrl) {
      for (const att of attempts) {
        try {
          const si = await fetchShop({
            shopDomain: att.shopDomain,
            accessToken: att.accessToken,
          });
          storeBaseUrl = si?.domain
            ? `https://${String(si.domain).replace(/^https?:\/\//, '')}`
            : si?.primaryDomain
              ? `https://${String(si.primaryDomain).replace(/^https?:\/\//, '')}`
              : null;
          if (storeBaseUrl) break;
        } catch {
          /* volgende */
        }
      }
    }
    let lastErr = null;
    for (const att of attempts) {
      const cfg = { shopDomain: att.shopDomain, accessToken: att.accessToken };
      try {
        const orders = await searchOrdersForDashboard(cfg, q);
        const rows = ordersToRichOrderRows(orders, cfg.shopDomain, {
          imageMap: {},
          handles: {},
          storeBaseUrl,
          productionByProductId: {},
        });
        const enriched = rows.map((row) => ({ ...row, dpdTrackings: [] }));
        return res.json({ ok: true, rows: enriched, orderMailLogs: {} });
      } catch (e) {
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

/** Overzicht desk-knowledge intents (playbooks) voor beheer/UI. */
app.get('/api/desk/knowledge', (req, res) => {
  try {
    const envOn = isDeskKnowledgeEnabled();
    const userOn = isDeskKnowledgeEnabledForSettings(req.workspaceSettings);
    res.json({
      ok: true,
      enabled: envOn && userOn,
      intents: listDeskKnowledgeIntents(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/**
 * Genereert een klantmail-concept op basis van geplakte inkomende tekst + Shopify-order (match op e-mail) + DPD.
 * Volgende stap in product: inkomende mail via Microsoft Graph / webhook → deze endpoint → SMTP verzenden (eventueel na goedkeuring).
 */
app.post('/api/ai/reply-draft', async (req, res) => {
  try {
    if (!isOpenAiConfigured() || !isAiEnabledForSettings(req.workspaceSettings)) {
      return res.status(400).json({
        error:
          'AI-antwoorden zijn niet beschikbaar. Zet OPENAI_API_KEY op het platform of schakel AI in onder Instellingen.',
      });
    }
    await ensureShopifyAccessForRequest(req);
    const attempts = shopifyCredentialAttemptsForRequest(req);
    if (attempts.length === 0) {
      return res.status(401).json({ error: 'Shopify niet geconfigureerd.' });
    }
    const body = req.body || {};
    const email = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : '';
    const replyToHeader =
      typeof body.replyTo === 'string' ? body.replyTo.trim() : '';
    const incomingText = typeof body.incomingText === 'string' ? body.incomingText.trim() : '';
    if (!incomingText) {
      return res.status(400).json({
        error: 'Veld incomingText is verplicht.',
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
        : req.workspaceSettings?.defaultReplyStyle &&
            req.workspaceSettings.defaultReplyStyle !== 'default'
          ? req.workspaceSettings.defaultReplyStyle
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

    let senderDisplayName =
      typeof body.senderDisplayName === 'string' ? body.senderDisplayName.trim() : '';
    const extracted = extractCustomerContactFromIncoming(
      incomingText,
      email,
      senderDisplayName,
      replyToHeader
    );
    let effectiveEmail =
      extracted.email && extracted.email.includes('@') ? extracted.email.trim() : email;
    if (extracted.name) senderDisplayName = extracted.name;
    if (!effectiveEmail || !effectiveEmail.includes('@')) {
      return res.status(400).json({
        error:
          'Geen geldig klant-e-mailadres gevonden. Vul “Aan” in, of zet Reply-To / het klantadres in de geplakte mail (niet alleen info@…).',
      });
    }

    /** Bestelnr staat vaak in de body; onderwerp + gekozen order in UI apart voor prioriteit. */
    const headerHint = [incomingSubject || '', shopifyOrderName || ''].filter(Boolean).join('\n');
    const order = await findOrderForMailbox(ordersCfg, {
      customerEmail: effectiveEmail,
      senderName: senderDisplayName,
      subjectHint: headerHint,
      incomingMailBody: incomingText,
    });
    const orderHints = mergeMailOrderHints(incomingText, headerHint);
    const searchKeywords = {
      email: effectiveEmail || '',
      senderName: senderDisplayName || '',
      orderHintsFromSubject: orderHints,
    };

    const dpd = dpdCreds();
    const enriched = order ? await enrichOrderRowForAi(order, ordersCfg.shopDomain, dpd, ordersCfg) : null;

    const orderRelevant = enriched
      ? isCustomerMailOrderRelated(incomingText, incomingSubject)
      : false;
    const deskKnowledge = resolveDeskKnowledge({
      incomingBody: incomingText,
      incomingSubject,
      hasOrderMatch: Boolean(enriched),
      orderRelevantToQuestion: orderRelevant,
      workspaceSettings: req.workspaceSettings,
    });
    const effectiveReplyStyle = replyStyle || deskKnowledge.replyStyle || undefined;

    if (!enriched) {
      const contextBlock = noOrderContextPromptBlock({
        shopName: shopInfo?.name ?? null,
        customerEmail: effectiveEmail,
        senderName: senderDisplayName,
        orderHintsFromSubject: orderHints,
      });
      const draft = await generateCustomerReplyDraft({
        shopName: shopInfo?.name ?? null,
        orderContextBlock: contextBlock,
        incomingSubject,
        incomingBody: incomingText,
        replyStyle: effectiveReplyStyle,
        extraInstructions,
        noOrderMatch: true,
        deskKnowledgeBlock: deskKnowledge.promptBlock,
      });
      return res.json({
        ok: true,
        subject: draft.subject,
        body: draft.body,
        model: draft.model,
        replyLanguage: draft.replyLanguage,
        replyLanguageLabel: customerReplyLanguageLabel(draft.replyLanguage),
        hasDpd: Boolean(draft.hasDpd),
        dpdSummary: draft.dpdSummary || null,
        matchedOrderName: null,
        customerMatched: false,
        searchKeywords,
        deskKnowledge: {
          enabled: deskKnowledge.enabled,
          intentIds: deskKnowledge.intentIds,
          labels: deskKnowledge.labels,
          replyStyle: deskKnowledge.replyStyle,
        },
      });
    }

    const contextBlock = orderContextBlockForCustomerMail(
      enriched,
      shopInfo?.name ?? null,
      incomingText,
      incomingSubject
    );
    const draft = await generateCustomerReplyDraft({
      shopName: shopInfo?.name ?? null,
      orderContextBlock: contextBlock,
      incomingSubject,
      incomingBody: incomingText,
      replyStyle: effectiveReplyStyle,
      extraInstructions,
      orderRelevantToQuestion: orderRelevant,
      deskKnowledgeBlock: deskKnowledge.promptBlock,
    });
    res.json({
      ok: true,
      subject: draft.subject,
      body: draft.body,
      model: draft.model,
      replyLanguage: draft.replyLanguage,
      replyLanguageLabel: customerReplyLanguageLabel(draft.replyLanguage),
      orderRelevantToQuestion: draft.orderRelevantToQuestion ?? orderRelevant,
      hasDpd:
        orderRelevant && hasUsableDpdData(enriched.dpdTrackings),
      dpdSummary:
        orderRelevant ? summarizeDpdTrackings(enriched.dpdTrackings) : null,
      matchedOrderName: enriched.shopifyOrderName,
      customerMatched: true,
      searchKeywords,
      deskKnowledge: {
        enabled: deskKnowledge.enabled,
        intentIds: deskKnowledge.intentIds,
        labels: deskKnowledge.labels,
        replyStyle: deskKnowledge.replyStyle,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/**
 * Vertaal inkomende mailtekst naar Nederlands (voor medewerkers in leesvenster).
 */
app.post('/api/mail/translate-to-nl', async (req, res) => {
  try {
    if (!isOpenAiConfigured()) {
      return res.status(400).json({ error: 'Vertalen vereist OpenAI op het platform.' });
    }
    const body = req.body || {};
    const force = body.force === true;
    if (!force && !isAiAutoTranslateForSettings(req.workspaceSettings)) {
      return res.status(403).json({
        error:
          'Automatisch vertalen staat uit. Klik op Vertaal naar Nederlands of schakel dit in bij Instellingen.',
        translationDisabled: true,
        manualAllowed: true,
      });
    }
    const subject =
      typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : undefined;
    const html = typeof body.html === 'string' ? body.html : '';
    const textIn = typeof body.text === 'string' ? body.text.trim() : '';
    const plain = textIn || plainTextFromMailHtml(html);
    if (!plain) {
      return res.status(400).json({ error: 'Geen tekst om te vertalen.' });
    }
    const result = await translateIncomingMailToDutch({ text: plain, subject });
    res.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Snelle taaldetectie voor mail-leesvenster (geen vertaling). */
app.post('/api/mail/detect-language', (req, res) => {
  try {
    const body = req.body || {};
    const subject =
      typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : undefined;
    const html = typeof body.html === 'string' ? body.html : '';
    const textIn = typeof body.text === 'string' ? body.text.trim() : '';
    const plain = textIn || plainTextFromMailHtml(html);
    const detected = detectCustomerReplyLanguage(plain, subject);
    res.json({
      ok: true,
      detectedLanguage: detected,
      detectedLanguageLabel: customerReplyLanguageLabel(detected),
      needsTranslation: detected !== 'nl' && plain.length >= 12,
      autoTranslateEnabled: isAiAutoTranslateForSettings(req.workspaceSettings),
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
    const replyToHeader =
      typeof body.replyTo === 'string' ? body.replyTo.trim() : '';
    let senderDisplayName =
      typeof body.senderDisplayName === 'string' ? body.senderDisplayName.trim() : '';
    let effectiveEmail = email;
    if (incomingText) {
      const extracted = extractCustomerContactFromIncoming(
        incomingText,
        email,
        senderDisplayName,
        replyToHeader
      );
      if (extracted.email && extracted.email.includes('@')) effectiveEmail = extracted.email.trim();
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

    const headerHint = [subject, snippet, shopifyOrderName || ''].filter(Boolean).join('\n');
    const order = await findOrderForMailbox(ordersCfg, {
      customerEmail: effectiveEmail,
      senderName: senderDisplayName,
      subjectHint: headerHint,
      incomingMailBody: incomingText,
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
        {
          shopName: shopInfo?.name ?? null,
          incomingText,
          incomingSubject: subject || undefined,
        }
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

    const orderRelevant = isCustomerMailOrderRelated(incomingText, subject);
    const vn = voornaamFromDisplayName(enriched.customerDisplayName);
    let text = '';
    let model = null;
    let replyLanguage = null;
    if (isOpenAiConfigured() && incomingText) {
      try {
        const contextBlock = orderContextBlockForCustomerMail(
          enriched,
          shopInfo?.name ?? null,
          incomingText,
          subject || undefined
        );
        const deskKnowledge = resolveDeskKnowledge({
          incomingBody: incomingText,
          incomingSubject: subject || undefined,
          hasOrderMatch: true,
          orderRelevantToQuestion: orderRelevant,
          workspaceSettings: req.workspaceSettings,
        });
        const aiDraft = await generateCustomerReplyDraft({
          shopName: shopInfo?.name ?? null,
          orderContextBlock: contextBlock,
          incomingSubject: subject || undefined,
          incomingBody: incomingText,
          replyStyle: deskKnowledge.replyStyle || 'vriendelijk',
          orderRelevantToQuestion: orderRelevant,
          deskKnowledgeBlock: deskKnowledge.promptBlock,
        });
        text = aiDraft.body;
        model = aiDraft.model;
        replyLanguage = aiDraft.replyLanguage;
      } catch {
        text = '';
      }
    }
    if (!text) {
      text = buildStandardMailReplyText(enriched, vn, topicHint, {
        shopName: shopInfo?.name ?? null,
        incomingText,
        incomingSubject: subject || undefined,
      });
    }

    res.json({
      ok: true,
      subject: replySubject,
      body: text,
      replyLanguage: replyLanguage || undefined,
      replyLanguageLabel: replyLanguage ? customerReplyLanguageLabel(replyLanguage) : undefined,
      matchedOrderName: enriched.shopifyOrderName,
      hasDpd: hasUsableDpdData(enriched.dpdTrackings),
      dpdSummary: summarizeDpdTrackings(enriched.dpdTrackings),
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
    const snippet = typeof req.query.snippet === 'string' ? req.query.snippet.trim() : '';
    const body = typeof req.query.body === 'string' ? req.query.body.trim() : '';

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

    const headerHint = [subject, snippet].filter(Boolean).join('\n');
    const orderHints = mergeMailOrderHints(body, headerHint);
    const searchKeywords = {
      email: email || '',
      senderName: name || '',
      orderHintsFromSubject: orderHints,
    };

    const order = await findOrderForMailbox(ordersCfg, {
      customerEmail: email,
      senderName: name,
      subjectHint: headerHint,
      incomingMailBody: body,
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
            : {
                number: d.number,
                label: d.label,
                rawStatus: d.rawStatus,
                date: d.date,
                location: d.location,
                description: d.description,
                timeline: Array.isArray(d.timeline)
                  ? d.timeline.slice(-6).map((step) => ({
                      label: step.label,
                      status: step.status,
                      date: step.date,
                      location: step.location,
                    }))
                  : [],
              }
        ),
        hasDpd: hasUsableDpdData(enriched.dpdTrackings),
        dpdSummary: summarizeDpdTrackings(enriched.dpdTrackings),
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
    if (!isOpenAiConfigured() || !isAiEnabledForSettings(req.workspaceSettings)) {
      return res.status(400).json({
        error: 'AI-inzicht is niet beschikbaar (platform-key of uitgeschakeld in Instellingen).',
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

/** Mappen (Microsoft Graph). */
app.get('/api/mail/folders', async (req, res) => {
  try {
    if (!useGraphForInbound(req)) {
      return res.status(501).json({
        ok: false,
        error: 'Mappenlijst is alleen beschikbaar met Microsoft Graph.',
      });
    }
    const result = await fetchGraphFoldersForUi();
    res.json({ ok: true, source: 'graph', ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg.slice(0, 400) });
  }
});

/** Inbox — Microsoft Graph (app-only) of gekoppeld Gmail-account. */
app.get('/api/mail/inbox', async (req, res) => {
  try {
    const defaultPage = Math.min(
      250,
      Math.max(1, Number(process.env.MAIL_INBOX_PAGE_SIZE || '') || 100)
    );
    const maxQ = req.query.maxResults != null ? Number(req.query.maxResults) : defaultPage;
    const maxResults = Number.isFinite(maxQ) ? maxQ : defaultPage;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const pageToken =
      typeof req.query.pageToken === 'string' ? req.query.pageToken.trim() : '';
    const folderId =
      typeof req.query.folderId === 'string' ? req.query.folderId.trim() : '';
    const folder =
      typeof req.query.folder === 'string' ? req.query.folder.trim() : 'inbox';

    if (useGraphForInbound(req)) {
      const result = await fetchGraphInboxForUi({
        maxResults,
        q,
        pageToken,
        folderId,
        folder,
      });
      return res.json({ ok: true, source: 'graph', ...result });
    }

    if (!isGmailApiConfigured(req)) {
      const { hints } = gmailConnectionHints(req);
      const graph = graphConnectionHints();
      return res.status(503).json({
        ok: false,
        error: 'Mail-inbox niet gekoppeld (Gmail of Microsoft Graph).',
        gmailConfigured: false,
        graphConfigured: graph.configured,
        hints: [...hints, ...graph.hints],
      });
    }
    const result = await fetchInboxForUi({ req, maxResults, q });
    res.json({ ok: true, source: 'gmail', ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isGmailInvalidGrantError(e)) {
      const shared = isGmailSharedEnvMailboxMode();
      return res.status(403).json({
        ok: false,
        error: shared
          ? 'Gmail-token geweigerd (invalid_grant). Bij een gedeelde mailbox: vernieuw GOOGLE_GMAIL_REFRESH_TOKEN en GOOGLE_CLIENT_SECRET in Vercel (zelfde OAuth-client als in Google Cloud), daarna opnieuw deployen.'
          : 'Gmail-token geweigerd door Google (invalid_grant). Koppel Gmail opnieuw via gmail-koppel.html, of vernieuw GOOGLE_GMAIL_REFRESH_TOKEN in Vercel/.env als je die handmatig gebruikt.',
        gmailInvalidGrant: true,
        gmailInvalidGrantUsesSharedEnv: shared,
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
    const graphInbound = useGraphForInbound(req);
    if (httpStatus === 429 || /\b(429|rate|quota|UserRateLimit|throttl)\b/i.test(msg)) {
      return res.status(429).json({
        ok: false,
        error: graphInbound
          ? 'Microsoft Graph-limiet bereikt. Wacht even en probeer opnieuw.'
          : 'Gmail API-limiet bereikt. Wacht even en probeer opnieuw.',
        rateLimited: true,
        mailProvider: graphInbound ? 'graph' : 'gmail',
      });
    }
    res.status(500).json({ ok: false, error: msg.slice(0, 400) });
  }
});

/** Volledig bericht (Graph: lazy load na lijst met preview). */
app.get('/api/mail/messages/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id ontbreekt.' });
    if (!useGraphForInbound(req)) {
      return res.status(501).json({
        ok: false,
        error: 'Volledig bericht apart laden is alleen voor Microsoft Graph-inbox.',
      });
    }
    const message = await fetchGraphMessageForUi(id);
    try {
      if (!message.isRead) {
        await patchGraphMessageRead(id, true);
        message.isRead = true;
      }
    } catch {
      /* niet fataal */
    }
    res.json({ ok: true, source: 'graph', message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const st = e && typeof e === 'object' && 'status' in e ? Number(e.status) : 500;
    res.status(st >= 400 && st < 600 ? st : 500).json({ ok: false, error: msg.slice(0, 400) });
  }
});

app.get('/api/mail/messages/:id/attachments/:attId', async (req, res) => {
  try {
    if (!useGraphForInbound(req)) {
      return res.status(501).json({ ok: false, error: 'Alleen met Microsoft Graph.' });
    }
    const messageId = String(req.params.id || '').trim();
    const attId = String(req.params.attId || '').trim();
    if (!messageId || !attId) {
      return res.status(400).json({ ok: false, error: 'messageId of attId ontbreekt.' });
    }
    const { name, contentType, buffer } = await fetchGraphAttachmentBytes(messageId, attId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
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
          'Geen mail-uitgang: koppel Gmail via /gmail-koppel.html (of zet GOOGLE_* in .env), of vul SMTP_HOST in .env (SMTP_FROM mag leeg; standaard info@toddie.nl).',
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
    if (isGmailInvalidGrantError(e)) {
      const shared = isGmailSharedEnvMailboxMode();
      return res.status(403).json({
        ok: false,
        error: shared
          ? 'Gmail-token ongeldig (invalid_grant). Beheerder: werk GOOGLE_GMAIL_REFRESH_TOKEN + GOOGLE_CLIENT_SECRET in Vercel bij (npm run vercel:env:google na lokale koppeling).'
          : 'Gmail-token ongeldig (invalid_grant). Koppel opnieuw via gmail-koppel.html of vernieuw de refresh-token in .env/Vercel.',
        gmailInvalidGrant: true,
        gmailInvalidGrantUsesSharedEnv: shared,
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Startscherm = mail; Shopify-orderoverzicht staat op `/orders.html`. */
app.get('/', (_req, res) => {
  res.redirect(302, '/mail.html');
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
      console.log(`Helpdesk: http://localhost:${p}/ → mail · orders: /orders.html`);
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
