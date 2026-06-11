import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { query } from './src/db/pool.js';

/**
 * Idempotent bootstrap migration runner for self-hosted (Docker Compose) setups.
 *
 * The migrate service runs on every `docker compose up`, but schema.sql and
 * several migrations use plain CREATE TABLE / ADD COLUMN (no IF NOT EXISTS),
 * so re-applying them against an already-initialized database errors out.
 *
 * Strategy: detect a sentinel table (`api_keys`, created by schema.sql). If it
 * is absent the database is fresh — apply schema.sql then every migration in
 * order. If it is present, assume the database is already initialized and skip.
 *
 * This handles the fresh-vs-initialized case, which is what self-hosting needs.
 * It does not track or apply migrations incrementally onto an older schema;
 * that would be a follow-up if self-hosters ever need to upgrade in place.
 */

async function alreadyInitialized(): Promise<boolean> {
  const res = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'api_keys'
     ) AS exists`
  );
  return res.rows[0]?.exists === true;
}

async function main(): Promise<void> {
  if (await alreadyInitialized()) {
    console.log('[migrate] Schema already present — database initialized, skipping.');
    process.exit(0);
  }

  console.log('[migrate] Fresh database — applying schema.sql...');
  const schemaSql = readFileSync(join('./src/db/schema.sql'), 'utf8');
  await query(schemaSql);
  console.log('[migrate] ✓ schema.sql');

  const migrationsDir = join('./src/db/migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await query(sql);
    console.log(`[migrate] ✓ ${file}`);
  }

  console.log('[migrate] All migrations applied. Database ready.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[migrate] Failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
