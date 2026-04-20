#!/usr/bin/env node
/**
 * Vercel CLI kan op Windows falen als de projectmap haakjes bevat (bijv. ...\(Yenlo\...).
 * Dit script kopieert naar een temp-map zonder zo'n pad en draait daar `vercel deploy --prod`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const EXCLUDE = new Set(['node_modules', '.git', '.vercel']);

function shallowCopyProject(dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(root)) {
    if (EXCLUDE.has(name)) continue;
    cpSync(path.join(root, name), path.join(dst, name), { recursive: true });
  }
  const srcProj = path.join(root, '.vercel', 'project.json');
  if (existsSync(srcProj)) {
    const vDir = path.join(dst, '.vercel');
    mkdirSync(vDir, { recursive: true });
    cpSync(srcProj, path.join(vDir, 'project.json'));
  }
}

const dest = path.join(tmpdir(), `reng-vercel-deploy-${Date.now()}`);
/** @type {number} */
let exitCode = 0;
try {
  shallowCopyProject(dest);
  if (!existsSync(path.join(dest, '.vercel', 'project.json'))) {
    const project = process.env.VERCEL_PROJECT_NAME || 'reng-help-desk';
    execSync(`npx --yes vercel@latest link --yes --project ${project}`, {
      cwd: dest,
      stdio: 'inherit',
      shell: true,
      env: process.env,
    });
  }
  execSync('npx --yes vercel@latest deploy --yes --prod', {
    cwd: dest,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
} catch (e) {
  exitCode = /** @type {NodeJS.ErrnoException & { status?: number }} */ (e).status || 1;
} finally {
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.exit(exitCode);
