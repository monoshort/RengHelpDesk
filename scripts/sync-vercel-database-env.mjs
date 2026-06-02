#!/usr/bin/env node
/**
 * Zet DATABASE_URL op Vercel Production uit lokale .env.
 * Gebruik: node scripts/sync-vercel-database-env.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const dbUrl = process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error('Geen DATABASE_URL in .env — eerst: npx neon-new --yes');
  process.exit(1);
}

function run(args, input) {
  const r = spawnSync('npx', ['--yes', 'vercel@latest', ...args], {
    cwd: root,
    encoding: 'utf-8',
    input,
    shell: false,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

process.stdout.write('DATABASE_URL verwijderen (indien aanwezig) …\n');
run(['env', 'rm', 'DATABASE_URL', 'production', '-y']);

process.stdout.write('DATABASE_URL → Vercel production …\n');
if (
  !run([
    'env',
    'add',
    'DATABASE_URL',
    'production',
    '--value',
    dbUrl,
    '--sensitive',
    '--force',
    '--yes',
  ])
) {
  process.stderr.write('Mislukt — controleer Vercel-login (npx vercel login)\n');
  process.exit(1);
}
process.stdout.write('Klaar. Draai npm run deploy:vercel om de nieuwe env te activeren.\n');
