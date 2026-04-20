/**
 * Zet SHOPIFY_ACCESS_TOKEN + SHOPIFY_SHOP_DOMAIN op Vercel (Production) uit lokale .env.
 * Preview met git-branch vereist een gekoppelde Git-repo op het Vercel-project; zonder repo slaat dat stap over.
 *
 * Gebruik: node scripts/sync-vercel-shopify-env.mjs
 * Daarna: npx vercel deploy --prod --yes
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const token = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
const shop = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
const previewBranch =
  process.env.VERCEL_PREVIEW_GIT_BRANCH?.trim() ||
  spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf-8' }).stdout?.trim() ||
  'main';
const syncPreview = String(process.env.VERCEL_SYNC_PREVIEW || '').toLowerCase() === 'true';

if (!token) {
  console.error('Geen SHOPIFY_ACCESS_TOKEN in .env');
  process.exit(1);
}

/**
 * @param {string} name
 * @param {string} value
 * @param {'production' | 'preview'} target
 * @param {boolean} sensitive
 * @param {string} [gitBranch]
 */
function add(name, value, target, sensitive, gitBranch) {
  const args = [
    '--yes',
    'vercel@latest',
    'env',
    'add',
    name,
    target,
  ];
  if (target === 'preview' && gitBranch) args.push(gitBranch);
  args.push('--value', value);
  if (sensitive) args.push('--sensitive');
  args.push('--force', '--yes');
  const r = spawnSync('npx', args, { cwd: root, encoding: 'utf-8', shell: true });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

process.stdout.write('SHOPIFY_ACCESS_TOKEN → production …\n');
if (!add('SHOPIFY_ACCESS_TOKEN', token, 'production', true)) {
  process.stderr.write('Mislukt production token\n');
  process.exit(1);
}

if (syncPreview) {
  process.stdout.write(`SHOPIFY_ACCESS_TOKEN → preview (${previewBranch}) …\n`);
  if (!add('SHOPIFY_ACCESS_TOKEN', token, 'preview', true, previewBranch)) {
    process.stderr.write(
      'Preview-token mislukt (Vercel-project heeft mogelijk geen Git-koppeling). Zet alleen Production of koppel Git.\n'
    );
    process.exit(1);
  }
}

if (shop) {
  process.stdout.write('SHOPIFY_SHOP_DOMAIN → production …\n');
  if (!add('SHOPIFY_SHOP_DOMAIN', shop, 'production', false)) {
    process.stderr.write('Mislukt SHOPIFY_SHOP_DOMAIN production\n');
    process.exit(1);
  }
  if (syncPreview) {
    process.stdout.write(`SHOPIFY_SHOP_DOMAIN → preview (${previewBranch}) …\n`);
    if (!add('SHOPIFY_SHOP_DOMAIN', shop, 'preview', false, previewBranch)) {
      process.stderr.write('Mislukt SHOPIFY_SHOP_DOMAIN preview\n');
      process.exit(1);
    }
  }
}

process.stdout.write('Klaar. Redeploy: npx vercel deploy --prod --yes\n');
