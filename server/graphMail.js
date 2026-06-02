/**
 * Microsoft Graph — app-only (client credentials) voor één gedeeld postvak.
 */
import {
  getGraphClientId,
  getGraphClientSecret,
  getGraphMailboxFromConfig,
  getGraphTenantId,
  isGraphConfiguredFromPlatform,
} from './platformConfig.js';
import { getPlatformConfigValue } from './platformConfigStore.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

/** @type {{ token: string; expiresAt: number } | null} */
let tokenCache = null;

export function getGraphMailbox() {
  return getGraphMailboxFromConfig();
}

export function isGraphMailConfigured() {
  return isGraphConfiguredFromPlatform();
}

function graphInboundPreferred() {
  const p = String(getPlatformConfigValue('MAIL_INBOUND_PROVIDER') || 'auto')
    .trim()
    .toLowerCase();
  if (p === 'graph' || p === 'microsoft' || p === 'm365') return true;
  if (p === 'gmail' || p === 'google') return false;
  return isGraphMailConfigured();
}

export function useGraphForInbound() {
  return graphInboundPreferred() && isGraphMailConfigured();
}

function graphOutboundPreferred() {
  const p = String(getPlatformConfigValue('MAIL_OUTBOUND_PROVIDER') || 'auto')
    .trim()
    .toLowerCase();
  if (p === 'graph' || p === 'microsoft' || p === 'm365') return true;
  if (p === 'gmail' || p === 'google' || p === 'smtp') return false;
  return isGraphMailConfigured();
}

export function useGraphForOutbound() {
  return graphOutboundPreferred() && isGraphMailConfigured();
}

/**
 * @returns {Promise<string>}
 */
export async function acquireGraphAccessToken() {
  const marginMs = 60_000;
  if (tokenCache && tokenCache.expiresAt > Date.now() + marginMs) {
    return tokenCache.token;
  }

  const tenantId = getGraphTenantId();
  const clientId = getGraphClientId();
  const clientSecret = getGraphClientSecret();
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft Graph niet geconfigureerd (tenant/client/secret).');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const timeoutMs = Math.min(
    120_000,
    Math.max(5000, Number(process.env.MICROSOFT_GRAPH_TOKEN_REQUEST_MS || '') || 28_000)
  );
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ac.signal,
      }
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = typeof data.error_description === 'string' ? data.error_description : '';
    const code = typeof data.error === 'string' ? data.error : res.status;
    throw new Error(`Graph token mislukt (${code}): ${err || res.statusText}`.trim());
  }
  const token = typeof data.access_token === 'string' ? data.access_token : '';
  const expiresIn = Number(data.expires_in) || 3600;
  if (!token) throw new Error('Graph token: lege access_token in antwoord.');
  tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

/**
 * @param {string} path — relatief t.o.v. /v1.0/ (bijv. users/x/messages)
 * @param {{ method?: string; body?: unknown; headers?: Record<string, string> }} [opts]
 */
export async function graphRequest(path, opts = {}) {
  const token = await acquireGraphAccessToken();
  const url = path.startsWith('http') ? path : `${GRAPH_ROOT}/${path.replace(/^\//, '')}`;
  const method = opts.method || 'GET';
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  /** @type {unknown} */
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const errObj =
      data && typeof data === 'object' && data !== null && 'error' in data
        ? /** @type {{ error?: { message?: string; code?: string } }} */ (data).error
        : undefined;
    const msg = errObj?.message || (typeof data === 'string' ? data : res.statusText);
    const e = new Error(`Graph ${method} ${path}: ${res.status} ${msg}`.trim());
    /** @type {Error & { status?: number; graphCode?: string }} */ (e).status = res.status;
    if (errObj?.code) /** @type {Error & { graphCode?: string }} */ (e).graphCode = errObj.code;
    throw e;
  }
  return { status: res.status, data };
}

/** @param {string} userPathSegment — mailbox UPN of id */
export function graphUserPath(userPathSegment) {
  const mailbox = userPathSegment || getGraphMailbox();
  return `users/${encodeURIComponent(mailbox)}`;
}

/**
 * @param {{ to: string; subject: string; text: string; html?: string; replyTo?: string; from?: string }} opts
 */
export async function sendGraphMail(opts) {
  const mailbox = getGraphMailbox();
  const from =
    typeof opts.from === 'string' && opts.from.trim()
      ? opts.from.trim()
      : mailbox;

  const contentType = opts.html ? 'HTML' : 'Text';
  const content = opts.html || opts.text;

  /** @type {Record<string, unknown>} */
  const message = {
    subject: opts.subject,
    body: { contentType, content },
    toRecipients: [
      {
        emailAddress: { address: opts.to },
      },
    ],
    from: { emailAddress: { address: from } },
  };
  if (opts.replyTo?.trim()) {
    message.replyTo = [{ emailAddress: { address: opts.replyTo.trim() } }];
  }

  await graphRequest(`${graphUserPath(mailbox)}/sendMail`, {
    method: 'POST',
    body: { message, saveToSentItems: true },
  });
}

export function graphConnectionHints() {
  const hints = [];
  if (!getGraphTenantId()) {
    hints.push('Zet MICROSOFT_GRAPH_TENANT_ID in Instellingen of .env (Entra tenant).');
  }
  if (!getGraphClientId()) {
    hints.push('Zet MICROSOFT_GRAPH_CLIENT_ID in Instellingen of .env (Application/client ID).');
  }
  if (!getGraphClientSecret()) {
    hints.push(
      'Zet MICROSOFT_GRAPH_CLIENT_SECRET in Instellingen of .env (client secret uit de veilige link).'
    );
  }
  if (!getGraphMailbox()) {
    hints.push('Zet MICROSOFT_GRAPH_MAILBOX=info@toddie.nl in .env.');
  }
  if (hints.length === 0) {
    hints.push(
      'Controleer Application permissions Mail.ReadWrite + Mail.Send met admin consent, en RBAC op alleen dit postvak.'
    );
    hints.push('Test: npm run mail:doctor:graph');
  }
  return { configured: isGraphMailConfigured(), hints };
}
