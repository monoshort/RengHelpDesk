import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import {
  readGmailTokens,
  writeGmailTokens,
  getGmailOAuthCreds,
  setGmailRuntimeAccessCache,
  clearGmailRuntimeAccessCache,
} from './gmailSession.js';

/** Seriële ketting: geen parallelle refresh naar Google (race op tokenbestand / dubbele refresh). */
let gmailClientTail = Promise.resolve();

/**
 * Schrijft vernieuwde access_token / expiry naar .google_gmail_token.json (niet bij tokens uit louter .env).
 * Zet altijd de runtime-cache (nodig als `GOOGLE_GMAIL_REFRESH_TOKEN` alleen in .env staat).
 * @param {import('google-auth-library').OAuth2Client} oauth2
 * @param {{ refresh_token: string; access_token?: string; expiry_date?: number; sender_email?: string; oauth_redirect_uri?: string }} base
 */
/**
 * @param {import('google-auth-library').OAuth2Client} oauth2
 * @param {{ refresh_token: string; access_token?: string; expiry_date?: number; sender_email?: string; oauth_redirect_uri?: string }} base
 * @param {import('express').Request | undefined} req
 */
async function persistRefreshedGmailTokens(oauth2, base, req) {
  const c = oauth2.credentials;
  const rt = c.refresh_token || base.refresh_token;
  if (!rt) return;
  const exp =
    typeof c.expiry_date === 'number' && Number.isFinite(c.expiry_date)
      ? c.expiry_date
      : base.expiry_date;
  const merged = {
    refresh_token: String(rt),
    access_token: c.access_token != null ? String(c.access_token) : base.access_token,
    expiry_date: exp,
    sender_email: base.sender_email,
    oauth_redirect_uri: base.oauth_redirect_uri,
  };
  if (merged.access_token) {
    setGmailRuntimeAccessCache(rt, merged.access_token, merged.expiry_date ?? 0);
  }
  const unchanged =
    merged.access_token === base.access_token && merged.expiry_date === base.expiry_date;
  if (unchanged) return;
  try {
    await writeGmailTokens(merged, req);
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? e.code : '';
    if (code === 'GMAIL_TOKEN_ENV') return;
    throw e;
  }
}

export function isSmtpConfigured() {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  return Boolean(host && from);
}

/**
 * @param {import('express').Request | undefined} [req]
 */
export function isGmailApiConfigured(req) {
  const t = readGmailTokens(req);
  const { clientId, clientSecret } = getGmailOAuthCreds();
  return Boolean(t?.refresh_token && clientId && clientSecret);
}

/** SMTP of Gmail API — minstens één nodig om mail te versturen. */
/**
 * @param {import('express').Request | undefined} [req]
 */
export function isMailOutboundConfigured(req) {
  return isSmtpConfigured() || isGmailApiConfigured(req);
}

/**
 * Zet SMTP_SEND_FIRST=true in .env om uitgaande mail via SMTP te sturen zodra SMTP_HOST + SMTP_FROM
 * staan — ook als Gmail OAuth gekoppeld is (inbox blijft Gmail API). Nodig o.a. voor info@domein via je host.
 */
export function isSmtpSendFirst() {
  const v = String(process.env.SMTP_SEND_FIRST || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Welk kanaal POST /api/mail/send gebruikt (na dezelfde regels als sendOutboundMail). */
/**
 * @param {import('express').Request | undefined} [req]
 */
export function getMailSendChannelLabel(req) {
  if (isSmtpSendFirst() && isSmtpConfigured()) return 'smtp';
  if (isGmailApiConfigured(req)) return 'gmail';
  if (isSmtpConfigured()) return 'smtp';
  return 'smtp';
}

/** @param {string} s */
function normalizeEmail(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

/**
 * Komma-/puntkomma-gescheiden adressen die als From mogen (naast het standaardadres).
 * @returns {string[]}
 */
export function parseMailFromAllowlist() {
  const raw = process.env.MAIL_FROM_ALLOWLIST?.trim() || '';
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;]+/)
        .map((x) => normalizeEmail(x))
        .filter(Boolean)
    ),
  ];
}

/**
 * Standaard From voor UI en verzenden (SMTP eerst → SMTP_FROM; anders Gmail of SMTP).
 * @param {{ sender_email?: string } | null | undefined} tokens
 */
