/**
 * Valideert desk-knowledge/: intents.json + verwijzingen naar workflows/snippets.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desk-knowledge');

function fail(msg) {
  console.error(`desk-knowledge: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(root)) {
  fail('map desk-knowledge/ ontbreekt');
}

const manifestPath = path.join(root, 'intents.json');
if (!fs.existsSync(manifestPath)) {
  fail('intents.json ontbreekt');
}

/** @type {{ version?: number; intents?: unknown[] }} */
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`intents.json ongeldig: ${e instanceof Error ? e.message : e}`);
}

const intents = Array.isArray(manifest.intents) ? manifest.intents : [];
if (!intents.length) {
  fail('geen intents gedefinieerd');
}

const ids = new Set();
let errors = 0;

for (const intent of intents) {
  const id = String(intent?.id || '').trim();
  if (!id) {
    console.error('  - intent zonder id');
    errors += 1;
    continue;
  }
  if (ids.has(id)) {
    console.error(`  - dubbele intent id: ${id}`);
    errors += 1;
  }
  ids.add(id);

  const wf = intent?.workflow ? String(intent.workflow) : '';
  if (wf) {
    const p = path.join(root, wf.replace(/\\/g, '/'));
    if (!fs.existsSync(p)) {
      console.error(`  - ${id}: workflow ontbreekt: ${wf}`);
      errors += 1;
    }
  }

  const snippets = Array.isArray(intent.snippets) ? intent.snippets : [];
  for (const sn of snippets) {
    const rel = String(sn || '').trim();
    if (!rel) continue;
    const p = path.join(root, rel.replace(/\\/g, '/'));
    if (!fs.existsSync(p)) {
      console.error(`  - ${id}: snippet ontbreekt: ${rel}`);
      errors += 1;
    }
  }
}

const tonePath = path.join(root, 'tone-and-rules.md');
if (!fs.existsSync(tonePath)) {
  console.warn('  waarschuwing: tone-and-rules.md ontbreekt');
}

if (errors > 0) {
  process.exit(1);
}

console.log(
  `desk-knowledge OK — ${intents.length} intent(s), versie ${manifest.version ?? '?'}`
);
