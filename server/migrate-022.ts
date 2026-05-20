import 'dotenv/config';
import { query } from './src/db/pool.js';
import { readFileSync } from 'fs';

const sql = readFileSync('./src/db/migrations/022_blocked_outcome.sql', 'utf8');
await query(sql);
console.log('Migration 022 complete');
process.exit(0);
