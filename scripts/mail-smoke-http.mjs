/**
 * Alleen server + dashboard-login + /api/config (geen Gmail-API).
 * Gebruik: node scripts/mail-smoke-http.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const port = Number(process.env.MAIL_SMOKE_PORT || '') || 37_992;
const base = `http://127.0.0.1:${port}`;

function getDashboardPassword() {
  return process.env.DASHBOARD_PASSWORD?.trim() || 'RengTod123!';
}

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
            data = { _raw: raw.slice(0, 300) };
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
    if (Date.now() - start > maxMs) throw new Error('Server start timeout');
    await new Promise((r) => setTimeout(r, 250));
    return poll();
  })();
}

async function main() {
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      VERCEL: '',
      npm_lifecycle_event: 'start',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForHealth();
    const login = await httpRequest('POST', '/api/dashboard/login', {
      json: { password: getDashboardPassword() },
    });
    if (login.status !== 200 || !login.data?.ok) {
      throw new Error(`Login ${login.status} ${JSON.stringify(login.data)}`);
    }
    const cookie = login.cookies;
    if (!cookie?.includes('reng_dashboard=')) throw new Error('Geen sessie-cookie');

    const cfg = await httpRequest('GET', '/api/config', { cookie });
    if (cfg.status !== 200) throw new Error(`/api/config ${cfg.status}`);
    console.log('OK — health + login + /api/config');
    console.log(
      `    gmailReady=${cfg.data?.gmailReady} gmailSharedMailboxMode=${cfg.data?.gmailSharedMailboxMode}`
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('Mislukt:', e instanceof Error ? e.message : e);
  process.exit(1);
});
