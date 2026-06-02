/**
 * Platformbrede configuratie (API-keys, integraties) — Postgres of lokaal bestand.
 * Waarden in de UI overschrijven .env zodra opgeslagen (runtime via getPlatformConfigValue).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const CONFIG_ROW_ID = 'default';

/** @type {import('postgres').Sql | null} */
let pg = null;
let tableEnsured = false;

/** @type {{ values: Record<string, string>; source: string; updatedAt: string | null } | null} */
let memoryCache = null;
/** @type {Promise<void> | null} */
let loadTail = null;

/** @type {{ id: string; label: string; hint?: string; fields: { key: string; label: string; type: 'secret' | 'text' | 'boolean'; placeholder?: string; default?: string }[] }[]} */
export const PLATFORM_CONFIG_GROUPS = [
  {
    id: 'platform',
    label: 'Platform',
    fields: [
      { key: 'PLATFORM_NAME', label: 'Naam in UI', type: 'text', placeholder: 'Toddie Helpdesk' },
      {
        key: 'DESK_KNOWLEDGE_ENABLED',
        label: 'Kennisbank aan (server)',
        type: 'text',
        placeholder: 'true',
        default: 'true',
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Vereist voor AI-antwoorden en vertalen naar Nederlands.',
    fields: [
      {
        key: 'OPENAI_API_KEY',
        label: 'API-sleutel',
        type: 'secret',
        placeholder: 'sk-…',
      },
      {
        key: 'OPENAI_MODEL',
        label: 'Model',
        type: 'text',
        default: 'gpt-4o-mini',
        placeholder: 'gpt-4o-mini',
      },
    ],
  },
  {
    id: 'graph',
    label: 'Microsoft 365 (Graph)',
    hint: 'App-only voor gedeeld postvak (info@…). Admin consent + RBAC op mailbox.',
    fields: [
      { key: 'MICROSOFT_GRAPH_TENANT_ID', label: 'Tenant ID', type: 'text' },
      { key: 'MICROSOFT_GRAPH_CLIENT_ID', label: 'Client ID', type: 'text' },
      { key: 'MICROSOFT_GRAPH_CLIENT_SECRET', label: 'Client secret', type: 'secret' },
      {
        key: 'MICROSOFT_GRAPH_MAILBOX',
        label: 'Mailbox (UPN)',
        type: 'text',
        placeholder: 'info@toddie.nl',
      },
      {
        key: 'MAIL_INBOUND_PROVIDER',
        label: 'Inbox-provider (env)',
        type: 'text',
        placeholder: 'auto | graph | gmail',
      },
      {
        key: 'MAIL_OUTBOUND_PROVIDER',
        label: 'Verzenden (env)',
        type: 'text',
        placeholder: 'auto | graph | gmail | smtp',
      },
    ],
  },
  {
    id: 'google',
    label: 'Google / Gmail',
    hint: 'OAuth-client + optioneel organisatie-refresh-token.',
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', type: 'text' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', type: 'secret' },
      { key: 'GOOGLE_GMAIL_FROM', label: 'Afzender', type: 'text', placeholder: 'info@toddie.nl' },
      {
        key: 'GOOGLE_GMAIL_REFRESH_TOKEN',
        label: 'Refresh token (org.)',
        type: 'secret',
      },
      { key: 'GOOGLE_REDIRECT_URI', label: 'Redirect URI', type: 'text' },
    ],
  },
  {
    id: 'shopify',
    label: 'Shopify',
    hint: 'Orders en klantcontext. OAuth via Koppelen blijft mogelijk naast deze velden.',
    fields: [
      { key: 'SHOPIFY_SHOP_DOMAIN', label: 'Shop-domein', type: 'text', placeholder: 'shop.myshopify.com' },
      { key: 'SHOPIFY_ACCESS_TOKEN', label: 'Admin API-token', type: 'secret', placeholder: 'shpat_…' },
      { key: 'SHOPIFY_CLIENT_ID', label: 'Client ID (OAuth)', type: 'text' },
      { key: 'SHOPIFY_CLIENT_SECRET', label: 'Client secret', type: 'secret' },
    ],
  },
  {
    id: 'dpd',
    label: 'DPD',
    fields: [
      { key: 'DPD_DELIS_ID', label: 'Delis ID', type: 'text' },
      { key: 'DPD_DELIS_PASSWORD', label: 'Wachtwoord', type: 'secret' },
      { key: 'DPD_USE_STAGE', label: 'Testomgeving (true/false)', type: 'text', placeholder: 'false' },
    ],
  },
  {
    id: 'smtp',
    label: 'SMTP (optioneel)',
    fields: [
      { key: 'SMTP_HOST', label: 'Host', type: 'text' },
      { key: 'SMTP_PORT', label: 'Poort', type: 'text', placeholder: '587' },
      { key: 'SMTP_USER', label: 'Gebruiker', type: 'text' },
      { key: 'SMTP_PASS', label: 'Wachtwoord', type: 'secret' },
      { key: 'SMTP_FROM', label: 'From-adres', type: 'text' },
      { key: 'SMTP_SEND_FIRST', label: 'SMTP eerst (true/false)', type: 'text' },
    ],
  },
];

const SECRET_KEYS = new Set(
  PLATFORM_CONFIG_GROUPS.flatMap((g) => g.fields.filter((f) => f.type === 'secret').map((f) => f.key))
);

const ALL_KEYS = new Set(PLATFORM_CONFIG_GROUPS.flatMap((g) => g.fields.map((f) => f.key)));

