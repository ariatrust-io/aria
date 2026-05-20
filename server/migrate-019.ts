import 'dotenv/config';
import { query } from './src/db/pool.js';
import { readFileSync } from 'fs';

const sql = readFileSync('./src/db/migrations/019_password_reset.sql', 'utf8');
await query(sql);
console.log('Migration 019 complete');
process.exit(0);
