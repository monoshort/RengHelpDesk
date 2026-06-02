/**
 * Platformstatus voor instellingen-UI (commercieel overzicht koppelingen + voorkeuren).
 */
import { isOpenAiConfigured } from './aiReply.js';
import { isDeskKnowledgeEnabled } from './deskKnowledge.js';
import { getDpdCredsFromPlatform } from './platformConfig.js';
import {
  buildPlatformConfigForApi,
  ensurePlatformConfigLoaded,
  getPlatformConfigValue,
} from './platformConfigStore.js';
import { getGmailAuthStatus, gmailConnectionHints, isGmailSharedEnvMailboxMode } from './gmailSession.js';
import { graphConnectionHints, isGraphMailConfigured, getGraphMailbox } from './graphMail.js';
import { isGmailApiConfigured, isSmtpConfigured, isMailOutboundConfigured } from './mail.js';
import { resolveMailRoutingSummary } from './mailRouting.js';
import {
  defaultWorkspaceSettings,
  normalizeWorkspaceSettings,
} from './workspaceSettings.js';
import { getShopifyAuthStatusForRequest } from './requestIntegrations.js';

/**
 * @param {import('express').Request} req
 * @param {WorkspaceSettings} preferences
 */
export async function buildPlatformSettingsPayload(req, preferences) {
  await ensurePlatformConfigLoaded();
  const prefs = normalizeWorkspaceSettings(preferences);
  const st = await getShopifyAuthStatusForRequest(req);
  const g = getGmailAuthStatus(req);
  const graph = graphConnectionHints();
  const gmailHintPack = gmailConnectionHints(req);
  const gmailHintsList = Array.isArray(gmailHintPack.hints) ? gmailHintPack.hints : [];
  const routing = resolveMailRoutingSummary(req);
  const openAi = isOpenAiConfigured();
  const dpdOk = Boolean(getDpdCredsFromPlatform());
  const dbUrl = Boolean(process.env.DATABASE_URL?.trim());
  const onVercel = String(process.env.VERCEL || '').trim() === '1';

  const host = req.get('host') || 'localhost:3000';
  const proto = req.protocol || 'http';
  const baseUrl = `${proto}://${host}`;

  const shopifyEnvToken = Boolean(getPlatformConfigValue('SHOPIFY_ACCESS_TOKEN'));
  const shopifyEnvShop = getPlatformConfigValue('SHOPIFY_SHOP_DOMAIN');

  /** @type {Record<string, { id: string; label: string; status: 'connected' | 'partial' | 'disconnected' | 'admin'; detail: string; selfService: boolean; connectUrl?: string; disconnectApi?: string; platformConfigGroup?: string; setupHints?: string[] }>} */
  const integrations = {
    shopify: {
      id: 'shopify',
      label: 'Shopify',
      status: st.hasShop && st.hasToken ? 'connected' : st.hasShop ? 'partial' : 'disconnected',
      detail: st.hasShop
        ? st.hasToken
          ? `Winkel ${st.shopDomain || 'gekoppeld'} — orders en klantcontext beschikbaar.`
          : 'Winkel bekend, maar nog geen geldig Admin-token.'
        : shopifyEnvToken && shopifyEnvShop
          ? `Platform-token actief voor ${shopifyEnvShop} — OAuth-koppeling optioneel.`
          : 'Nog niet gekoppeld — nodig voor orders, DPD en AI met ordercontext.',
      selfService: true,
      connectUrl: '/koppel.html',
      disconnectApi: st.hasToken && !shopifyEnvToken ? '/api/settings/disconnect/shopify' : undefined,
      platformConfigGroup: !st.hasToken ? 'shopify' : undefined,
      setupHints:
        st.hasShop && st.hasToken
          ? []
          : [
              'Open Koppelen en autoriseer de Shopify-app (Admin API).',
              'Of zet SHOPIFY_SHOP_DOMAIN + SHOPIFY_ACCESS_TOKEN onder Platform & API → Shopify.',
            ],
    },
    mailGmail: {
      id: 'mailGmail',
      label: 'Gmail',
      status: g.hasRefreshToken && g.hasOAuthCreds ? 'connected' : g.hasOAuthCreds ? 'partial' : 'disconnected',
      detail: g.hasRefreshToken
        ? `Verbonden${g.senderEmail ? ` (${g.senderEmail})` : ''}${g.gmailUsesSharedEnvToken ? ' — organisatie-token (platform)' : ' — jouw OAuth-koppeling'}.`
        : g.hasOAuthCreds
          ? 'Google OAuth staat klaar; koppel je mailbox of zet een organisatie-refresh-token.'
          : 'Google OAuth-client ontbreekt — vul GOOGLE_CLIENT_ID/SECRET in.',
      selfService: Boolean(g.hasOAuthCreds),
      connectUrl: g.hasOAuthCreds ? '/gmail-koppel.html' : undefined,
      disconnectApi:
        g.hasRefreshToken && g.userGmailLinked && !g.gmailUsesSharedEnvToken
          ? '/api/auth/gmail/disconnect'
          : undefined,
      platformConfigGroup: !g.hasOAuthCreds || (!g.hasRefreshToken && g.hasOAuthCreds) ? 'google' : undefined,
      setupHints: g.hasRefreshToken ? [] : gmailHintsList.slice(0, 4),
    },
    mailGraph: {
      id: 'mailGraph',
      label: 'Microsoft 365 (Graph)',
      status: graph.configured ? 'connected' : 'admin',
      detail: graph.configured
        ? `Postvak ${getGraphMailbox()} — gedeeld postvak via app-registratie.`
        : 'Tenant, client ID, secret en mailbox instellen voor info@…-postvak.',
      selfService: false,
      platformConfigGroup: 'graph',
      setupHints: graph.configured ? [] : (graph.hints || []).slice(0, 4),
    },
    mailSmtp: {
      id: 'mailSmtp',
      label: 'SMTP',
      status: isSmtpConfigured() ? 'connected' : 'disconnected',
      detail: isSmtpConfigured()
        ? `Uitgaande mail via ${getPlatformConfigValue('SMTP_HOST') || 'SMTP-host'}.`
        : 'Optioneel naast Gmail/Graph — host, poort en afzender instellen.',
      selfService: false,
      platformConfigGroup: 'smtp',
      setupHints: isSmtpConfigured()
        ? []
        : ['Vul SMTP_HOST, SMTP_FROM en optioneel SMTP_USER/PASS in onder Platform & API → SMTP.'],
    },
    openAi: {
      id: 'openAi',
      label: 'OpenAI (AI-antwoorden)',
      status: openAi ? 'connected' : 'admin',
      detail: openAi
        ? `Model: ${getPlatformConfigValue('OPENAI_MODEL') || 'gpt-4o-mini'} — concepten, vertalen en inzichten actief.`
        : 'OPENAI_API_KEY vereist voor AI-antwoorden en automatisch vertalen.',
      selfService: false,
      platformConfigGroup: 'openai',
      setupHints: openAi
        ? []
        : [
            'Maak een API-sleutel op platform.openai.com.',
            'Vul OPENAI_API_KEY in onder Platform & API → OpenAI en sla op.',
          ],
    },
    dpd: {
      id: 'dpd',
      label: 'DPD tracking',
      status: dpdOk ? 'connected' : 'disconnected',
      detail: dpdOk
        ? `Delis ID ${getPlatformConfigValue('DPD_DELIS_ID')} — live pakketstatus in orders en mail.`
        : 'DPD Delis ID en wachtwoord voor tracking in orders en antwoorden.',
      selfService: false,
      platformConfigGroup: 'dpd',
      setupHints: dpdOk
        ? []
        : ['Vul DPD_DELIS_ID en DPD_DELIS_PASSWORD in onder Platform & API → DPD.'],
    },
    deskKnowledge: {
      id: 'deskKnowledge',
      label: 'Kennisbank (playbooks)',
      status: isDeskKnowledgeEnabled() ? 'connected' : 'disconnected',
      detail: isDeskKnowledgeEnabled()
        ? 'Werkwijzen uit desk-knowledge/ worden in AI-prompts gebruikt.'
        : 'Uitgeschakeld via DESK_KNOWLEDGE_ENABLED op platformniveau.',
      selfService: false,
      platformConfigGroup: !isDeskKnowledgeEnabled() ? 'platform' : undefined,
      setupHints: isDeskKnowledgeEnabled()
        ? []
        : ['Zet DESK_KNOWLEDGE_ENABLED op true onder Platform & API → Platform.'],
    },
  };

  return {
    ok: true,
    platform: {
      name: getPlatformConfigValue('PLATFORM_NAME') || 'Helpdesk',
      baseUrl,
      onVercel,
      databaseConfigured: dbUrl,
      persistenceWarning:
        onVercel && !dbUrl
          ? 'Zonder DATABASE_URL blijven koppelingen niet betrouwbaar op Vercel. Gebruik Postgres voor commerciële productie.'
          : null,
    },
    preferences: prefs,
    defaults: defaultWorkspaceSettings(),
    routing,
    integrations,
    capabilities: {
      canUseGraphInbox: graph.configured,
      canUseGmailInbox: isGmailApiConfigured(req),
      canSendMail: isMailOutboundConfigured(req),
      canUseAi: openAi && prefs.aiEnabled !== false,
      canAutoTranslate: openAi && prefs.aiEnabled !== false && prefs.aiAutoTranslate !== false,
      canUseDeskKnowledge: isDeskKnowledgeEnabled() && prefs.deskKnowledgeEnabled !== false,
    },
    hints: [...gmailHintsList, ...(graph.hints || [])].slice(0, 8),
    links: {
      mail: '/mail.html',
      orders: '/orders.html',
      settings: '/instellingen.html',
      shopifyConnect: '/koppel.html',
      gmailConnect: '/gmail-koppel.html',
    },
    platformConfig: buildPlatformConfigForApi(
      (await ensurePlatformConfigLoaded())?.values || {}
    ),
  };
}
