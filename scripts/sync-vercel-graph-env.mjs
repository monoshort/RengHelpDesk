/**
 * Zet Microsoft Graph (M365 mailbox) uit .env op Vercel Production.
 *
 * Vereist: MICROSOFT_GRAPH_TENANT_ID, MICROSOFT_GRAPH_CLIENT_ID,
 *          MICROSOFT_GRAPH_CLIENT_SECRET, MICROSOFT_GRAPH_MAILBOX
 *
 * Gebruik: npm run vercel:env:graph
 * Daarna: npm run deploy:vercel
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

function sanitizeSecret(raw) {
  let s = String(raw ?? '').trim();
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

const tenantId = process.env.MICROSOFT_GRAPH_TENANT_ID?.trim();
const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID?.trim();
const clientSecret = sanitizeSecret(process.env.MICROSOFT_GRAPH_CLIENT_SECRET);
const mailbox =
  process.env.MICROSOFT_GRAPH_MAILBOX?.trim() ||
  process.env.DEFAULT_OUTBOUND_FROM?.trim() ||
  'info@toddie.nl';

const inbound = process.env.MAIL_INBOUND_PROVIDER?.trim();
const outbound = process.env.MAIL_OUTBOUND_PROVIDER?.trim();

if (!tenantId || !clientId || !clientSecret) {
  console.error(
    'Zet MICROSOFT_GRAPH_TENANT_ID, MICROSOFT_GRAPH_CLIENT_ID en MICROSOFT_GRAPH_CLIENT_SECRET in .env'
  );
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

const steps = [
  ['MICROSOFT_GRAPH_TENANT_ID', tenantId, false],
  ['MICROSOFT_GRAPH_CLIENT_ID', clientId, false],
  ['MICROSOFT_GRAPH_CLIENT_SECRET', clientSecret, true],
  ['MICROSOFT_GRAPH_MAILBOX', mailbox, false],
];

if (inbound) steps.push(['MAIL_INBOUND_PROVIDER', inbound, false]);
else steps.push(['MAIL_INBOUND_PROVIDER', 'graph', false]);

if (outbound) steps.push(['MAIL_OUTBOUND_PROVIDER', outbound, false]);
else steps.push(['MAIL_OUTBOUND_PROVIDER', 'graph', false]);

for (const [name, value, sens] of steps) {
  process.stdout.write(`${name} → production …\n`);
  if (!add(name, value, sens)) {
    console.error(`Mislukt: ${name}`);
    process.exit(1);
  }
}

process.stdout.write('\nGraph-env op Vercel gezet. Deploy: npm run deploy:vercel\n');
