/**
 * Bepaalt mail-kanaal: workspace-voorkeur → env → beschikbaarheid.
 */
import { isGraphMailConfigured } from './graphMail.js';
import { readGmailTokens, getGmailOAuthCreds } from './gmailSession.js';
import { getPlatformConfigValue } from './platformConfigStore.js';

function isSmtpConfigured() {
  const host = getPlatformConfigValue('SMTP_HOST');
  const from =
    getPlatformConfigValue('SMTP_FROM') ||
    getPlatformConfigValue('DEFAULT_OUTBOUND_FROM') ||
    'info@toddie.nl';
  return Boolean(host && from);
}

/**
 * @param {import('express').Request | undefined} req
 */
function isGmailApiConfigured(req) {
  const t = readGmailTokens(req);
  const { clientId, clientSecret } = getGmailOAuthCreds();
  return Boolean(t?.refresh_token && clientId && clientSecret);
}

/**
 * @param {import('./workspaceSettings.js').WorkspaceSettings | null | undefined} settings
 */
function inboundPref(settings) {
  const p = String(settings?.mailInbound || 'auto')
    .trim()
    .toLowerCase();
  if (p === 'graph' || p === 'gmail') return p;
  const env = String(getPlatformConfigValue('MAIL_INBOUND_PROVIDER') || 'auto')
    .trim()
    .toLowerCase();
  if (env === 'graph' || env === 'microsoft' || env === 'm365') return 'graph';
  if (env === 'gmail' || env === 'google') return 'gmail';
  return 'auto';
}

/**
 * @param {import('./workspaceSettings.js').WorkspaceSettings | null | undefined} settings
 */
function outboundPref(settings) {
  const p = String(settings?.mailOutbound || 'auto')
    .trim()
    .toLowerCase();
  if (p === 'graph' || p === 'gmail' || p === 'smtp') return p;
  const env = String(getPlatformConfigValue('MAIL_OUTBOUND_PROVIDER') || 'auto')
    .trim()
    .toLowerCase();
  if (env === 'graph' || env === 'microsoft' || env === 'm365') return 'graph';
  if (env === 'gmail' || env === 'google') return 'gmail';
  if (env === 'smtp') return 'smtp';
  return 'auto';
}

/**
 * @param {import('express').Request | undefined} req
 */
export function useGraphForInbound(req) {
  const settings = req?.workspaceSettings;
  const pref = inboundPref(settings);
  if (pref === 'graph') return isGraphMailConfigured();
  if (pref === 'gmail') return false;
  return isGraphMailConfigured();
}

/**
 * @param {import('express').Request | undefined} req
 */
export function useGraphForOutbound(req) {
  const settings = req?.workspaceSettings;
  const pref = outboundPref(settings);
  if (pref === 'graph') return isGraphMailConfigured();
  if (pref === 'gmail' || pref === 'smtp') return false;
  return isGraphMailConfigured();
}

/**
 * @param {import('express').Request | undefined} req
 * @returns {'graph' | 'gmail'}
 */
export function activeMailInboundProvider(req) {
  return useGraphForInbound(req) ? 'graph' : 'gmail';
}

/**
 * @param {import('express').Request | undefined} req
 */
export function resolveMailRoutingSummary(req) {
  const settings = req?.workspaceSettings;
  const graphOk = isGraphMailConfigured();
  const gmailOk = isGmailApiConfigured(req);
  const smtpOk = isSmtpConfigured();
  const inbound = activeMailInboundProvider(req);
  let outbound = 'smtp';
  if (useGraphForOutbound(req)) outbound = 'graph';
  else if (isGmailApiConfigured(req)) outbound = 'gmail';
  else if (smtpOk) outbound = 'smtp';

  return {
    mailInboundPreference: inboundPref(settings),
    mailOutboundPreference: outboundPref(settings),
    activeInbound: inbound,
    activeOutbound: outbound,
    graphAvailable: graphOk,
    gmailAvailable: gmailOk,
    smtpAvailable: smtpOk,
  };
}