/**
 * @param {{ sender_email?: string } | null | undefined} tokens
 * @param {import('express').Request | undefined} [req]
 */
export function getDefaultOutboundFrom(tokens, req) {
  if (isSmtpSendFirst() && isSmtpConfigured()) {
    return process.env.SMTP_FROM?.trim() || '';
  }
  if (isGmailApiConfigured(req)) {
    const t = tokens ?? readGmailTokens(req);
    return (
      process.env.GOOGLE_GMAIL_FROM?.trim() ||
      t?.sender_email?.trim() ||
      ''
    );
  }
  return process.env.SMTP_FROM?.trim() || '';
}

/**
 * @param {string | undefined | null} requestedRaw
 * @param {string} defaultFrom
 * @returns {string}
 */
export function resolveOutboundFrom(requestedRaw, defaultFrom) {
  const def = defaultFrom.trim();
  if (!def) {
    throw new Error('Geen standaard afzender (GOOGLE_GMAIL_FROM of SMTP_FROM).');
  }
  const req = typeof requestedRaw === 'string' ? requestedRaw.trim() : '';
  if (!req || normalizeEmail(req) === normalizeEmail(def)) {
    return def;
  }
  const want = normalizeEmail(req);
  const allowed = parseMailFromAllowlist();
  if (!allowed.length) {
    throw new Error(
      'Een andere afzender dan het standaardadres vereist MAIL_FROM_ALLOWLIST in .env (komma-gescheiden).'
    );
  }
  if (!allowed.includes(want)) {
    throw new Error(
      `Afzender "${req}" staat niet in MAIL_FROM_ALLOWLIST. Controleer spelling en .env.`
    );
  }
  return req;
}

/**
 * Voor GET /api/mail/from-options en UI.
 */
/**
 * @param {import('express').Request | undefined} [req]
 */
export function getMailSendFromOptions(req) {
  const tokens = readGmailTokens(req);
  const def = getDefaultOutboundFrom(tokens, req);
  const extra = parseMailFromAllowlist();
  const seen = new Set();
  /** @type {string[]} */
  const options = [];
  if (def) {
    options.push(def.trim());
    seen.add(normalizeEmail(def));
  }
  for (const e of extra) {
    if (!seen.has(e)) {
      seen.add(e);
      options.push(e);
    }
  }
  return { defaultFrom: def || null, options };
}

function createTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass: pass || '' } : undefined,
  });
}

/**
 * RFC 2047 encoded-word voor Subject bij niet-ASCII.
 * @param {string} s
 */
function encodeSubject(s) {
  if (/^[\x01-\x7F]*$/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * @param {{ from: string; to: string; subject: string; text: string; html?: string; replyTo?: string }} o
 */
function buildRawRfc822(o) {
  const lines = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${encodeSubject(o.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (o.replyTo) lines.push(`Reply-To: ${o.replyTo}`);

  if (o.html) {
    const b = `b_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${b}"`, '', `--${b}`);
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', o.text, '', `--${b}`);
    lines.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', o.html, '', `--${b}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', o.text);
  }

  return lines.join('\r\n');
}

function toBase64Url(raw) {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * @param {import('express').Request | undefined} [req]
 */
export async function getGmailClient(req) {
  const run = gmailClientTail.then(() => buildGmailClient(req));
  gmailClientTail = run.catch(() => {});
  return run;
}

/**
 * @param {import('express').Request | undefined} [req]
 */
async function buildGmailClient(req) {
  const tokens = readGmailTokens(req);
  const { clientId, clientSecret } = getGmailOAuthCreds();
  if (!tokens?.refresh_token || !clientId || !clientSecret) {
    throw new Error('Gmail API niet geconfigureerd (OAuth of .env tokens)');
  }

  const redirectUri =
    tokens.oauth_redirect_uri?.trim() ||
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `http://localhost:${Number(process.env.PORT) || 3000}/api/auth/gmail/callback`;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const base = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
    sender_email: tokens.sender_email,
    oauth_redirect_uri: tokens.oauth_redirect_uri,
  };
  oauth2.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
  });

  oauth2.on('tokens', () => {
    void persistRefreshedGmailTokens(oauth2, base, req);
  });

  await oauth2.getAccessToken();
  await persistRefreshedGmailTokens(oauth2, base, req);

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const latest = readGmailTokens(req);
  return { gmail, tokens: latest || tokens };
}

