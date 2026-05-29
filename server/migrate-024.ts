import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { query } from './src/db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sql = readFileSync(
  path.join(__dirname, 'src/db/migrations/024_billing_lemonsqueezy.sql'),
  'utf-8'
);

try {
  await query(sql);
  console.log('✅ Migration 024 (Lemon Squeezy columns) applied');
} catch (err) {
  console.error('❌ Migration 024 failed:', err);
  process.exit(1);
}
process.exit(0);
