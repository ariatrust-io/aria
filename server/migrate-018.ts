import 'dotenv/config';
import { query } from './src/db/pool.js';
import { readFileSync } from 'fs';

const sql = readFileSync('./src/db/migrations/018_admin.sql', 'utf8');
await query(sql);
console.log('Migration 018 complete');
process.exit(0);
