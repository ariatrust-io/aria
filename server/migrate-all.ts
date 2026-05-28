import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { query } from './src/db/pool.js';

const runAllMigrations = async () => {
  console.log('Running schema.sql first...');
  const schemaSql = readFileSync(join('./src/db/schema.sql'), 'utf8');
  await query(schemaSql);
  console.log('✓ schema.sql applied');

  const migrationsDir = join('./src/db/migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    console.log(`Applying ${file}...`);
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await query(sql);
    console.log(`✓ ${file} applied`);
  }
  console.log('All migrations successfully applied!');
  process.exit(0);
};

runAllMigrations().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
