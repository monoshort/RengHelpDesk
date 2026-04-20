import {
  fetchAllRecentOrders,
  fetchOrdersUpdatedSince,
  fetchProductThumbnailData,
  fetchMailLogsForOrderIds,
  shopifyOrdersCreatedAtMinIso,
} from './shopify.js';
import {
  getCacheBackend,
  getSyncState,
  upsertSyncState,
  upsertOrders,
  pruneOrdersOverLimit,
  pruneOrdersOlderThanCreated,
  loadOrdersFromCache,
  countOrdersInCache,
  upsertProductCache,
  getMailCacheRowsBatch,
  getProductCacheRowsBatch,
  upsertMailCache,
} from './cache/overviewStore.js';

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function maxUpdatedAtFromOrders(orders) {
  let m = null;
  for (const o of orders) {
    const u = o?.updated_at ? String(o.updated_at) : null;
    m = maxIso(m, u);
  }
  return m;
}

function isoMinusMinutes(iso, mins) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date(0).toISOString();
  d.setMinutes(d.getMinutes() - mins);
  return d.toISOString();
}

function collectProductIds(orders) {
  const ids = new Set();
  for (const o of orders) {
    for (const li of o.line_items || []) {
      if (li.product_id != null) ids.add(Number(li.product_id));
    }
  }
  return [...ids];
}

function filterImageMapForProduct(imageMap, pid) {
  const out = {};
  const p = String(pid);
  const prefix = `${p}:`;
  for (const k of Object.keys(imageMap || {})) {
    if (k === `${p}:` || k.startsWith(prefix)) out[k] = imageMap[k];
  }
  return out;
}

export async function buildCachedThumbData(backend, cfg, shopDomain, orders, { loadImages, storeBaseUrl }) {
  if (backend.kind === 'none' || !loadImages) {
    return await fetchProductThumbnailData(cfg, orders, {
      loadImages,
      storefrontBaseUrl: storeBaseUrl,
    });
  }

  const ttlMs =
    Number(process.env.PRODUCT_CACHE_TTL_MS || '') || 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const productIds = collectProductIds(orders);
  /** @type {Record<string, string | null>} */
  const imageMap = {};
  /** @type {Record<string, string>} */
  const handles = {};
  /** @type {Record<string, { hint: string; workingDays: number | null }>} */
  const productionByProductId = {};
  /** @type {Set<number>} */
  const missing = new Set();

  const productRowMap = await getProductCacheRowsBatch(backend, shopDomain, productIds);

  for (const pid of productIds) {
    const row = productRowMap.get(pid);
    let ok = false;
    if (row?.fetched_at) {
      const age = now - new Date(row.fetched_at).getTime();
      if (age < ttlMs && row.image_map_json) {
        try {
          const im = JSON.parse(row.image_map_json);
          Object.assign(imageMap, im);
          if (row.handle) handles[String(pid)] = row.handle;
          if (row.production_json) {
            const pr = JSON.parse(row.production_json);
            productionByProductId[String(pid)] = pr;
          }
          ok = true;
        } catch {
          ok = false;
        }
      }
    }
    if (!ok) missing.add(pid);
  }

  if (missing.size === 0) {
    return { imageMap, handles, productionByProductId };
  }

  const fetched = await fetchProductThumbnailData(cfg, orders, {
    loadImages: true,
    storefrontBaseUrl: storeBaseUrl,
    onlyProductIds: missing,
  });

  Object.assign(imageMap, fetched.imageMap || {});
  Object.assign(handles, fetched.handles || {});
  Object.assign(productionByProductId, fetched.productionByProductId || {});

  for (const pid of missing) {
    await upsertProductCache(backend, shopDomain, pid, {
      handle: handles[String(pid)] || null,
      imageMap: filterImageMapForProduct(imageMap, pid),
      production: productionByProductId[String(pid)] || null,
    });
  }

  return { imageMap, handles, productionByProductId };
}

export async function buildCachedMailLogs(backend, cfg, shopDomain, orders, includeMailLog) {
  if (!includeMailLog) return {};
  if (backend.kind === 'none') {
    const ids = orders.map((o) => o.id);
    return fetchMailLogsForOrderIds(cfg, ids);
  }

  const ttlMs =
    Number(process.env.MAIL_CACHE_TTL_MS || '') || 6 * 60 * 60 * 1000;
  const now = Date.now();
  /** @type {Record<string, any[]>} */
  const out = {};
  /** @type {string[]} */
  const needFetch = [];

  const mailRowMap = await getMailCacheRowsBatch(backend, shopDomain, orders.map((o) => o.id));

  for (const o of orders) {
    const id = String(o.id);
    const ou = String(o.updated_at || '');
    const row = mailRowMap.get(id);
    let hit = false;
    if (row?.events_json && row.order_updated_at === ou) {
      const age = now - new Date(row.fetched_at).getTime();
      if (age < ttlMs) {
        try {
          out[id] = JSON.parse(row.events_json);
          hit = true;
        } catch {
          hit = false;
        }
      }
    }
    if (!hit) needFetch.push(id);
  }

  if (needFetch.length) {
    const fresh = await fetchMailLogsForOrderIds(cfg, needFetch);
    for (const sid of needFetch) {
      const ev = fresh[sid] || [];
      out[sid] = ev;
      const order = orders.find((x) => String(x.id) === sid);
      const ou = order ? String(order.updated_at || '') : '';
      await upsertMailCache(backend, shopDomain, Number(sid), ou, ev);
    }
  }

  return out;
}

