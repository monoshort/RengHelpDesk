#!/usr/bin/env node
/**
 * Maakt Postgres-tabellen aan voor RengHelpDesk (eenmalig na nieuwe DATABASE_URL).
 * Gebruik: node scripts/setup-postgres.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCacheBackend } from '../server/cache/overviewStore.js';
import { ensurePlatformConfigLoaded } from '../server/platformConfigStore.js';
import { pgLoadShopifySessionDoc } from '../server/shopifySessionPostgres.js';
import { loadUserIntegrationDoc } from '../server/userIntegrationsStore.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL ontbreekt in .env');
  process.exit(1);
}

try {
  const backend = await getCacheBackend();
  if (backend.kind !== 'postgres') {
    throw new Error('Kon geen Postgres-cache openen — controleer DATABASE_URL');
  }
  console.log('OK order-/product-cache (shop_sync, orders_cache, …)');

  await ensurePlatformConfigLoaded();
  console.log('OK reng_platform_config');

  await pgLoadShopifySessionDoc('');
  console.log('OK reng_shopify_oauth');

  await loadUserIntegrationDoc('0'.repeat(48), 'settings');
  console.log('OK reng_user_integrations');

  if (backend.pg) await backend.pg.end({ timeout: 5 });
  console.log('Postgres-schema klaar.');
} catch (e) {
  console.error('Setup mislukt:', e instanceof Error ? e.message : e);
  process.exit(1);
}
