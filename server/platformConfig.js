import { getPlatformConfigValue } from './platformConfigStore.js';

export { hydratePlatformConfig, ensurePlatformConfigLoaded, getPlatformConfigValue } from './platformConfigStore.js';

export function getOpenAiApiKey() {
  return getPlatformConfigValue('OPENAI_API_KEY');
}

export function getOpenAiModel() {
  return getPlatformConfigValue('OPENAI_MODEL') || 'gpt-4o-mini';
}

export function isOpenAiConfiguredFromPlatform() {
  return Boolean(getOpenAiApiKey());
}

export function getGraphTenantId() {
  return getPlatformConfigValue('MICROSOFT_GRAPH_TENANT_ID');
}

export function getGraphClientId() {
  return getPlatformConfigValue('MICROSOFT_GRAPH_CLIENT_ID');
}

export function getGraphClientSecret() {
  return getPlatformConfigValue('MICROSOFT_GRAPH_CLIENT_SECRET');
}

export function getGraphMailboxFromConfig() {
  return (
    getPlatformConfigValue('MICROSOFT_GRAPH_MAILBOX') ||
    getPlatformConfigValue('DEFAULT_OUTBOUND_FROM') ||
    'info@toddie.nl'
  );
}

export function isGraphConfiguredFromPlatform() {
  return Boolean(getGraphTenantId() && getGraphClientId() && getGraphClientSecret() && getGraphMailboxFromConfig());
}

export function getDpdCredsFromPlatform() {
  const delisId = getPlatformConfigValue('DPD_DELIS_ID');
  const password = getPlatformConfigValue('DPD_DELIS_PASSWORD');
  const useStage = String(getPlatformConfigValue('DPD_USE_STAGE')).toLowerCase() === 'true';
  if (!delisId || !password) return null;
  return { delisId, password, useStage };
}