function configFilePath() {
  if (String(process.env.VERCEL || '').trim() === '1') {
    return path.join('/tmp', 'reng-platform-config.json');
  }
  return path.join(root, 'data', 'platform-config.json');
}

async function getPg() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!pg) {
    const postgres = (await import('postgres')).default;
    pg = postgres(url, { max: 3, idle_timeout: 20 });
  }
  return pg;
}

async function ensureTable(sql) {
  if (tableEnsured) return;
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS reng_platform_config (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  tableEnsured = true;
}

async function loadFromPersistence() {
  const sql = await getPg();
  if (sql) {
    try {
      await ensureTable(sql);
      const rows = await sql`
        select payload, updated_at from reng_platform_config where id = ${CONFIG_ROW_ID} limit 1
      `;
      if (rows?.length) {
        const payload = rows[0].payload;
        const values =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? /** @type {Record<string, string>} */ (
                Object.fromEntries(
                  Object.entries(payload).map(([k, v]) => [k, v == null ? '' : String(v)])
                )
              )
            : {};
        return {
          values,
          source: 'postgres',
          updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
        };
      }
      return { values: {}, source: 'postgres', updatedAt: null };
    } catch (e) {
      console.error(
        '[platformConfig] Postgres laden mislukt:',
        e instanceof Error ? e.message : e
      );
      return {
        values: {},
        source: 'env-only',
        updatedAt: null,
        loadError: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const file = configFilePath();
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const values =
        j?.values && typeof j.values === 'object' ? /** @type {Record<string, string>} */ (j.values) : {};
      return {
        values,
        source: 'file',
        updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : null,
      };
    }
  } catch {
    /* ignore */
  }
  return { values: {}, source: 'file', updatedAt: null };
}

async function saveToPersistence(values) {
  const sql = await getPg();
  const updatedAt = new Date().toISOString();
  if (sql) {
    try {
      await ensureTable(sql);
      const json = JSON.stringify(values);
      await sql.unsafe(
        `insert into reng_platform_config (id, payload, updated_at) values ($1, $2::jsonb, now())
         on conflict (id) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
        [CONFIG_ROW_ID, json]
      );
      return { source: 'postgres', updatedAt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Platformconfig opslaan in Postgres mislukt: ${msg}`);
    }
  }

  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ values, updatedAt }, null, 2),
    'utf8'
  );
  return { source: 'file', updatedAt };
}

export async function hydratePlatformConfig() {
  try {
    memoryCache = await loadFromPersistence();
  } catch (e) {
    console.error('[platformConfig] hydrate mislukt:', e instanceof Error ? e.message : e);
    memoryCache = {
      values: {},
      source: 'env-only',
      updatedAt: null,
      loadError: e instanceof Error ? e.message : String(e),
    };
  }
  loadTail = null;
}

export async function ensurePlatformConfigLoaded() {
  if (memoryCache) return memoryCache;
  if (!loadTail) {
    loadTail = hydratePlatformConfig();
  }
  try {
    await loadTail;
  } catch (e) {
    console.error('[platformConfig] ensure load mislukt:', e instanceof Error ? e.message : e);
    loadTail = null;
    if (!memoryCache) {
      memoryCache = {
        values: {},
        source: 'env-only',
        updatedAt: null,
        loadError: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return memoryCache;
}

/**
 * Effectieve waarde: opgeslagen platformconfig, anders .env
 * @param {string} key
 */
export function getPlatformConfigValue(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const stored = memoryCache?.values?.[k];
  if (stored !== undefined && String(stored).trim() !== '') {
    return String(stored).trim();
  }
  return process.env[k]?.trim() || '';
}

/**
 * @param {string} key
 */
export function maskConfigValue(key, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!SECRET_KEYS.has(key)) return v;
  if (v.length <= 8) return '••••••••';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/**
 * @param {Record<string, string>} stored
 */
export function buildPlatformConfigForApi(stored) {
  /** @type {Record<string, { value: string; masked: string; fromEnv: boolean; fromStore: boolean; isSecret: boolean }>} */
  const fields = {};
  for (const key of ALL_KEYS) {
    const fromStore = stored[key] !== undefined && String(stored[key]).trim() !== '';
    const fromEnv = Boolean(process.env[key]?.trim());
    const effective = fromStore ? String(stored[key]).trim() : process.env[key]?.trim() || '';
    fields[key] = {
      value: SECRET_KEYS.has(key) ? '' : effective,
      masked: maskConfigValue(key, effective),
      fromEnv,
      fromStore,
      isSecret: SECRET_KEYS.has(key),
    };
  }
  return {
    groups: PLATFORM_CONFIG_GROUPS,
    fields,
    storage: {
      source: memoryCache?.source || 'env-only',
      updatedAt: memoryCache?.updatedAt || null,
      hasDatabase: Boolean(process.env.DATABASE_URL?.trim()),
      onVercel: String(process.env.VERCEL || '').trim() === '1',
      loadError:
        memoryCache && 'loadError' in memoryCache && memoryCache.loadError
          ? String(memoryCache.loadError)
          : null,
    },
  };
}

/**
 * @param {Record<string, string | null | undefined>} patch — lege string bij secrets = niet wijzigen
 */
export async function mergePlatformConfigPatch(patch) {
  await ensurePlatformConfigLoaded();
  const current = { ...(memoryCache?.values || {}) };
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!ALL_KEYS.has(key)) continue;
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (SECRET_KEYS.has(key) && s === '') continue;
    if (s === '') {
      delete current[key];
      continue;
    }
    current[key] = s;
  }
  const meta = await saveToPersistence(current);
  memoryCache = { values: current, source: meta.source, updatedAt: meta.updatedAt };
  return memoryCache;
}
