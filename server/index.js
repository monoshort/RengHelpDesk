import './loadEnv.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchShop,
  fetchRecentOrders,
  fetchAllRecentOrders,
  fetchMailLogsForOrderIds,
  fetchProductThumbnailData,
  ordersToRichOrderRows,
  fetchOrderTimelineEvents,
  normShopHost,
} from './shopify.js';
import {
  isOpenAiConfigured,
  findOrderForReply,
  enrichOrderRowForAi,
  orderContextPromptBlock,
  generateCustomerReplyDraft,
  generateOverviewDeskInsight,
} from './aiReply.js';
import { computeDeskHeuristics, deskHintForRow } from './orderInsights.js';
import { getDpdTracking, isLikelyDpdCarrier } from './dpd.js';
import { isSmtpConfigured, sendSmtpMail } from './mail.js';
import {
  readShopifySession,
  getShopifyAuthStatus,
  shopifyCredentialAttempts,
  shopifyOverviewSetupHints,
} from './shopifySession.js';
import { mountShopifyAuth } from './shopifyAuth.js';
import { mountDashboardAuthRoutes, dashboardAuthMiddleware } from './dashboardAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const port = Number(process.env.PORT) || 3000;

const app = express();
if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '512kb' }));
mountShopifyAuth(app, { port });
mountDashboardAuthRoutes(app);
app.use(dashboardAuthMiddleware);
app.use(express.static(publicDir));

function shopifyConfig() {
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  const envToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const session = readShopifySession();
  const shopDomain = envShop || session?.shopDomain;
  const accessToken = envToken || session?.accessToken;
  if (!shopDomain || !accessToken) {
    const err = Object.assign(new Error('SHOPIFY_SETUP'), { code: 'SHOPIFY_SETUP' });
    throw err;
  }
  return { shopDomain, accessToken };
}

