import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDashboardSessionId } from './dashboardAuth.js';
import { loadUserIntegrationDoc, saveUserIntegrationDoc, sanitizeDashboardSid } from './userIntegrationsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GMAIL_TOKEN_FILE =
  process.env.GOOGLE_GMAIL_TOKEN_FILE?.trim() ||
  (process.env.VERCEL
    ? path.join('/tmp', 'reng_gmail_token.json')
    : path.join(__dirname, '..', '.google_gmail_token.json'));

function atomicWriteFileSync(filePath, utf8) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, utf8, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.renameSync(tmp, filePath);
  }
}

/** `GOOGLE_GMAIL_FORCE_ENV`, `SMTP_SEND_FIRST`, … */
export function envFlagTrue(name) {
  const v = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** `expiry_date` / env `GOOGLE_GMAIL_TOKEN_EXPIRY` als ms sinds epoch (ook als string in JSON). */
function readEpochMsGmail(raw) {
  if (raw == null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/**
 * Als `GOOGLE_GMAIL_REFRESH_TOKEN` in .env staat, kan de vernieuwde access niet naar schijf.
 * Dan bewaren we die in het proces zodat volgende requests niet opnieuw een verlopen env-access_token pakken.
 */
let gmailRuntimeRefreshKey = '';
let gmailRuntimeAccessToken = '';
let gmailRuntimeExpiryMs = 0;

/**
 * @param {string} refreshKey
 * @param {string} accessToken
 * @param {number} expiryMs `expiry_date` van google-auth (ms sinds epoch), 0 = onbekend
 */
export function setGmailRuntimeAccessCache(refreshKey, accessToken, expiryMs) {
  gmailRuntimeRefreshKey = String(refreshKey || '');
  gmailRuntimeAccessToken = String(accessToken || '');
  gmailRuntimeExpiryMs =
    typeof expiryMs === 'number' && Number.isFinite(expiryMs) ? expiryMs : 0;
}

/** Na 401: volgende `getGmailClient` haalt opnieuw access op (geen verlopen cache). */
export function clearGmailRuntimeAccessCache() {
  gmailRuntimeRefreshKey = '';
  gmailRuntimeAccessToken = '';
  gmailRuntimeExpiryMs = 0;
}

/**
 * @param {import('express').Request | undefined} [req]
 * @returns {{ refresh_token?: string; access_token?: string; expiry_date?: number; sender_email?: string; oauth_redirect_uri?: string } | null}
 */
export function readGmailTokens(req) {
  const envRt = process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim();
  const forceEnv = envFlagTrue('GOOGLE_GMAIL_FORCE_ENV');

  /**
   * 1) GOOGLE_GMAIL_FORCE_ENV + env-refresh → handmatige recovery (goede token in Vercel, rotte rij in DB).
   * 2) GOOGLE_GMAIL_REFRESH_TOKEN in env + niet GOOGLE_GMAIL_PREFER_USER_LINK → gedeeld organisatie-account (geen browser-koppel nodig).
   * 3) Anders: per-gebruiker OAuth (Postgres), daarna env, dan lokaal bestand.
   */
  const envBlock = () => {
    if (!envRt) return null;
    const marginMs = 300_000;
    if (
      gmailRuntimeRefreshKey === envRt &&
      gmailRuntimeAccessToken &&
      gmailRuntimeExpiryMs > Date.now() + marginMs
    ) {
      return {
        refresh_token: envRt,
        access_token: gmailRuntimeAccessToken,
        expiry_date: gmailRuntimeExpiryMs,
        sender_email: process.env.GOOGLE_GMAIL_FROM?.trim() || undefined,
        oauth_redirect_uri: process.env.GOOGLE_REDIRECT_URI?.trim() || undefined,
      };
    }
    return {
      refresh_token: envRt,
      access_token: process.env.GOOGLE_GMAIL_ACCESS_TOKEN?.trim() || undefined,
      expiry_date: readEpochMsGmail(process.env.GOOGLE_GMAIL_TOKEN_EXPIRY),
      sender_email: process.env.GOOGLE_GMAIL_FROM?.trim() || undefined,
      oauth_redirect_uri: process.env.GOOGLE_REDIRECT_URI?.trim() || undefined,
    };
  };

  if (forceEnv && envRt) {
    return envBlock();
  }

  const preferUserLink = envFlagTrue('GOOGLE_GMAIL_PREFER_USER_LINK');
  if (envRt && !preferUserLink) {
    return envBlock();
  }

  const u = req?.userIntegrationGmail;
  if (u && typeof u === 'object' && u.refresh_token) {
    return {
      refresh_token: String(u.refresh_token),
      access_token: u.access_token ? String(u.access_token) : undefined,
      expiry_date: readEpochMsGmail(u.expiry_date),
      sender_email: u.sender_email ? String(u.sender_email) : undefined,
      oauth_redirect_uri: u.oauth_redirect_uri ? String(u.oauth_redirect_uri) : undefined,
    };
  }

  if (envRt) {
    return envBlock();
  }
  for (let i = 0; i < 4; i++) {
    try {
      if (!fs.existsSync(GMAIL_TOKEN_FILE)) return null;
      const j = JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8'));
      if (!j?.refresh_token) return null;
      return {
        refresh_token: String(j.refresh_token),
        access_token: j.access_token ? String(j.access_token) : undefined,
        expiry_date: readEpochMsGmail(j.expiry_date),
        sender_email: j.sender_email ? String(j.sender_email) : undefined,
        oauth_redirect_uri: j.oauth_redirect_uri ? String(j.oauth_redirect_uri) : undefined,
      };
    } catch {
      if (i === 3) return null;
    }
    const until = Date.now() + 30 + i * 45;
    while (Date.now() < until) {}
  }
  return null;
}

/**
 * Alleen het tokenbestand (niet .env); voor merge/handmatige updates.
 * @returns {{ refresh_token?: string; access_token?: string; expiry_date?: number; sender_email?: string; oauth_redirect_uri?: string } | null}
 */
export function readGmailTokensFileOnly() {
  for (let i = 0; i < 4; i++) {
    try {
      if (!fs.existsSync(GMAIL_TOKEN_FILE)) return null;
      const j = JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8'));
      if (!j || typeof j !== 'object') return null;
      return {
        refresh_token: j.refresh_token ? String(j.refresh_token) : undefined,
        access_token: j.access_token ? String(j.access_token) : undefined,
        expiry_date: readEpochMsGmail(j.expiry_date),
        sender_email: j.sender_email ? String(j.sender_email) : undefined,
        oauth_redirect_uri: j.oauth_redirect_uri ? String(j.oauth_redirect_uri) : undefined,
      };
    } catch {
      if (i === 3) return null;
    }
    const until = Date.now() + 30 + i * 45;
    while (Date.now() < until) {}
  }
  return null;
}

/**
 * @param {{ refresh_token: string; access_token?: string; expiry_date?: number; sender_email?: string; oauth_redirect_uri?: string }} tokens
 * @param {import('express').Request | undefined} [req] bij ingelogde sessie: schrijf naar per-gebruiker opslag
 */
export async function writeGmailTokens(tokens, req) {
  if (process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim()) {
    throw Object.assign(
      new Error(
        'Tokens worden uit env gelezen (GOOGLE_GMAIL_REFRESH_TOKEN). Schrijven naar schijf uitgeschakeld.'
      ),
      { code: 'GMAIL_TOKEN_ENV' }
    );
  }
  const sid = req ? sanitizeDashboardSid(getDashboardSessionId(req)) : null;
  if (sid) {
    await saveUserIntegrationDoc(sid, 'gmail', /** @type {Record<string, unknown>} */ (tokens));
    return;
  }
  atomicWriteFileSync(GMAIL_TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Voegt of overschrijft velden in `.google_gmail_token.json`; bestaande sleutels die je weglaat blijven behouden.
 * Vereist uiteindelijk een `refresh_token` (uit bestand of in `partial`).
 * @param {Partial<{ refresh_token: string; access_token: string; expiry_date: number; sender_email: string; oauth_redirect_uri: string }>} partial
 * @param {import('express').Request | undefined} [req]
 */
export async function mergeGmailTokens(partial, req) {
  if (process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim()) {
    throw Object.assign(
      new Error(
        'Tokens komen uit .env (GOOGLE_GMAIL_REFRESH_TOKEN). Werk .env bij of verwijder die variabele om het bestand te gebruiken.'
      ),
      { code: 'GMAIL_TOKEN_ENV' }
    );
  }
  const sid = req ? sanitizeDashboardSid(getDashboardSessionId(req)) : null;
  /** @type {Record<string, unknown>} */
  let prev = readGmailTokensFileOnly() || {};
  if (sid) {
    const doc = await loadUserIntegrationDoc(sid, 'gmail');
    if (doc) prev = doc;
  }
  const merged = {
    ...prev,
    ...(partial.refresh_token != null ? { refresh_token: String(partial.refresh_token) } : {}),
    ...(partial.access_token != null ? { access_token: String(partial.access_token) } : {}),
    ...(partial.expiry_date != null ? { expiry_date: Number(partial.expiry_date) } : {}),
    ...(partial.sender_email != null ? { sender_email: String(partial.sender_email) } : {}),
    ...(partial.oauth_redirect_uri != null
      ? { oauth_redirect_uri: String(partial.oauth_redirect_uri) }
      : {}),
  };
  if (!merged.refresh_token) {
    throw new Error('mergeGmailTokens: refresh_token ontbreekt (bestand of argument).');
  }
  await writeGmailTokens(merged, req);
}

export function getGmailOAuthCreds() {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return { clientId: id || '', clientSecret: secret || '' };
}

/**
 * @param {import('express').Request | undefined} [req]
 */
export function getGmailAuthStatus(req) {
  const { clientId, clientSecret } = getGmailOAuthCreds();
  const t = readGmailTokens(req);
  const envRt = Boolean(process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim());
  const userRow = Boolean(req?.userIntegrationGmail && req.userIntegrationGmail.refresh_token);
  return {
    hasOAuthCreds: Boolean(clientId && clientSecret),
    hasRefreshToken: Boolean(t?.refresh_token),
    senderEmail: t?.sender_email || process.env.GOOGLE_GMAIL_FROM?.trim() || null,
    /** Per-dashboard-gebruiker gekoppeld (Postgres), los van .env */
    userGmailLinked: userRow,
    /** Refresh-token uit omgeving (Vercel/.env) — geen /gmail-koppel nodig */
    gmailUsesSharedEnvToken: envRt,
  };
}

/**
 * Geen secrets teruggeven — alleen uitleg voor 503 / mail-UI als Gmail nog niet bruikbaar is.
 * @param {import('express').Request | undefined} req
 */
export function gmailConnectionHints(req) {
  const { clientId, clientSecret } = getGmailOAuthCreds();
  const t = readGmailTokens(req);
  const hasOAuthCreds = Boolean(clientId && clientSecret);
  const hasRefresh = Boolean(t?.refresh_token);
  const vercel = Boolean(process.env.VERCEL);
  const hasDb = Boolean(process.env.DATABASE_URL?.trim());
  const hasEnvRt = Boolean(process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim());
  const forceEnv = envFlagTrue('GOOGLE_GMAIL_FORCE_ENV');
  /** @type {string[]} */
  const hints = [];
  if (!hasOAuthCreds) {
    hints.push(
      'Zet GOOGLE_CLIENT_ID en GOOGLE_CLIENT_SECRET in de omgeving (bijv. Vercel → Environment Variables), gelijk aan je Google Cloud OAuth-client.'
    );
  } else if (!hasRefresh) {
    hints.push(
      'Er is nog geen refresh-token: zet GOOGLE_GMAIL_REFRESH_TOKEN + GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in de omgeving (geen browser-koppel), óf na inloggen /gmail-koppel.html (scopes gmail.readonly + gmail.send).'
    );
    if (vercel && !hasDb && !hasEnvRt) {
      hints.push(
        'Op Vercel zonder DATABASE_URL blijft een koppeling in /tmp niet betrouwbaar tussen servers. Oplossing: voeg een Postgres DATABASE_URL toe en koppel Gmail opnieuw op productie, óf zet GOOGLE_GMAIL_REFRESH_TOKEN in Vercel (refresh token uit eenmalige OAuth; lokaal ontstaat die in .google_gmail_token.json).'
      );
    }
    if (vercel && hasDb) {
      hints.push(
        'Koppel Gmail terwijl je ingelogd bent op deze productie-URL, zodat de token in de database wordt opgeslagen.'
      );
    }
    hints.push(
      'Controleer in Google Cloud → OAuth-client dat de redirect exact staat als je productie-URL + /api/auth/gmail/callback (zet desnoods GOOGLE_REDIRECT_URI in Vercel).'
    );
  }
  if (
    hasOAuthCreds &&
    hasRefresh &&
    hasEnvRt &&
    req?.userIntegrationGmail?.refresh_token &&
    !forceEnv &&
    envFlagTrue('GOOGLE_GMAIL_PREFER_USER_LINK')
  ) {
    hints.push(
      'Er staat zowel GOOGLE_GMAIL_REFRESH_TOKEN in de omgeving als een DB-koppeling, en GOOGLE_GMAIL_PREFER_USER_LINK=true: nu wint de koppeling (DB). Zonder PREFER_USER_LINK wint het env-token (organisatie-Gmail).'
    );
  }
  return { hints, hasOAuthCreds, hasRefresh, vercel, hasDatabaseUrl: hasDb };
}
