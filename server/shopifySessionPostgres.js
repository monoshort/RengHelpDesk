/**
 * Gedeelde Shopify OAuth-sessie over alle Node-instances via Postgres (zelfde DATABASE_URL als order-cache).
 * Zet SHOPIFY_SESSION_STORE=file om uitsluitend .shopify_token.json te blijven gebruiken.
 */

/** @type {import('postgres').Sql | null} */
let sql = null;
let tableEnsured = false;

/**
 * @param {() => Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
async function withTransientRetry(fn) {
  const max = 4;
  let last;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const err = /** @type {NodeJS.ErrnoException & { code?: string }} */ (e);
      const code = err?.code || '';
      const msg = String(err?.message || e || '');
      const transient =
        ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', '57P01', '08006', '08003'].includes(
          String(code)
        ) ||
        /timeout|connection terminated|connection.*closed|server closed the connection|econnrefused|admin_shutdown|db_.*shutdown/i.test(
          msg
        );
      if (!transient || i === max - 1) {
        if (transient) sql = null;
        throw e;
      }
      sql = null;
      await new Promise((r) => setTimeout(r, 180 * (i + 1) + Math.random() * 120));
    }
  }
  throw last;
}

export function postgresShopifySessionEnabled() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return false;
  const mode = String(process.env.SHOPIFY_SESSION_STORE || '').toLowerCase();
  if (mode === 'file') return false;
  return true;
}

async function getSql() {
  if (!sql) {
    const postgres = (await import('postgres')).default;
    sql = postgres(process.env.DATABASE_URL.trim(), {
      max: 2,
      idle_timeout: 25,
      connect_timeout: 12,
    });
  }
  return sql;
}

async function ensureTable(pg) {
  if (tableEnsured) return;
  await pg.unsafe(`
    CREATE TABLE IF NOT EXISTS reng_shopify_oauth (
      shop text PRIMARY KEY,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  tableEnsured = true;
}

/**
 * @param {string} shopKey genormaliseerd myshopify-domein of leeg → nieuwste rij
 * @returns {Promise<Record<string, unknown> | null>} ruwe doc zoals in .json (shop, access_token, …)
 */
export async function pgLoadShopifySessionDoc(shopKey) {
  if (!postgresShopifySessionEnabled()) return null;
  return withTransientRetry(async () => {
    const pg = await getSql();
    await ensureTable(pg);
    const key = String(shopKey || '').trim().toLowerCase();
    /** @type {{ shop: string; payload: unknown }[]} */
    let rows;
    if (key) {
      rows = await pg`
        select shop, payload from reng_shopify_oauth where shop = ${key} limit 1
      `;
    } else {
      rows = await pg`
        select shop, payload from reng_shopify_oauth order by updated_at desc limit 1
      `;
    }
    if (!rows?.length) return null;
    const p = rows[0].payload;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return /** @type {Record<string, unknown>} */ ({ ...p });
    }
    return null;
  });
}

/**
 * @param {Record<string, unknown>} doc volledige sessie-json (shop, access_token, …)
 */
export async function pgSaveShopifySessionDoc(doc) {
  if (!postgresShopifySessionEnabled()) return;
  const shop = String(doc.shop || '').trim().toLowerCase();
  if (!shop) throw new Error('pgSaveShopifySessionDoc: shop ontbreekt in document.');
  await withTransientRetry(async () => {
    const pg = await getSql();
    await ensureTable(pg);
    const json = JSON.stringify(doc);
    await pg.unsafe(
      `insert into reng_shopify_oauth (shop, payload, updated_at) values ($1, $2::jsonb, now())
       on conflict (shop) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
      [shop, json]
    );
  });
}