/**
 * Orders + sync-meta ophalen (cache of live).
 * @returns {Promise<{
 *   orders: any[],
 *   ordersCfg: { shopDomain: string, accessToken: string },
 *   cacheMode: 'off'|'full'|'incremental',
 *   cacheDeltaCount: number|null,
 *   cacheOrderCount: number|null,
 * }>}
 */
export async function resolveOrdersForOverview(cfg, shopDomain, {
  cap,
  fullSync,
  explicitOrderLimit,
}) {
  const createdMinIso = shopifyOrdersCreatedAtMinIso();
  const backend = await getCacheBackend();

  if (explicitOrderLimit) {
    const { fetchRecentOrders } = await import('./shopify.js');
    const lim = Math.min(250, Math.max(1, Number(explicitOrderLimit) || 40));
    const orders = await fetchRecentOrders(cfg, { limit: lim });
    return {
      orders,
      ordersCfg: cfg,
      cacheMode: 'off',
      cacheDeltaCount: null,
      cacheOrderCount: null,
      backend,
    };
  }

  if (backend.kind === 'none') {
    const orders = await fetchAllRecentOrders(cfg, {
      maxOrders: cap,
      pageSize: 250,
      ...(createdMinIso ? { createdAtMinIso: createdMinIso } : {}),
    });
    return {
      orders,
      ordersCfg: cfg,
      cacheMode: 'off',
      cacheDeltaCount: null,
      cacheOrderCount: null,
      backend,
    };
  }

  const s = shopDomain.trim().toLowerCase();
  await pruneOrdersOlderThanCreated(backend, s, createdMinIso);
  const overlapMin = Math.min(
    120,
    Math.max(1, Number(process.env.SYNC_OVERLAP_MINUTES || '') || 3)
  );

  const count = await countOrdersInCache(backend, s);
  const state = await getSyncState(backend, s);
  const needFull = fullSync || count === 0 || !state?.high_water_updated_at;

  if (needFull) {
    const orders = await fetchAllRecentOrders(cfg, {
      maxOrders: cap,
      pageSize: 250,
      ...(createdMinIso ? { createdAtMinIso: createdMinIso } : {}),
    });
    await upsertOrders(backend, s, orders);
    await pruneOrdersOverLimit(backend, s, cap);
    await pruneOrdersOlderThanCreated(backend, s, createdMinIso);
    const loaded = await loadOrdersFromCache(backend, s, cap, createdMinIso);
    const hw = maxUpdatedAtFromOrders(orders);
    const now = new Date().toISOString();
    await upsertSyncState(backend, s, {
      high_water_updated_at: hw,
      last_sync_at: now,
      last_full_sync_at: now,
    });
    return {
      orders: loaded,
      ordersCfg: cfg,
      cacheMode: 'full',
      cacheDeltaCount: orders.length,
      cacheOrderCount: loaded.length,
      backend,
    };
  }

  const minIso = isoMinusMinutes(state.high_water_updated_at, overlapMin);
  const deltas = await fetchOrdersUpdatedSince(cfg, {
    updatedAtMinIso: minIso,
    maxOrders: 10000,
    pageSize: 250,
    ...(createdMinIso ? { createdAtMinIso: createdMinIso } : {}),
  });
  if (deltas.length) {
    await upsertOrders(backend, s, deltas);
    await pruneOrdersOverLimit(backend, s, cap);
    await pruneOrdersOlderThanCreated(backend, s, createdMinIso);
  }
  const loaded = await loadOrdersFromCache(backend, s, cap, createdMinIso);
  const newHw = maxIso(state.high_water_updated_at, maxUpdatedAtFromOrders(deltas));
  const now = new Date().toISOString();
  await upsertSyncState(backend, s, {
    high_water_updated_at: newHw || state.high_water_updated_at,
    last_sync_at: now,
    last_full_sync_at: state.last_full_sync_at || null,
  });

  return {
    orders: loaded,
    ordersCfg: cfg,
    cacheMode: 'incremental',
    cacheDeltaCount: deltas.length,
    cacheOrderCount: loaded.length,
    backend,
  };
}
