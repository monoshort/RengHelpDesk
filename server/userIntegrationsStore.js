/**
 * Per dashboard-sessie (sid): eigen Shopify- en Gmail-koppelgegevens.
 * — Met DATABASE_URL: Postgres tabel `reng_user_integrations` (aanbevolen op Vercel).
 * — Zonder: bestanden onder `data/user-integrations/` (lokaal) of `/tmp/reng-user-integrations/` (Vercel, vluchtig).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** @type {import('postgres').Sql | null} */
let pg = null;
let tableEnsured = false;

function usePostgres() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function integrationsRootDir() {
  if (String(process.env.VERCEL || '').trim() === '1') {
    return path.join('/tmp', 'reng-user-integrations');
  }
  return path.join(root, 'data', 'user-integrations');
}

/**
 * @param {string | null | undefined} sid
 * @returns {string | null}
 */
export function sanitizeDashboardSid(sid) {
  if (!sid || typeof sid !== 'string') return null;
  const t = sid.trim().toLowerCase();
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  return t;
}

async function getPg() {
  if (!usePostgres()) return null;
  if (!pg) {
    const postgres = (await import('postgres')).default;
    pg = postgres(process.env.DATABASE_URL.trim(), {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return pg;
}

async function ensureTable(sql) {
  if (tableEnsured) return;
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS reng_user_integrations (
      sid text NOT NULL,
      kind text NOT NULL,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sid, kind)
    )
  `);
  tableEnsured = true;
}

/**
 * @param {string} sid
 * @param {'shopify' | 'gmail'} kind
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function loadUserIntegrationDoc(sid, kind) {
  const key = sanitizeDashboardSid(sid);
  if (!key) return null;
  const sql = await getPg();
  if (sql) {
    try {
      await ensureTable(sql);
      const rows = await sql`
        select payload from reng_user_integrations where sid = ${key} and kind = ${kind} limit 1
      `;
      if (!rows?.length) return null;
      const p = rows[0].payload;
      if (p && typeof p === 'object' && !Array.isArray(p)) return /** @type {Record<string, unknown>} */ ({ ...p });
      return null;
    } catch (e) {
      console.error('[userIntegrationsStore] Postgres load failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  const dir = path.join(integrationsRootDir(), key);
  const file = path.join(dir, `${kind}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return /** @type {Record<string, unknown>} */ (j);
  } catch {
    return null;
  }
}

/**
 * Verwijdert een opgeslagen koppeling (bijv. oude Gmail-token wissen zodat env weer geldt).
 * @param {string} sid
 * @param {'shopify' | 'gmail'} kind
 */
export async function deleteUserIntegrationDoc(sid, kind) {
  const key = sanitizeDashboardSid(sid);
  if (!key) throw new Error('deleteUserIntegrationDoc: ongeldige sid.');
  const sql = await getPg();
  if (sql) {
    await ensureTable(sql);
    await sql`delete from reng_user_integrations where sid = ${key} and kind = ${kind}`;
    return;
  }
  const file = path.join(integrationsRootDir(), key, `${kind}.json`);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} sid
 * @param {'shopify' | 'gmail'} kind
 * @param {Record<string, unknown>} doc
 */
export async function saveUserIntegrationDoc(sid, kind, doc) {
  const key = sanitizeDashboardSid(sid);
  if (!key) throw new Error('saveUserIntegrationDoc: ongeldige sid.');
  const sql = await getPg();
  if (sql) {
    await ensureTable(sql);
    const json = JSON.stringify(doc);
    await sql.unsafe(
      `insert into reng_user_integrations (sid, kind, payload, updated_at) values ($1, $2, $3::jsonb, now())
       on conflict (sid, kind) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
      [key, kind, json]
    );
    return;
  }

  const dir = path.join(integrationsRootDir(), key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}.json`);
  const tmp = path.join(dir, `.${kind}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(tmp, file);
  }
}
