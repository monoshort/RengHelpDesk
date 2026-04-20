import crypto from 'crypto';
import { parseCookies, getDashboardSessionId } from './dashboardAuth.js';
import {
  readGmailTokens,
  writeGmailTokens,
  getGmailOAuthCreds,
  setGmailRuntimeAccessCache,
} from './gmailSession.js';
import {
  loadUserIntegrationDoc,
  saveUserIntegrationDoc,
  deleteUserIntegrationDoc,
  sanitizeDashboardSid,
} from './userIntegrationsStore.js';

const COOKIE = 'reng_gmail_oauth';
const MAX_AGE_SEC = 15 * 60;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

/**
 * Zelfde URI als bij authorize én bij token-uitwisseling. Zonder GOOGLE_REDIRECT_URI: afgeleid van Host
 * (localhost vs 127.0.0.1 moet exact matchen met "Authorized redirect URIs" in Google Cloud).
 * @param {import('express').Request} req
 * @param {number} port
 */
function gmailRedirectUri(req, port) {
  const fixed = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (fixed) return fixed;

  let host = req.get('host') || `localhost:${port}`;
  // [::1] staat zelden in Google Cloud; 127.0.0.1 wel
  if (host.startsWith('[::1]:')) {
    host = `127.0.0.1:${host.slice('[::1]:'.length)}`;
  } else if (host === '[::1]') {
    host = `127.0.0.1:${port}`;
  }

  const hostName = host.includes(':') && !host.startsWith('[') ? host.split(':')[0] : host.replace(/^\[|\]$/g, '').split('%')[0];
  const hostLower = hostName.toLowerCase();
  const isLoopbackLocal =
    hostLower === 'localhost' || hostLower === '127.0.0.1' || hostLower === '0.0.0.0';

  let proto = req.protocol || 'http';
  const xf = req.headers['x-forwarded-proto'];
  if (typeof xf === 'string' && xf.split(',')[0].trim()) {
    proto = xf.split(',')[0].trim().toLowerCase().replace(/:$/, '');
  }
  // Tunnel/proxy (Cursor, ngrok, …) zet vaak X-Forwarded-Proto=https → https://localhost terwijl Google alleen http:// heeft geregistreerd
  if (isLoopbackLocal) proto = 'http';

  if (proto !== 'http' && proto !== 'https') proto = 'http';
  return `${proto}://${host}/api/auth/gmail/callback`;
}

/**
 * @param {import('express').Request} req
 */
function cookieSecure(req) {
  if (process.env.DASHBOARD_COOKIE_SECURE === 'true') {
    if (req.secure) return true;
    const raw = req.headers['x-forwarded-proto'];
    const first = typeof raw === 'string' ? raw.split(',')[0].trim().toLowerCase() : '';
    return first === 'https';
  }
  return (
    Boolean(req.secure) ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase() === 'https'
  );
}

/**
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 * @param {{ state: string; at: number; dashboardSid: string }} payload
 */
function setPending(res, req, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE_SEC}`];
  if (cookieSecure(req)) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(body)}; ${flags.join('; ')}`);
}

