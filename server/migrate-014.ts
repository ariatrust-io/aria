import 'dotenv/config';
import { query } from './src/db/pool.js';
import { readFileSync } from 'fs';

const sql = readFileSync('./src/db/migrations/014_spectrum.sql', 'utf8');
await query(sql);
console.log('Migration 014 complete');
process.exit(0);