function dpdCreds() {
  const delisId = process.env.DPD_DELIS_ID?.trim();
  const password = process.env.DPD_DELIS_PASSWORD?.trim();
  const useStage = String(process.env.DPD_USE_STAGE).toLowerCase() === 'true';
  if (!delisId || !password) return null;
  return { delisId, password, useStage };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/overview', async (req, res) => {
  try {
    const attempts = shopifyCredentialAttempts();
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
    const includeMailLog = String(req.query.mailLog ?? '1') !== '0';
    const loadProductImages = String(req.query.productImages ?? '1') !== '0';
    /** @type {number | null} */
    let ordersFetchMax = null;
    let ordersMayBeTruncated = false;

    let shopInfo = null;
    try {
      shopInfo = await fetchShop(cfgPrimary);
    } catch {
      shopInfo = null;
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
    for (const att of attempts) {
      const c = { shopDomain: att.shopDomain, accessToken: att.accessToken };
      try {
        if (explicitOrderLimit) {
          const lim = Math.min(250, Math.max(1, Number(req.query.limit) || 40));
          ordersFetchMax = lim;
          orders = await fetchRecentOrders(c, { limit: lim });
          ordersMayBeTruncated = orders.length >= lim;
        } else {
          const envCap = Number(process.env.SHOPIFY_ORDERS_MAX || '');
          const cap =
            Number.isFinite(envCap) && envCap > 0
              ? Math.min(50000, envCap)
              : 10000;
          ordersFetchMax = cap;
          orders = await fetchAllRecentOrders(c, { maxOrders: cap, pageSize: 250 });
          ordersMayBeTruncated = orders.length >= cap;
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

    const orderIds = orders.map((o) => o.id);
    const orderMailLogs =
      orders.length > 0 && includeMailLog && ordersCfg
        ? await fetchMailLogsForOrderIds(ordersCfg, orderIds)
        : {};
    let thumbData = { imageMap: {}, handles: {}, productionByProductId: {} };
    if (orders.length > 0 && ordersCfg) {
      thumbData = await fetchProductThumbnailData(ordersCfg, orders, {
        loadImages: loadProductImages,
        storefrontBaseUrl: storeBaseUrl,
      });
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

    const enriched = [];
    for (const row of rows) {
      const out = { ...row, dpdTrackings: [] };
      if (dpd) {
        for (const t of row.trackings) {
          if (!t.number) continue;
          const tryDpd =
            isLikelyDpdCarrier(t.company) ||
            /^\d{14}$/.test(t.number.replace(/\s/g, ''));
          if (!tryDpd) continue;
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
      const mailLines = orderMailLogs[String(row.shopifyOrderId)] || [];
      out.deskHint = deskHintForRow(out, mailLines);
      enriched.push(out);
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
      openAiConfigured: isOpenAiConfigured(),
      deskHeuristics,
      deskContext,
      orderMailLogs,
      rows: enriched,
    });
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'SHOPIFY_SETUP') {
      const st = getShopifyAuthStatus();
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
        credentialAttempts: shopifyCredentialAttempts().length,
        setupHints: shopifyOverviewSetupHints(),
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Snelle diagnose: toont géén secrets, wel of de API antwoordt. */
app.get('/api/shopify/ping', async (_req, res) => {
  const st = getShopifyAuthStatus();
  if (!st.hasShop) {
    return res.json({
      ok: false,
      step: 'shop',
      message: 'SHOPIFY_SHOP_DOMAIN ontbreekt in .env',
    });
  }
  if (!st.hasToken) {
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
  const cfg = shopifyConfig();
  const ver = process.env.SHOPIFY_API_VERSION?.trim() || '2025-10';
  const url = `https://${cfg.shopDomain.replace(/^https?:\/\//, '')}/admin/api/${ver}/shop.json`;
  try {
    const r = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': cfg.accessToken,
        Accept: 'application/json',
      },
    });
    const text = await r.text();
    if (!r.ok) {
      return res.json({
        ok: false,
        step: 'api',
        httpStatus: r.status,
        apiVersion: ver,
        shop: cfg.shopDomain,
        message: text.slice(0, 300),
      });
    }
    let shopName = null;
    try {
      const j = JSON.parse(text);
      shopName = j?.shop?.name ?? null;
    } catch {
      /* ignore */
    }
    return res.json({
      ok: true,
      apiVersion: ver,
      shop: cfg.shopDomain,
      shopName,
    });
  } catch (e) {
    return res.json({
      ok: false,
      step: 'network',
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

app.get('/api/config', (_req, res) => {
  const st = getShopifyAuthStatus();
  const callbackUrl =
    process.env.SHOPIFY_REDIRECT_URI?.trim() ||
    `http://localhost:${port}/api/auth/callback`;
  res.json({
    shopifyReady: st.hasShop && st.hasToken,
    shop: st.shopDomain,
    hasShop: st.hasShop,
    hasToken: st.hasToken,
    hasOAuthCreds: st.hasOAuthCreds,
    oauthCallbackUrl: callbackUrl,
    credentialAttempts: shopifyCredentialAttempts().length,
    setupHints: shopifyOverviewSetupHints(),
  });
});

/** Volledige order-timeline (Shopify events) + geparste PDF/factuur/mail-preview velden. */
app.get('/api/orders/:orderId/timeline', async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  if (!/^\d+$/.test(orderId)) {
    return res.status(400).json({ error: 'Alleen numeriek Shopify order-id.' });
  }
  try {
    const attempts = shopifyCredentialAttempts();
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
    const attempts = shopifyCredentialAttempts();
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

    const order = await findOrderForReply(ordersCfg, {
      customerEmail: email,
      shopifyOrderName,
    });
    if (!order) {
      return res.status(404).json({
        error:
          'Geen order gevonden voor dit e-mailadres in de recente lijst (max. 100 orders). Controleer het adres of geef het ordernummer (#…) expliciet mee.',
      });
    }

    const dpd = dpdCreds();
    const enriched = await enrichOrderRowForAi(order, ordersCfg.shopDomain, dpd, ordersCfg);
    if (!enriched) {
      return res.status(500).json({ error: 'Kon ordercontext niet opbouwen.' });
    }
    const contextBlock = orderContextPromptBlock(enriched, shopInfo?.name ?? null);
    const draft = await generateCustomerReplyDraft({
      shopName: shopInfo?.name ?? null,
      orderContextBlock: contextBlock,
      incomingSubject,
      incomingBody: incomingText,
    });
    res.json({
      ok: true,
      subject: draft.subject,
      body: draft.body,
      model: draft.model,
      matchedOrderName: enriched.shopifyOrderName,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
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

app.post('/api/mail/send', async (req, res) => {
  try {
    if (!isSmtpConfigured()) {
      return res.status(400).json({
        error:
          'SMTP niet geconfigureerd. Vul SMTP_HOST, SMTP_FROM en indien nodig SMTP_USER/SMTP_PASS in .env.',
      });
    }
    const { to, subject, text, html, replyTo } = req.body || {};
    const toStr = typeof to === 'string' ? to.trim() : '';
    const subStr = typeof subject === 'string' ? subject.trim() : '';
    const textStr = typeof text === 'string' ? text.trim() : '';
    if (!toStr || !subStr || !textStr) {
      return res.status(400).json({ error: 'Velden to, subject en text zijn verplicht.' });
    }
    await sendSmtpMail({
      to: toStr,
      subject: subStr,
      text: textStr,
      html: typeof html === 'string' ? html : undefined,
      replyTo: typeof replyTo === 'string' ? replyTo.trim() : undefined,
    });
    res.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Dashboard: http://localhost:${port}`);
});
