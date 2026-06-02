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
  const gmailHints = gmailConnectionHints(req);
  const routing = resolveMailRoutingSummary(req);
  const openAi = isOpenAiConfigured();
  const dpdOk = Boolean(getDpdCredsFromPlatform());
  const dbUrl = Boolean(process.env.DATABASE_URL?.trim());
  const onVercel = String(process.env.VERCEL || '').trim() === '1';

  const host = req.get('host') || 'localhost:3000';
  const proto = req.protocol || 'http';
  const baseUrl = `${proto}://${host}`;

  /** @type {Record<string, { id: string; label: string; status: 'connected' | 'partial' | 'disconnected' | 'admin'; detail: string; selfService: boolean; connectUrl?: string; disconnectApi?: string }>} */
  const integrations = {
    shopify: {
      id: 'shopify',
      label: 'Shopify',
      status: st.hasShop && st.hasToken ? 'connected' : st.hasShop ? 'partial' : 'disconnected',
      detail: st.hasShop
        ? st.hasToken
          ? `Winkel ${st.shopDomain || 'gekoppeld'} — orders en klantcontext beschikbaar.`
          : 'Winkel bekend, maar nog geen geldig Admin-token.'
        : 'Nog niet gekoppeld — nodig voor orders, DPD en AI met ordercontext.',
      selfService: true,
      connectUrl: '/koppel.html',
      disconnectApi: '/api/settings/disconnect/shopify',
    },
    mailGmail: {
      id: 'mailGmail',
      label: 'Gmail',
      status: g.hasRefreshToken && g.hasOAuthCreds ? 'connected' : g.hasOAuthCreds ? 'partial' : 'disconnected',
      detail: g.hasRefreshToken
        ? `Verbonden${g.senderEmail ? ` (${g.senderEmail})` : ''}${g.gmailUsesSharedEnvToken ? ' — organisatie-token uit omgeving' : ' — jouw OAuth-koppeling'}.`
        : g.hasOAuthCreds
          ? 'Google OAuth staat klaar; koppel je mailbox om inbox en verzenden te gebruiken.'
          : 'Google OAuth-client ontbreekt op de server (GOOGLE_CLIENT_ID/SECRET).',
      selfService: Boolean(g.hasOAuthCreds),
      connectUrl: '/gmail-koppel.html',
      disconnectApi: '/api/auth/gmail/disconnect',
    },
    mailGraph: {
      id: 'mailGraph',
      label: 'Microsoft 365 (Graph)',
      status: graph.configured ? 'connected' : 'admin',
      detail: graph.configured
        ? `Postvak ${getGraphMailbox()} — ingesteld door platformbeheerder (app-registratie).`
        : 'Nog niet geactiveerd — vul Graph-gegevens in onder Platformconfiguratie.',
      selfService: false,
    },
    mailSmtp: {
      id: 'mailSmtp',
      label: 'SMTP',
      status: isSmtpConfigured() ? 'connected' : 'disconnected',
      detail: isSmtpConfigured()
        ? 'Uitgaande mail via SMTP-host (optioneel naast Gmail/Graph).'
        : 'SMTP_HOST / SMTP_FROM niet geconfigureerd.',
      selfService: false,
    },
    openAi: {
      id: 'openAi',
      label: 'OpenAI (AI-antwoorden)',
      status: openAi ? 'connected' : 'admin',
      detail: openAi
        ? 'AI-concepten, vertaling en team-inzichten zijn beschikbaar.'
        : 'OPENAI_API_KEY ontbreekt — vul in onder Platformconfiguratie of .env.',
      selfService: false,
    },
    dpd: {
      id: 'dpd',
      label: 'DPD tracking',
      status: dpdOk ? 'connected' : 'disconnected',
      detail: dpdOk
        ? 'Live pakketstatus in orders en mail-antwoorden.'
        : 'DPD_DELIS_ID / wachtwoord niet gezet — tracking uitgeschakeld.',
      selfService: false,
    },
    deskKnowledge: {
      id: 'deskKnowledge',
      label: 'Kennisbank (playbooks)',
      status: isDeskKnowledgeEnabled() ? 'connected' : 'disconnected',
      detail: isDeskKnowledgeEnabled()
        ? 'Standaard werkwijzen uit desk-knowledge/ in AI-prompts.'
        : 'Kennisbank uitgeschakeld (DESK_KNOWLEDGE_ENABLED).',
      selfService: false,
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
    hints: [...gmailHints, ...graph.hints].slice(0, 8),
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
