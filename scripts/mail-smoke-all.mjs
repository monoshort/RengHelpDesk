/**
 * 1) Direct Gmail API (zelfde stack als inbox) via server/mail.js
 * 2) HTTP: login → /api/config → /api/mail/inbox → /api/mail/from-options
 *
 * Start tijdelijk de server op MAIL_SMOKE_PORT (default 37991).
 * Gebruik: node scripts/mail-smoke-all.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const port = Number(process.env.MAIL_SMOKE_PORT || '') || 37_991;
const base = `http://127.0.0.1:${port}`;

function getDashboardPassword() {
  return process.env.DASHBOARD_PASSWORD?.trim() || 'RengTod123!';
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {{ cookie?: string; json?: unknown }} [opts]
 */
function httpRequest(method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const body = opts.json != null ? JSON.stringify(opts.json) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = { _raw: raw.slice(0, 500) };
          }
          const setCookie = res.headers['set-cookie'];
          const cookies = Array.isArray(setCookie)
            ? setCookie.map((l) => l.split(';')[0]).join('; ')
            : setCookie
              ? setCookie.split(';')[0]
              : '';
          resolve({ status: res.statusCode || 0, data, cookies });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitForHealth(maxMs = 25_000) {
  const start = Date.now();
  return (async function poll() {
    try {
      const r = await httpRequest('GET', '/api/health');
      if (r.status === 200 && r.data?.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() - start > maxMs) throw new Error('Server start timeout (api/health)');
    await new Promise((r) => setTimeout(r, 250));
    return poll();
  })();
}

async function main() {
  process.stdout.write('--- Gmail API (mail.js) ---\n');
  const { withGmailRetry, isGmailApiConfigured, isGmailInvalidGrantError } = await import('../server/mail.js');
  if (!isGmailApiConfigured(undefined)) {
    console.error(
      'Stop: Gmail niet geconfigureerd (GOOGLE_CLIENT_ID/SECRET + refresh in .env of .google_gmail_token.json).'
    );
    process.exit(2);
  }
  let directGmailOk = false;
  try {
    await withGmailRetry(undefined, async ({ gmail }) => {
      const r = await gmail.users.labels.list({ userId: 'me' });
      const n = Array.isArray(r.data.labels) ? r.data.labels.length : 0;
      process.stdout.write(`OK — labels.list: ${n} labels\n`);
    });
    directGmailOk = true;
  } catch (e) {
    if (isGmailInvalidGrantError(e)) {
      process.stdout.write(
        'WAARSCHUWING: Gmail API (labels) faalt met invalid_grant — HTTP-routes worden tóch getest.\n'
      );
    } else {
      throw e;
    }
  }

  process.stdout.write(`\n--- HTTP mail-endpoints (${base}) ---\n`);
  const child = spawn(
    process.execPath,
    [path.join(root, 'server', 'index.js')],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        VERCEL: '',
        npm_lifecycle_event: 'start',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stderrBuf = '';
  child.stderr?.on('data', (c) => {
    stderrBuf += c.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });

  let exitCode = 0;
  try {
    await waitForHealth();
    const login = await httpRequest('POST', '/api/dashboard/login', {
      json: { password: getDashboardPassword() },
    });
    if (login.status !== 200 || !login.data?.ok) {
      throw new Error(`Login failed HTTP ${login.status} ${JSON.stringify(login.data)}`);
    }
    const cookie = login.cookies;
    if (!cookie || !cookie.includes('reng_dashboard=')) {
      throw new Error('Geen session-cookie van login');
    }
    process.stdout.write('OK — dashboard login\n');

    const cfg = await httpRequest('GET', '/api/config', { cookie });
    if (cfg.status !== 200) throw new Error(`/api/config ${cfg.status}`);
    process.stdout.write(
      `OK — /api/config gmailReady=${cfg.data?.gmailReady} sharedMode=${cfg.data?.gmailSharedMailboxMode}\n`
    );

    const inbox = await httpRequest('GET', '/api/mail/inbox?maxResults=5', { cookie });
    if (inbox.status === 403 && inbox.data?.gmailInvalidGrant) {
      if (directGmailOk) {
        throw new Error('Inconsistent: direct Gmail werkte maar inbox gaf invalid_grant.');
      }
      process.stdout.write(
        `HTTP OK — /api/mail/inbox antwoordt 403 + gmailInvalidGrant (route werkt; token moet vernieuwd).\n`
      );
      process.stdout.write(
        'Beheer: gmail-koppel.html lokaal of nieuwe GOOGLE_GMAIL_REFRESH_TOKEN → npm run vercel:env:google\n'
      );
      exitCode = 3;
    } else {
      if (inbox.status === 503) {
        throw new Error(`Gmail niet gekoppeld: ${JSON.stringify(inbox.data?.hints || inbox.data)}`);
      }
      if (inbox.status !== 200 || !inbox.data?.ok) {
        throw new Error(`/api/mail/inbox ${inbox.status} ${JSON.stringify(inbox.data).slice(0, 400)}`);
      }
      const msgs = Array.isArray(inbox.data.messages) ? inbox.data.messages.length : 0;
      process.stdout.write(`OK — /api/mail/inbox (${msgs} berichten)\n`);

      const fo = await httpRequest('GET', '/api/mail/from-options', { cookie });
      if (fo.status !== 200) throw new Error(`/api/mail/from-options ${fo.status}`);
      process.stdout.write(`OK — /api/mail/from-options defaultFrom=${fo.data?.defaultFrom || '—'}\n`);

      if (!directGmailOk) {
        throw new Error('Direct Gmail faalde (niet-invalid_grant); zie boven.');
      }
      process.stdout.write('\nAlle mail-smoke checks geslaagd.\n');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('Mislukt:', e instanceof Error ? e.message : e);
  process.exit(1);
});
