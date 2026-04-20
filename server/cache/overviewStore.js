/**
 * Persistente order-/product-/mail-cache.
 * — sql.js (SQLite in WASM, geen native build): default, bestand op schijf
 * — Postgres: DATABASE_URL (aanbevolen op Vercel voor gedeelde state)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

function cacheDisabled() {
  return String(process.env.CACHE_DISABLED || '').toLowerCase() === 'true';
}

function defaultSqlitePath() {
  const env = process.env.CACHE_SQLITE_PATH?.trim();
  if (env) return env;
  if (String(process.env.VERCEL || '').trim() === '1') {
    return path.join('/tmp', 'overview-cache.db');
  }
  const dir = process.env.CACHE_DATA_DIR?.trim() || path.join(root, 'data');
  return path.join(dir, 'overview-cache.db');
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS shop_sync (
  shop_domain TEXT PRIMARY KEY,
  high_water_updated_at TEXT,
  last_sync_at TEXT NOT NULL,
  last_full_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS orders_cache (
  shop_domain TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (shop_domain, order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_shop_created ON orders_cache(shop_domain, created_at DESC);

CREATE TABLE IF NOT EXISTS product_cache (
  shop_domain TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  handle TEXT,
  image_map_json TEXT NOT NULL,
  production_json TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (shop_domain, product_id)
);

CREATE TABLE IF NOT EXISTS order_mail_cache (
  shop_domain TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  order_updated_at TEXT NOT NULL,
  events_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (shop_domain, order_id)
);
`;

/** @type {import('sql.js').SqlJsStatic | null} */
let SQLModule = null;
/** @type {import('sql.js').Database | null} */
let sqlJsDb = null;
let sqlJsPath = '';

async function initSqlJsDatabase() {
  if (sqlJsDb) return sqlJsDb;
  const initSqlJs = (await import('sql.js')).default;
  SQLModule = await initSqlJs();
  sqlJsPath = defaultSqlitePath();
  fs.mkdirSync(path.dirname(sqlJsPath), { recursive: true });
  if (fs.existsSync(sqlJsPath)) {
    const buf = fs.readFileSync(sqlJsPath);
    sqlJsDb = new SQLModule.Database(buf);
  } else {
    sqlJsDb = new SQLModule.Database();
  }
  sqlJsDb.exec(MIGRATION_SQL);
  return sqlJsDb;
}

function persistSqlJs() {
  if (!sqlJsDb || !sqlJsPath) return;
  const data = sqlJsDb.export();
  fs.writeFileSync(sqlJsPath, Buffer.from(data));
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
function jsGet(db, sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  if (!st.step()) {
    st.free();
    return null;
  }
  const o = st.getAsObject();
  st.free();
  return o;
}

/**
 * @param {import('sql.js').Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
function jsAll(db, sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) {
    out.push(st.getAsObject());
  }
  st.free();
  return out;
}

async function runPgMigrations(pgSql) {
  const parts = MIGRATION_SQL.split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const stmt of parts) {
    await pgSql.unsafe(stmt);
  }
}

async function openPostgres() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  const postgres = (await import('postgres')).default;
  const sql = postgres(url, { max: 3, idle_timeout: 20, connect_timeout: 10 });
  await runPgMigrations(sql);
  return sql;
}

/**
 * @returns {Promise<{ kind: 'sqljs'|'postgres'|'none', sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }>}
 */
export async function getCacheBackend() {
  if (cacheDisabled()) return { kind: 'none' };
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const pg = await openPostgres();
      if (pg) return { kind: 'postgres', pg };
    } catch (e) {
      console.error('[overviewStore] DATABASE_URL connect failed:', e instanceof Error ? e.message : e);
    }
  }
  try {
    const db = await initSqlJsDatabase();
    return {
      kind: 'sqljs',
      sqljs: db,
      persist: persistSqlJs,
    };
  } catch (e) {
    console.error('[overviewStore] sql.js init failed:', e instanceof Error ? e.message : e);
    return { kind: 'none' };
  }
}