/**
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 */
function clearPending(res, req) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure(req)) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=; ${flags.join('; ')}`);
}

/** Standaard zonder `login`: minder geforceerde Google-sessies (minder risico op tijdelijke blokkade bij veel IP's). */
function gmailOauthPromptParam() {
  const custom = process.env.GOOGLE_GMAIL_OAUTH_PROMPT?.trim();
  if (custom) return custom;
  return 'select_account consent';
}

/**
 * @param {import('express').Express} app
 * @param {{ port: number }} opts
 */
export function mountGmailAuth(app, opts) {
  /** Publiek: exacte callback-URL voor Google Cloud → Authorized redirect URIs (zelfde tab/host als Gmail-koppelen). */
  app.get('/api/auth/gmail/redirect-uri', (req, res) => {
    const { clientId } = getGmailOAuthCreds();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      redirectUri: gmailRedirectUri(req, opts.port),
      oauthClientId: clientId || null,
      note: 'Plak redirectUri 1:1 in Google Cloud → Credentials → OAuth 2.0 Client ID met exact deze oauthClientId.',
    });
  });

  /** Verwijdert opgeslagen Gmail-token voor deze sessie (DB/bestand). Niet het env-token — dat in Vercel wissen of GOOGLE_GMAIL_FORCE_ENV. */
  app.post('/api/auth/gmail/disconnect', async (req, res) => {
    const dashboardSid = sanitizeDashboardSid(getDashboardSessionId(req));
    if (!dashboardSid) {
      return res.status(401).json({ ok: false, error: 'Niet ingelogd.' });
    }
    try {
      await deleteUserIntegrationDoc(dashboardSid, 'gmail');
      res.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, error: msg.slice(0, 200) });
    }
  });

  app.get('/api/auth/gmail/install', (req, res) => {
    const dashboardSid = sanitizeDashboardSid(getDashboardSessionId(req));
    if (!dashboardSid) {
      return res.status(401).send(
        'Log eerst in op het dashboard (login.html), daarna opnieuw Gmail koppelen via /gmail-koppel.html.'
      );
    }
    const { clientId, clientSecret } = getGmailOAuthCreds();
    if (!clientId || !clientSecret) {
      return res.status(400).send(
        'Zet GOOGLE_CLIENT_ID en GOOGLE_CLIENT_SECRET in .env (Google Cloud Console → APIs & Services → Credentials).'
      );
    }
    const redirectUri = gmailRedirectUri(req, opts.port);
    const state = crypto.randomBytes(24).toString('hex');
    setPending(res, req, { state, at: Date.now(), dashboardSid });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', gmailOauthPromptParam());
    url.searchParams.set('state', state);
    res.redirect(302, url.toString());
  });

  app.get('/api/auth/gmail/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const errQ = typeof req.query.error === 'string' ? req.query.error : '';

    let pending = null;
    try {
      const raw = parseCookies(req.headers.cookie || '')[COOKIE];
      if (raw) {
        pending = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8'));
      }
    } catch {
      pending = null;
    }

    const dashSid = sanitizeDashboardSid(getDashboardSessionId(req));
    const pendingSid = sanitizeDashboardSid(
      pending && typeof pending.dashboardSid === 'string' ? pending.dashboardSid : ''
    );
    const pendingOk =
      pending &&
      typeof pending.state === 'string' &&
      pending.state === state &&
      typeof pending.at === 'number' &&
      Date.now() - pending.at < MAX_AGE_SEC * 1000 &&
      Boolean(dashSid && pendingSid && dashSid === pendingSid);

    if (errQ) {
      clearPending(res, req);
      return res.status(400).send(`Google OAuth afgebroken: ${errQ}`);
    }

    if (!code || !state || !pendingOk) {
      clearPending(res, req);
      return res.status(400).send(
        'Ongeldige OAuth-response. Probeer opnieuw via /gmail-koppel.html. Controleer GOOGLE_REDIRECT_URI in .env en Authorized redirect URIs in Google Cloud.'
      );
    }

    clearPending(res, req);

    const { clientId, clientSecret } = getGmailOAuthCreds();
    if (!clientId || !clientSecret) {
      return res.status(500).send('GOOGLE_CLIENT_ID/SECRET ontbreken.');
    }

    const redirectUri = gmailRedirectUri(req, opts.port);

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      const data = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) {
        const msg = data.error_description || data.error || 'token error';
        return res.status(400).send(`Token-uitwisseling mislukt: ${msg}`);
      }

      const prevDoc = await loadUserIntegrationDoc(pendingSid, 'gmail');
      const prev = prevDoc || readGmailTokens(undefined);
      const refresh_token = data.refresh_token || prev?.refresh_token;
      if (!refresh_token) {
        return res
          .status(400)
          .send(
            'Geen refresh_token. Tip: in Google Account → Beveiliging derde partijen de app verwijderen en opnieuw koppelen, of controleer dat prompt=consent wordt gebruikt.'
          );
      }

      let senderEmail = process.env.GOOGLE_GMAIL_FROM?.trim() || prev?.sender_email || '';
      const at = data.access_token || prev?.access_token;
      if (!senderEmail && at) {
        const ui = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${at}` },
        });
        const u = await ui.json().catch(() => ({}));
        if (u.email) senderEmail = String(u.email);
      }

      const merged = {
        refresh_token,
        access_token: data.access_token || prev?.access_token,
        expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : prev?.expiry_date,
        sender_email: senderEmail || prev?.sender_email || undefined,
        oauth_redirect_uri: redirectUri,
      };
      /**
       * readGmailTokens: zonder GOOGLE_GMAIL_FORCE_ENV wint opgeslagen OAuth (DB) boven env,
       * zodat opnieuw koppelen direct de nieuwe refresh_token gebruikt. Met FORCE_ENV wint env (recovery).
       */
      try {
        await saveUserIntegrationDoc(pendingSid, 'gmail', merged);
      } catch (saveErr) {
        const lockedByEnv = Boolean(process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim());
        if (!lockedByEnv) {
          await writeGmailTokens(merged, req);
        } else {
          console.error(
            '[gmailAuth] Kon Gmail-tokens niet opslaan (sessie/DB); env-lock actief:',
            saveErr instanceof Error ? saveErr.message : saveErr
          );
          return res
            .status(500)
            .send(
              'Token ontvangen van Google maar opslaan mislukt. Zet DATABASE_URL op Vercel voor vaste opslag, of verwijder tijdelijk GOOGLE_GMAIL_REFRESH_TOKEN uit de omgeving en koppel opnieuw.'
            );
        }
      }

      if (process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim()) {
        const expMs = data.expires_in
          ? Date.now() + Number(data.expires_in) * 1000
          : typeof merged.expiry_date === 'number'
            ? merged.expiry_date
            : 0;
        setGmailRuntimeAccessCache(
          String(refresh_token),
          String(merged.access_token || ''),
          typeof expMs === 'number' && expMs > 0 ? expMs : 0
        );
      }

      const envRtAfter = process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim();
      const staleEnv =
        Boolean(envRtAfter) &&
        String(refresh_token).trim() !== envRtAfter;
      const q = staleEnv ? '?gmail=1&gmail_env_refresh_stale=1' : '?gmail=1';
      res.redirect(302, `/${q}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).send(`Gmail-koppeling mislukt: ${msg.slice(0, 400)}`);
    }
  });
}