function isGmailTransientApiError(e) {
  const status = e?.response?.status ?? e?.code;
  if (status === 401 || status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  return false;
}

/**
 * Voert een Gmail API-actie uit met retries bij 401/429/5xx (verlopen access, rate limits, korte storingen).
 * @param {import('express').Request | undefined} req
 * @param {(ctx: { gmail: import('googleapis').gmail_v1.Gmail; tokens: Record<string, unknown> }) => Promise<any>} fn
 */
export async function withGmailRetry(req, fn) {
  const max = Math.min(6, Math.max(1, Number(process.env.GMAIL_API_MAX_ATTEMPTS || '') || 4));
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      const { gmail, tokens } = await getGmailClient(req);
      return await fn({ gmail, tokens });
    } catch (e) {
      lastErr = e;
      if (!isGmailTransientApiError(e) || i === max - 1) throw e;
      clearGmailRuntimeAccessCache();
      await new Promise((r) =>
        setTimeout(r, Math.min(25_000, 450 * 2 ** i + Math.random() * 500))
      );
    }
  }
  throw lastErr;
}

/**
 * @param {{ req?: import('express').Request; to: string; subject: string; text: string; html?: string; replyTo?: string; from?: string; threadId?: string }} opts
 */
export async function sendGmailApiMail(opts) {
  const req = opts.req;
  await withGmailRetry(req, async ({ gmail, tokens }) => {
    const defaultFrom =
      process.env.GOOGLE_GMAIL_FROM?.trim() || tokens.sender_email?.trim() || '';
    if (!defaultFrom) {
      throw new Error(
        'Afzender ontbreekt. Zet GOOGLE_GMAIL_FROM in .env (jouw Gmail-adres) of koppel opnieuw via /gmail-koppel.html zodat het adres wordt opgeslagen.'
      );
    }

    const from = resolveOutboundFrom(opts.from, defaultFrom);

    const raw = buildRawRfc822({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      replyTo: opts.replyTo,
    });

    const tid = typeof opts.threadId === 'string' ? opts.threadId.trim() : '';
    /** @type {{ raw: string; threadId?: string }} */
    const requestBody = { raw: toBase64Url(raw) };
    if (tid) requestBody.threadId = tid;

    await gmail.users.messages.send({
      userId: 'me',
      requestBody,
    });
  });
}

/**
 * @param {{ to: string; subject: string; text: string; html?: string; replyTo?: string; from?: string }} opts
 */
export async function sendSmtpMail(opts) {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP_HOST en SMTP_FROM ontbreken in .env');
  }
  const defaultFrom = process.env.SMTP_FROM?.trim() || '';
  const from = resolveOutboundFrom(opts.from, defaultFrom);
  const transporter = createTransport();

  const authUser = process.env.SMTP_USER?.trim() || '';
  /** SMTP-sessie (MAIL FROM): vaak het login-adres; zichtbare From-header blijft `from` (bijv. info@toddie.nl). */
  const envelopeFromExplicit = process.env.SMTP_ENVELOPE_FROM?.trim();
  const envelopeFrom =
    envelopeFromExplicit ||
    (authUser && normalizeEmail(authUser) !== normalizeEmail(from) ? authUser : from);

  const mailOpts = {
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo || undefined,
  };

  if (normalizeEmail(envelopeFrom) !== normalizeEmail(from)) {
    mailOpts.envelope = { from: envelopeFrom, to: opts.to };
  }

  await transporter.sendMail(mailOpts);
}

/**
 * Verstuurt via Gmail API als die is gekoppeld, anders SMTP.
 * `threadId` alleen voor Gmail: antwoord blijft in dezelfde conversatie.
 * @param {{ req?: import('express').Request; to: string; subject: string; text: string; html?: string; replyTo?: string; from?: string; threadId?: string }} opts
 */
export async function sendOutboundMail(opts) {
  const req = opts.req;
  if (isSmtpSendFirst() && isSmtpConfigured()) {
    await sendSmtpMail(opts);
    return;
  }
  if (isGmailApiConfigured(req)) {
    await sendGmailApiMail(opts);
    return;
  }
  await sendSmtpMail(opts);
}