function maybePersist(backend) {
  if (typeof backend.persist === 'function') backend.persist();
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 */
export async function getSyncState(backend, shopDomain) {
  const s = shopDomain.trim().toLowerCase();
  if (backend.kind === 'sqljs' && backend.sqljs) {
    return jsGet(
      backend.sqljs,
      `SELECT high_water_updated_at, last_sync_at, last_full_sync_at FROM shop_sync WHERE shop_domain = ?`,
      [s]
    );
  }
  if (backend.kind === 'postgres' && backend.pg) {
    const rows = await backend.pg`
      SELECT high_water_updated_at, last_sync_at, last_full_sync_at FROM shop_sync WHERE shop_domain = ${s}
    `;
    return rows[0] || null;
  }
  return null;
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 * @param {{ high_water_updated_at: string | null, last_sync_at: string, last_full_sync_at: string | null }} row
 */
export async function upsertSyncState(backend, shopDomain, row) {
  const s = shopDomain.trim().toLowerCase();
  if (backend.kind === 'sqljs' && backend.sqljs) {
    backend.sqljs.run(
      `INSERT INTO shop_sync (shop_domain, high_water_updated_at, last_sync_at, last_full_sync_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(shop_domain) DO UPDATE SET
         high_water_updated_at = excluded.high_water_updated_at,
         last_sync_at = excluded.last_sync_at,
         last_full_sync_at = COALESCE(excluded.last_full_sync_at, shop_sync.last_full_sync_at)`,
      [s, row.high_water_updated_at, row.last_sync_at, row.last_full_sync_at]
    );
    maybePersist(backend);
    return;
  }
  if (backend.kind === 'postgres' && backend.pg) {
    await backend.pg`
      INSERT INTO shop_sync (shop_domain, high_water_updated_at, last_sync_at, last_full_sync_at)
      VALUES (${s}, ${row.high_water_updated_at}, ${row.last_sync_at}, ${row.last_full_sync_at})
      ON CONFLICT (shop_domain) DO UPDATE SET
        high_water_updated_at = EXCLUDED.high_water_updated_at,
        last_sync_at = EXCLUDED.last_sync_at,
        last_full_sync_at = COALESCE(EXCLUDED.last_full_sync_at, shop_sync.last_full_sync_at)
    `;
  }
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 * @param {any[]} orders
 */
export async function upsertOrders(backend, shopDomain, orders) {
  const s = shopDomain.trim().toLowerCase();
  if (backend.kind === 'sqljs' && backend.sqljs) {
    const db = backend.sqljs;
    db.run('BEGIN');
    try {
      for (const o of orders) {
        const id = Number(o.id);
        const created = String(o.created_at || '');
        const updated = String(o.updated_at || '');
        db.run(
          `INSERT INTO orders_cache (shop_domain, order_id, created_at, updated_at, payload_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(shop_domain, order_id) DO UPDATE SET
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             payload_json = excluded.payload_json`,
          [s, id, created, updated, JSON.stringify(o)]
        );
      }
      db.run('COMMIT');
    } catch (e) {
      db.run('ROLLBACK');
      throw e;
    }
    maybePersist(backend);
    return;
  }
  if (backend.kind === 'postgres' && backend.pg) {
    for (const o of orders) {
      const id = Number(o.id);
      const created = String(o.created_at || '');
      const updated = String(o.updated_at || '');
      await backend.pg`
        INSERT INTO orders_cache (shop_domain, order_id, created_at, updated_at, payload_json)
        VALUES (${s}, ${id}, ${created}, ${updated}, ${JSON.stringify(o)})
        ON CONFLICT (shop_domain, order_id) DO UPDATE SET
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          payload_json = EXCLUDED.payload_json
      `;
    }
  }
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 * @param {number} keepMax
 */
/**
 * Verwijdert gecachte orders ouder dan het ingestelde venster (zelfde grens als `created_at_min` op de API).
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 * @param {string | null | undefined} createdAtMinIso ISO 8601; leeg = geen actie
 */
export async function pruneOrdersOlderThanCreated(backend, shopDomain, createdAtMinIso) {
  const min = String(createdAtMinIso || '').trim();
  if (!min) return;
  const s = shopDomain.trim().toLowerCase();
  if (backend.kind === 'sqljs' && backend.sqljs) {
    backend.sqljs.run(
      `DELETE FROM orders_cache WHERE shop_domain = ? AND datetime(created_at) < datetime(?)`,
      [s, min]
    );
    maybePersist(backend);
    return;
  }
  if (backend.kind === 'postgres' && backend.pg) {
    await backend.pg`
      DELETE FROM orders_cache
      WHERE shop_domain = ${s}
        AND created_at IS NOT NULL
        AND created_at::timestamptz < ${min}::timestamptz
    `;
  }
}

export async function pruneOrdersOverLimit(backend, shopDomain, keepMax) {
  const s = shopDomain.trim().toLowerCase();
  const cap = Math.min(50000, Math.max(1, keepMax));
  if (backend.kind === 'sqljs' && backend.sqljs) {
    backend.sqljs.run(
      `WITH keep AS (
         SELECT order_id FROM orders_cache WHERE shop_domain = ?
         ORDER BY datetime(created_at) DESC LIMIT ?
       )
       DELETE FROM orders_cache WHERE shop_domain = ? AND order_id NOT IN (SELECT order_id FROM keep)`,
      [s, cap, s]
    );
    maybePersist(backend);
    return;
  }
  if (backend.kind === 'postgres' && backend.pg) {
    await backend.pg`
      WITH keep AS (
        SELECT order_id FROM orders_cache WHERE shop_domain = ${s}
        ORDER BY created_at DESC NULLS LAST LIMIT ${cap}
      )
      DELETE FROM orders_cache o
      WHERE o.shop_domain = ${s}
        AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.order_id = o.order_id)
    `;
  }
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql }} backend
 * @param {string} shopDomain
 * @param {number} limit
 * @param {string | null | undefined} [createdAtMinIso] optioneel: alleen orders met created_at >= deze ISO
 */
export async function loadOrdersFromCache(backend, shopDomain, limit, createdAtMinIso) {
  const s = shopDomain.trim().toLowerCase();
  const lim = Math.min(50000, Math.max(1, limit));
  const min = String(createdAtMinIso || '').trim();
  /** @type {any[]} */
  let rows = [];
  if (backend.kind === 'sqljs' && backend.sqljs) {
    if (min) {
      rows = jsAll(
        backend.sqljs,
        `SELECT payload_json FROM orders_cache WHERE shop_domain = ?
         AND datetime(created_at) >= datetime(?)
         ORDER BY datetime(created_at) DESC LIMIT ?`,
        [s, min, lim]
      );
    } else {
      rows = jsAll(
        backend.sqljs,
        `SELECT payload_json FROM orders_cache WHERE shop_domain = ?
         ORDER BY datetime(created_at) DESC LIMIT ?`,
        [s, lim]
      );
    }
  } else if (backend.kind === 'postgres' && backend.pg) {
    if (min) {
      rows = await backend.pg`
        SELECT payload_json FROM orders_cache
        WHERE shop_domain = ${s}
          AND created_at IS NOT NULL
          AND created_at::timestamptz >= ${min}::timestamptz
        ORDER BY created_at DESC NULLS LAST
        LIMIT ${lim}
      `;
    } else {
      rows = await backend.pg`
        SELECT payload_json FROM orders_cache WHERE shop_domain = ${s}
        ORDER BY created_at DESC NULLS LAST LIMIT ${lim}
      `;
    }
  }
  return rows
    .map((r) => {
      try {
        const raw = r.payload_json;
        if (raw != null && typeof raw === 'object') return raw;
        return JSON.parse(String(raw ?? ''));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql }} backend
 * @param {string} shopDomain
 */
export async function countOrdersInCache(backend, shopDomain) {
  const s = shopDomain.trim().toLowerCase();
  if (backend.kind === 'sqljs' && backend.sqljs) {
    const r = jsGet(backend.sqljs, `SELECT COUNT(*) AS c FROM orders_cache WHERE shop_domain = ?`, [s]);
    return Number(r?.c || 0);
  }
  if (backend.kind === 'postgres' && backend.pg) {
    const r = await backend.pg`SELECT COUNT(*)::int AS c FROM orders_cache WHERE shop_domain = ${s}`;
    return Number(r[0]?.c || 0);
  }
  return 0;
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql }} backend
 * @param {string} shopDomain
 * @param {number} productId
 */
export async function getProductCacheRow(backend, shopDomain, productId) {
  const s = shopDomain.trim().toLowerCase();
  const pid = Math.floor(Number(productId));
  if (backend.kind === 'sqljs' && backend.sqljs) {
    return jsGet(
      backend.sqljs,
      `SELECT product_id, handle, image_map_json, production_json, fetched_at FROM product_cache
       WHERE shop_domain = ? AND product_id = ?`,
      [s, pid]
    );
  }
  if (backend.kind === 'postgres' && backend.pg) {
    const rows = await backend.pg`
      SELECT product_id, handle, image_map_json, production_json, fetched_at FROM product_cache
      WHERE shop_domain = ${s} AND product_id = ${pid}
    `;
    return rows[0] || null;
  }
  return null;
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 * @param {number} productId
 * @param {{ handle: string | null, imageMap: Record<string, string | null>, production: object | null }} data
 */
export async function upsertProductCache(backend, shopDomain, productId, data) {
  const s = shopDomain.trim().toLowerCase();
  const pid = Math.floor(Number(productId));
  const now = new Date().toISOString();
  const imgJson = JSON.stringify(data.imageMap || {});
  const prodJson = data.production ? JSON.stringify(data.production) : null;
  if (backend.kind === 'sqljs' && backend.sqljs) {
    backend.sqljs.run(
      `INSERT INTO product_cache (shop_domain, product_id, handle, image_map_json, production_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_domain, product_id) DO UPDATE SET
         handle = excluded.handle,
         image_map_json = excluded.image_map_json,
         production_json = excluded.production_json,
         fetched_at = excluded.fetched_at`,
      [s, pid, data.handle || null, imgJson, prodJson, now]
    );
    maybePersist(backend);
    return;
  }
  if (backend.kind === 'postgres' && backend.pg) {
    await backend.pg`
      INSERT INTO product_cache (shop_domain, product_id, handle, image_map_json, production_json, fetched_at)
      VALUES (${s}, ${pid}, ${data.handle || null}, ${imgJson}, ${prodJson}, ${now})
      ON CONFLICT (shop_domain, product_id) DO UPDATE SET
        handle = EXCLUDED.handle,
        image_map_json = EXCLUDED.image_map_json,
        production_json = EXCLUDED.production_json,
        fetched_at = EXCLUDED.fetched_at
    `;
  }
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql }} backend
 * @param {string} shopDomain
 * @param {number} orderId
 */
export async function getMailCacheRow(backend, shopDomain, orderId) {
  const s = shopDomain.trim().toLowerCase();
  const oid = Math.floor(Number(orderId));
  if (backend.kind === 'sqljs' && backend.sqljs) {
    return jsGet(
      backend.sqljs,
      `SELECT order_updated_at, events_json, fetched_at FROM order_mail_cache
       WHERE shop_domain = ? AND order_id = ?`,
      [s, oid]
    );
  }
  if (backend.kind === 'postgres' && backend.pg) {
    const rows = await backend.pg`
      SELECT order_updated_at, events_json, fetched_at FROM order_mail_cache
      WHERE shop_domain = ${s} AND order_id = ${oid}
    `;
    return rows[0] || null;
  }
  return null;
}

const BATCH_IN_MAX = 400;

/**
 * Eén (of weinig) queries i.p.v. per order — scheelt seconden bij groot overzicht.
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql }} backend
 * @param {string} shopDomain
 * @param {(string|number)[]} orderIds
 * @returns {Promise<Map<string, { order_updated_at?: string; events_json?: string; fetched_at?: string; order_id?: number }>>}
 */
export async function getMailCacheRowsBatch(backend, shopDomain, orderIds) {
  const s = shopDomain.trim().toLowerCase();
  const ids = [
    ...new Set(
      orderIds
        .map((x) => Math.floor(Number(x)))
        .filter((x) => Number.isFinite(x) && x > 0)
    ),
  ];
  /** @type {Map<string, { order_updated_at?: string; events_json?: string; fetched_at?: string; order_id?: number }>} */
  const map = new Map();
  if (!ids.length) return map;

  if (backend.kind === 'sqljs' && backend.sqljs) {
    const db = backend.sqljs;
    for (let i = 0; i < ids.length; i += BATCH_IN_MAX) {
      const chunk = ids.slice(i, i + BATCH_IN_MAX);
      const ph = chunk.map(() => '?').join(',');
      const rows = jsAll(
        db,
        `SELECT order_id, order_updated_at, events_json, fetched_at FROM order_mail_cache
         WHERE shop_domain = ? AND order_id IN (${ph})`,
        [s, ...chunk]
      );
      for (const r of rows) {
        const oid = r.order_id != null ? String(r.order_id) : '';
        if (oid) map.set(oid, r);
      }
    }
    return map;
  }

  if (backend.kind === 'postgres' && backend.pg) {
    const sql = backend.pg;
    for (let i = 0; i < ids.length; i += BATCH_IN_MAX) {
      const chunk = ids.slice(i, i + BATCH_IN_MAX);
      const rows = await sql`
        SELECT order_id, order_updated_at, events_json, fetched_at FROM order_mail_cache
        WHERE shop_domain = ${s} AND order_id IN ${sql(chunk)}
      `;
      for (const r of rows) {
        const oid = r.order_id != null ? String(r.order_id) : '';
        if (oid) map.set(oid, r);
      }
    }
    return map;
  }

  return map;
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql }} backend
 * @param {string} shopDomain
 * @param {number[]} productIds
 * @returns {Promise<Map<number, { product_id?: number; handle?: string; image_map_json?: string; production_json?: string; fetched_at?: string }>>}
 */
export async function getProductCacheRowsBatch(backend, shopDomain, productIds) {
  const s = shopDomain.trim().toLowerCase();
  const ids = [
    ...new Set(
      productIds.map((x) => Math.floor(Number(x))).filter((x) => Number.isFinite(x) && x > 0)
    ),
  ];
  /** @type {Map<number, { product_id?: number; handle?: string; image_map_json?: string; production_json?: string; fetched_at?: string }>} */
  const map = new Map();
  if (!ids.length) return map;

  if (backend.kind === 'sqljs' && backend.sqljs) {
    const db = backend.sqljs;
    for (let i = 0; i < ids.length; i += BATCH_IN_MAX) {
      const chunk = ids.slice(i, i + BATCH_IN_MAX);
      const ph = chunk.map(() => '?').join(',');
      const rows = jsAll(
        db,
        `SELECT product_id, handle, image_map_json, production_json, fetched_at FROM product_cache
         WHERE shop_domain = ? AND product_id IN (${ph})`,
        [s, ...chunk]
      );
      for (const r of rows) {
        const pid = r.product_id != null ? Number(r.product_id) : NaN;
        if (Number.isFinite(pid)) map.set(pid, r);
      }
    }
    return map;
  }

  if (backend.kind === 'postgres' && backend.pg) {
    const sql = backend.pg;
    for (let i = 0; i < ids.length; i += BATCH_IN_MAX) {
      const chunk = ids.slice(i, i + BATCH_IN_MAX);
      const rows = await sql`
        SELECT product_id, handle, image_map_json, production_json, fetched_at FROM product_cache
        WHERE shop_domain = ${s} AND product_id IN ${sql(chunk)}
      `;
      for (const r of rows) {
        const pid = r.product_id != null ? Number(r.product_id) : NaN;
        if (Number.isFinite(pid)) map.set(pid, r);
      }
    }
    return map;
  }

  return map;
}

/**
 * @param {{ kind: string, sqljs?: import('sql.js').Database, pg?: import('postgres').Sql, persist?: () => void }} backend
 * @param {string} shopDomain
 * @param {number} orderId
 * @param {string} orderUpdatedAt
 * @param {unknown} events
 */
export async function upsertMailCache(backend, shopDomain, orderId, orderUpdatedAt, events) {
  const s = shopDomain.trim().toLowerCase();
  const oid = Math.floor(Number(orderId));
  const now = new Date().toISOString();
  const evJson = JSON.stringify(events ?? []);
  if (backend.kind === 'sqljs' && backend.sqljs) {
    backend.sqljs.run(
      `INSERT INTO order_mail_cache (shop_domain, order_id, order_updated_at, events_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(shop_domain, order_id) DO UPDATE SET
         order_updated_at = excluded.order_updated_at,
         events_json = excluded.events_json,
         fetched_at = excluded.fetched_at`,
      [s, oid, orderUpdatedAt, evJson, now]
    );
    maybePersist(backend);
    return;
  }
  if (backend.kind === 'postgres' && backend.pg) {
    await backend.pg`
      INSERT INTO order_mail_cache (shop_domain, order_id, order_updated_at, events_json, fetched_at)
      VALUES (${s}, ${oid}, ${orderUpdatedAt}, ${evJson}, ${now})
      ON CONFLICT (shop_domain, order_id) DO UPDATE SET
        order_updated_at = EXCLUDED.order_updated_at,
        events_json = EXCLUDED.events_json,
        fetched_at = EXCLUDED.fetched_at
    `;
  }
}
