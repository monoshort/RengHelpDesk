/**
 * Diagnose Gmail-mail (geen secrets in output).
 * Gebruik: node scripts/mail-doctor.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const tokenPath = path.join(root, '.google_gmail_token.json');
const hasFile = fs.existsSync(tokenPath);
const hasEnvRt = Boolean(String(process.env.GOOGLE_GMAIL_REFRESH_TOKEN || '').trim());
const hasClient = Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
const preferUser = ['1', 'true', 'yes'].includes(
  String(process.env.GOOGLE_GMAIL_PREFER_USER_LINK || '').trim().toLowerCase()
);
const useStoredOnly = ['1', 'true', 'yes'].includes(
  String(process.env.GOOGLE_GMAIL_USE_STORED_LINK_ONLY || '').trim().toLowerCase()
);
const redirectEnv = process.env.GOOGLE_REDIRECT_URI?.trim() || '(niet gezet — lokaal: host uit browser)';

process.stdout.write('--- Mail / Gmail diagnose ---\n');
process.stdout.write(`GOOGLE_CLIENT_ID/SECRET: ${hasClient ? 'aanwezig' : 'ONTBREEKT'}\n`);
process.stdout.write(`GOOGLE_GMAIL_REFRESH_TOKEN in .env: ${hasEnvRt ? 'aanwezig' : 'ontbreekt'}\n`);
process.stdout.write(`.google_gmail_token.json: ${hasFile ? 'aanwezig' : 'ontbreekt'}\n`);
process.stdout.write(`GOOGLE_GMAIL_PREFER_USER_LINK: ${preferUser ? 'true (DB-koppeling wint boven env)' : 'false/weg'}\n`);
process.stdout.write(
  `GOOGLE_GMAIL_USE_STORED_LINK_ONLY: ${useStoredOnly ? 'true (lezen/opslag: bestand/DB, .env-refresh genegeerd)' : 'false/weg'}\n`
);
process.stdout.write(`GOOGLE_REDIRECT_URI: ${redirectEnv}\n`);

const { isGmailApiConfigured, withGmailRetry, isGmailInvalidGrantError } = await import('../server/mail.js');
if (!isGmailApiConfigured(undefined)) {
  process.stdout.write('\n→ Gmail is niet configureerd voor API (client + refresh ontbreekt).\n');
  process.exit(2);
}

try {
  await withGmailRetry(undefined, async ({ gmail }) => {
    const r = await gmail.users.labels.list({ userId: 'me' });
    const n = Array.isArray(r.data.labels) ? r.data.labels.length : 0;
    process.stdout.write(`\nOK — Gmail API werkt (${n} labels).\n`);
  });
  process.exit(0);
} catch (e) {
  if (isGmailInvalidGrantError(e)) {
    process.stdout.write(
      '\nFOUT: invalid_grant (token verlopen/ingetrokken of verkeerde client secret).\n'
    );
    process.stdout.write(
      'Oplossing: 1) In browser: http://localhost:3000/login.html → http://localhost:3000/gmail-koppel.html → opnieuw koppelen.\n'
    );
    process.stdout.write('           2) npm run mail:sync-env  3) npm run vercel:env:google  4) npm run deploy:vercel\n');
    process.exit(1);
  }
  process.stdout.write(`\nFOUT: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
