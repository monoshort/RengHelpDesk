/**
 * Zet GOOGLE_GMAIL_REFRESH_TOKEN in .env vanuit .google_gmail_token.json (na gmail-koppel.html).
 * Gebruik: node scripts/mail-sync-env-from-token.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const tokenPath = path.join(root, '.google_gmail_token.json');

function sanitizeGmailRefreshToken(raw) {
  let s = String(raw ?? '').trim();
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

if (!fs.existsSync(tokenPath)) {
  console.error('Geen .google_gmail_token.json — eerst OAuth: http://localhost:3000/gmail-koppel.html (ingelogd).');
  process.exit(2);
}
let j;
try {
  j = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
} catch (e) {
  console.error('Tokenbestand ongeldige JSON:', e instanceof Error ? e.message : e);
  process.exit(2);
}
const rt = sanitizeGmailRefreshToken(j?.refresh_token);
if (!rt) {
  console.error('Geen refresh_token in .google_gmail_token.json — opnieuw koppelen.');
  process.exit(2);
}

if (!fs.existsSync(envPath)) {
  console.error('Geen .env in projectroot.');
  process.exit(2);
}

let env = fs.readFileSync(envPath, 'utf8');
const line = `GOOGLE_GMAIL_REFRESH_TOKEN=${rt}`;
if (/^GOOGLE_GMAIL_REFRESH_TOKEN=/m.test(env)) {
  env = env.replace(/^GOOGLE_GMAIL_REFRESH_TOKEN=.*$/m, line);
} else if (/\n# OpenAI/m.test(env)) {
  env = env.replace(/\n(# OpenAI)/, `\n${line}\n$1`);
} else {
  env = `${env.trimEnd()}\n${line}\n`;
}
fs.writeFileSync(envPath, env, 'utf8');
process.stdout.write('OK — GOOGLE_GMAIL_REFRESH_TOKEN in .env gezet vanuit .google_gmail_token.json\n');
process.stdout.write('Volgende: npm run mail:smoke  |  productie: npm run vercel:env:google && npm run deploy:vercel\n');
