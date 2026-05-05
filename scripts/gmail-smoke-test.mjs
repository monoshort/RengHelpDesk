/**
 * Leest .env en roept Gmail API aan (labels.list) — geen dashboard-login nodig.
 * Gebruik: node scripts/gmail-smoke-test.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const { withGmailRetry, isGmailApiConfigured, isGmailInvalidGrantError } = await import('../server/mail.js');

if (!isGmailApiConfigured(undefined)) {
  console.error(
    'Mislukt: Gmail niet geconfigureerd (ontbreken GOOGLE_CLIENT_ID/SECRET en/of refresh-token in .env of .google_gmail_token.json).'
  );
  process.exit(2);
}

try {
  await withGmailRetry(undefined, async ({ gmail }) => {
    const r = await gmail.users.labels.list({ userId: 'me' });
    const n = Array.isArray(r.data.labels) ? r.data.labels.length : 0;
    console.log('OK — Gmail API reageert. Aantal labels (Postvak IN etc.):', n);
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const data = e?.response?.data;
  console.error('Mislukt:', msg);
  if (data) console.error('Google:', JSON.stringify(data).slice(0, 500));
  if (isGmailInvalidGrantError(e)) {
    console.error(
      '\n→ Google weigert de refresh-token (invalid_grant / revoked). Haal een nieuwe token: gmail-koppel.html lokaal, of werk GOOGLE_GMAIL_REFRESH_TOKEN bij. Daarna: npm run vercel:env:google voor productie.'
    );
  }
  process.exit(1);
}
