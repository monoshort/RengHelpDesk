/**
 * Zet Google OAuth + Gmail + OpenAI uit .env op Vercel Production (zelfde patroon als sync-vercel-shopify-env).
 *
 * Vereist in .env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (en bij voorkeur GOOGLE_GMAIL_FROM).
 * Optioneel: GOOGLE_GMAIL_REFRESH_TOKEN in .env, óf alleen .google_gmail_token.json (lokaal na koppelen), OPENAI_API_KEY.
 * GOOGLE_REDIRECT_URI: uit .env, of default productie-URL hieronder.
 *
 * Gebruik: node scripts/sync-vercel-google-env.mjs
 * Daarna: npm run deploy:vercel
 */
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const DEFAULT_REDIRECT =
  process.env.GOOGLE_REDIRECT_URI_VERCEL?.trim() ||
  'https://reng-help-desk.vercel.app/api/auth/gmail/callback';

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || DEFAULT_REDIRECT;
const gmailFrom = process.env.GOOGLE_GMAIL_FROM?.trim();
/** .env heeft voorrang; anders lokaal tokenbestand na OAuth via /gmail-koppel.html */
let refreshToken = process.env.GOOGLE_GMAIL_REFRESH_TOKEN?.trim();
if (!refreshToken) {
  const tokenPath = path.join(root, '.google_gmail_token.json');
  try {
    if (fs.existsSync(tokenPath)) {
      const j = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (j?.refresh_token) refreshToken = String(j.refresh_token).trim();
    }
  } catch (e) {
    console.error('.google_gmail_token.json lezen mislukt:', e instanceof Error ? e.message : e);
  }
}
const openAiKey = process.env.OPENAI_API_KEY?.trim();

if (!clientId || !clientSecret) {
  console.error('Zet minstens GOOGLE_CLIENT_ID en GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

/**
 * @param {string} name
 * @param {string} value
 * @param {boolean} sensitive
 */
function add(name, value, sensitive) {
  const args = ['--yes', 'vercel@latest', 'env', 'add', name, 'production', '--value', value];
  if (sensitive) args.push('--sensitive');
  args.push('--force', '--yes');
  const r = spawnSync('npx', args, { cwd: root, encoding: 'utf-8', shell: true });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

function main() {
  const steps = [
    ['GOOGLE_CLIENT_ID', clientId, false],
    ['GOOGLE_CLIENT_SECRET', clientSecret, true],
    ['GOOGLE_REDIRECT_URI', redirectUri, false],
  ];
  if (gmailFrom) steps.push(['GOOGLE_GMAIL_FROM', gmailFrom, false]);
  if (refreshToken) steps.push(['GOOGLE_GMAIL_REFRESH_TOKEN', refreshToken, true]);
  if (openAiKey) steps.push(['OPENAI_API_KEY', openAiKey, true]);

  for (const [name, value, sens] of steps) {
    process.stdout.write(`${name} → production …\n`);
    if (!add(name, value, sens)) {
      console.error(`Mislukt: ${name}`);
      process.exit(1);
    }
  }

  if (!refreshToken) {
    process.stdout.write(
      '\nLet op: geen refresh-token (.env noch .google_gmail_token.json) — koppel lokaal via /gmail-koppel.html of zet GOOGLE_GMAIL_REFRESH_TOKEN in .env en draai dit script opnieuw.\n'
    );
  }
  process.stdout.write('\nKlaar. Deploy: npm run deploy:vercel\n');
}

main();
