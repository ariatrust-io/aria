import 'dotenv/config';
import { query } from './src/db/pool.js';
import { readFileSync } from 'fs';

const sql = readFileSync('./src/db/migrations/013_gate.sql', 'utf8');
await query(sql);
console.log('Migration 013 complete');
process.exit(0);
