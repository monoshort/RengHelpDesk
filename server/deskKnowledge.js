/**
 * Laadt desk-knowledge/ (playbooks) en koppelt intents aan inkomende mail voor AI-prompts.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDeskKnowledgeEnabledForSettings } from './workspaceSettings.js';
import { getPlatformConfigValue } from './platformConfigStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_ROOT = path.join(__dirname, '..', 'desk-knowledge');

/** @type {{ manifest: Record<string, unknown>; tone: string; mtime: number } | null} */
let cache = null;

function deskKnowledgeEnabled() {
  const v = String(getPlatformConfigValue('DESK_KNOWLEDGE_ENABLED') || 'true').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

function maxChars() {
  const n = Number(process.env.DESK_KNOWLEDGE_MAX_CHARS || '');
  if (Number.isFinite(n) && n >= 2000 && n <= 30_000) return n;
  return 8000;
}

function loadBundle() {
  if (!deskKnowledgeEnabled()) return null;
  if (!fs.existsSync(KNOWLEDGE_ROOT)) return null;

  const manifestPath = path.join(KNOWLEDGE_ROOT, 'intents.json');
  const tonePath = path.join(KNOWLEDGE_ROOT, 'tone-and-rules.md');
  const mtime = Math.max(
    fs.existsSync(manifestPath) ? fs.statSync(manifestPath).mtimeMs : 0,
    fs.existsSync(tonePath) ? fs.statSync(tonePath).mtimeMs : 0
  );
  if (cache && cache.mtime === mtime) return cache;

  /** @type {Record<string, unknown>} */
  let manifest = { version: 0, intents: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  const tone = fs.existsSync(tonePath) ? fs.readFileSync(tonePath, 'utf8').trim() : '';
  cache = { manifest, tone, mtime };
  return cache;
}

/**
 * @param {string} rel
 */
function readKnowledgeFile(rel) {
  const p = path.join(KNOWLEDGE_ROOT, rel.replace(/\\/g, '/'));
  if (!p.startsWith(KNOWLEDGE_ROOT) || !fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').trim();
}

/**
 * @param {string} text
 * @param {number} limit
 */
function truncate(text, limit) {
  const s = String(text || '').trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 20)}\n\n[… ingekort …]`;
}

/**
 * @param {{ incomingBody?: string; incomingSubject?: string; hasOrderMatch?: boolean; orderRelevantToQuestion?: boolean; workspaceSettings?: import('./workspaceSettings.js').WorkspaceSettings | null }} opts
 */
export function resolveDeskKnowledge(opts = {}) {
  const empty = {
    enabled: false,
    intentIds: [],
    labels: [],
    replyStyle: null,
    promptBlock: '',
  };
  if (!isDeskKnowledgeEnabled() || !isDeskKnowledgeEnabledForSettings(opts.workspaceSettings)) {
    return { ...empty, enabled: false };
  }
  const bundle = loadBundle();
  if (!bundle) return { ...empty, enabled: false };

  const sample = [opts.incomingSubject, opts.incomingBody]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (!sample) {
    return {
      enabled: true,
      intentIds: [],
      labels: [],
      replyStyle: null,
      promptBlock: buildPromptBlock(bundle, []),
    };
  }

  const intents = Array.isArray(bundle.manifest.intents) ? bundle.manifest.intents : [];
  /** @type {{ intent: Record<string, unknown>; score: number }[]} */
  const scored = [];
  const orderTopicOk = opts.orderRelevantToQuestion !== false;
  for (const intent of intents) {
    if (!intent || typeof intent !== 'object') continue;
    if (intent.requiresNoOrder && opts.hasOrderMatch) continue;
    const intentId = String(intent.id || '');
    if (
      !orderTopicOk &&
      (intentId === 'shipping_delay' ||
        intentId === 'return_exchange' ||
        intentId === 'damaged_or_wrong' ||
        intentId === 'no_order_match')
    ) {
      continue;
    }
    const keywords = Array.isArray(intent.keywords) ? intent.keywords : [];
    let score = 0;
    for (const kw of keywords) {
      const k = String(kw || '').trim().toLowerCase();
      if (k.length >= 3 && sample.includes(k)) score += 1;
    }
    if (score > 0) scored.push({ intent, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 2).map((x) => x.intent);

  const replyStyle =
    top[0] && typeof top[0].replyStyle === 'string' ? String(top[0].replyStyle).trim() : null;

  return {
    enabled: true,
    intentIds: top.map((i) => String(i.id || '')).filter(Boolean),
    labels: top.map((i) => String(i.label || i.id || '')).filter(Boolean),
    replyStyle: replyStyle || null,
    promptBlock: buildPromptBlock(bundle, top),
  };
}

/**
 * @param {{ manifest: Record<string, unknown>; tone: string }} bundle
 * @param {Record<string, unknown>[]} matchedIntents
 */
function buildPromptBlock(bundle, matchedIntents) {
  const parts = [];
  const shop = bundle.manifest.shopName ? String(bundle.manifest.shopName) : 'Toddie';
  parts.push(
    `--- Toddie desk knowledge (${shop}): standaard werkwijzen en antwoorden ---`,
    'Volg deze richtlijnen waar ze passen bij de klantmail. Pas formuleringen aan de klanttaal aan; behoud beleid en toezeggingen.',
    ''
  );
  if (bundle.tone) {
    parts.push('## Algemene toon en regels', bundle.tone, '');
  }
  for (const intent of matchedIntents) {
    const label = intent.label || intent.id || 'Intent';
    parts.push(`## Intent: ${label}`);
    if (intent.workflow) {
      const wf = readKnowledgeFile(String(intent.workflow));
      if (wf) parts.push('### Werkwijze', wf, '');
    }
    const snippets = Array.isArray(intent.snippets) ? intent.snippets : [];
    for (const sn of snippets) {
      const body = readKnowledgeFile(String(sn));
      if (body) parts.push('### Voorbeeld/snippet (basis, niet letterlijk kopiëren indien onnatuurlijk)', body, '');
    }
  }
  if (!matchedIntents.length) {
    parts.push(
      '(Geen specifiek playbook gematcht op keywords — gebruik algemene toon/regels en ordercontext.)',
      ''
    );
  }
  return truncate(parts.join('\n'), maxChars());
}

export function isDeskKnowledgeEnabled() {
  return deskKnowledgeEnabled() && Boolean(loadBundle());
}

export function listDeskKnowledgeIntents() {
  const bundle = loadBundle();
  if (!bundle) return [];
  const intents = Array.isArray(bundle.manifest.intents) ? bundle.manifest.intents : [];
  return intents.map((i) => ({
    id: String(i.id || ''),
    label: String(i.label || i.id || ''),
    keywords: Array.isArray(i.keywords) ? i.keywords : [],
    replyStyle: i.replyStyle ? String(i.replyStyle) : null,
  }));
}
