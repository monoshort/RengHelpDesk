/**
 * Per dashboard-sessie voorkeuren (mail/AI) — opgeslagen als kind `settings` in user integrations.
 */
import {
  loadUserIntegrationDoc,
  saveUserIntegrationDoc,
  sanitizeDashboardSid,
} from './userIntegrationsStore.js';

/** @typedef {'auto' | 'graph' | 'gmail'} MailInboundPref */
/** @typedef {'auto' | 'graph' | 'gmail' | 'smtp'} MailOutboundPref */

/**
 * @typedef {Object} WorkspaceSettings
 * @property {number} version
 * @property {MailInboundPref} mailInbound
 * @property {MailOutboundPref} mailOutbound
 * @property {boolean} aiEnabled
 * @property {boolean} aiAutoTranslate
 * @property {boolean} deskKnowledgeEnabled
 * @property {string} defaultReplyStyle
 */

export const WORKSPACE_SETTINGS_VERSION = 1;

/** @returns {WorkspaceSettings} */
export function defaultWorkspaceSettings() {
  return {
    version: WORKSPACE_SETTINGS_VERSION,
    mailInbound: 'auto',
    mailOutbound: 'auto',
    aiEnabled: true,
    aiAutoTranslate: true,
    deskKnowledgeEnabled: true,
    defaultReplyStyle: 'default',
  };
}

const REPLY_STYLES = new Set([
  'default',
  'kort',
  'formeel',
  'vriendelijk',
  'uitsluitend_feiten',
  'stappen',
  'track_focus',
]);

/**
 * @param {unknown} raw
 * @returns {WorkspaceSettings}
 */
export function normalizeWorkspaceSettings(raw) {
  const base = defaultWorkspaceSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const o = /** @type {Record<string, unknown>} */ (raw);

  const mailInbound = String(o.mailInbound || 'auto')
    .trim()
    .toLowerCase();
  if (mailInbound === 'graph' || mailInbound === 'gmail' || mailInbound === 'auto') {
    base.mailInbound = /** @type {MailInboundPref} */ (mailInbound);
  }

  const mailOutbound = String(o.mailOutbound || 'auto')
    .trim()
    .toLowerCase();
  if (
    mailOutbound === 'graph' ||
    mailOutbound === 'gmail' ||
    mailOutbound === 'smtp' ||
    mailOutbound === 'auto'
  ) {
    base.mailOutbound = /** @type {MailOutboundPref} */ (mailOutbound);
  }

  if (typeof o.aiEnabled === 'boolean') base.aiEnabled = o.aiEnabled;
  if (typeof o.aiAutoTranslate === 'boolean') base.aiAutoTranslate = o.aiAutoTranslate;
  if (typeof o.deskKnowledgeEnabled === 'boolean') {
    base.deskKnowledgeEnabled = o.deskKnowledgeEnabled;
  }

  const rs = String(o.defaultReplyStyle || 'default')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (REPLY_STYLES.has(rs)) base.defaultReplyStyle = rs;

  return base;
}

/**
 * @param {Partial<WorkspaceSettings>} patch
 * @param {WorkspaceSettings} current
 * @returns {WorkspaceSettings}
 */
export function mergeWorkspaceSettings(patch, current) {
  return normalizeWorkspaceSettings({ ...current, ...patch, version: WORKSPACE_SETTINGS_VERSION });
}

/**
 * @param {string | null | undefined} sid
 * @returns {Promise<WorkspaceSettings>}
 */
export async function loadWorkspaceSettings(sid) {
  const key = sanitizeDashboardSid(sid);
  if (!key) return defaultWorkspaceSettings();
  const doc = await loadUserIntegrationDoc(key, 'settings');
  return normalizeWorkspaceSettings(doc);
}

/**
 * @param {string | null | undefined} sid
 * @param {WorkspaceSettings} settings
 */
export async function saveWorkspaceSettings(sid, settings) {
  const key = sanitizeDashboardSid(sid);
  if (!key) throw new Error('Niet ingelogd — instellingen niet opgeslagen.');
  const normalized = normalizeWorkspaceSettings(settings);
  await saveUserIntegrationDoc(key, 'settings', /** @type {Record<string, unknown>} */ ({
    ...normalized,
  }));
  return normalized;
}

/**
 * @param {WorkspaceSettings | null | undefined} settings
 */
export function isAiEnabledForSettings(settings) {
  if (settings && settings.aiEnabled === false) return false;
  return true;
}

/**
 * @param {WorkspaceSettings | null | undefined} settings
 */
export function isAiAutoTranslateForSettings(settings) {
  if (!isAiEnabledForSettings(settings)) return false;
  if (settings && settings.aiAutoTranslate === false) return false;
  return true;
}

/**
 * @param {WorkspaceSettings | null | undefined} settings
 */
export function isDeskKnowledgeEnabledForSettings(settings) {
  if (settings && settings.deskKnowledgeEnabled === false) return false;
  return true;
}
