#!/usr/bin/env node
/**
 * Weekly backup: every table the shop depends on, one CSV each, written to
 * the directory given as the first argument. The workflow then encrypts the
 * folder and keeps it as a GitHub Actions artifact.
 *
 * Replaces apps-script/weekly-backup.gs, which wrote the same CSVs to Google
 * Drive. Same rules: page past PostgREST's 1000-row cap, take the union of
 * columns, and refuse to write a backup when a table that should have rows
 * comes back empty.
 */

import fs from 'fs';
import path from 'path';
import { selectAll } from './supabase.mjs';

// [table, column to page in a stable order, must it have rows?]
const TABLES = [
  ['orders', 'id', true],
  ['appointments', 'id', true],
  ['items', 'item', true],
  ['customer_directory', 'id', true],
  ['hours', 'id', false],
  ['staff', 'id', false],
  ['tickets', 'id', false],
  ['balls', 'id', true],
  ['staff_bags', 'staff_member', false],
];

function escape(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); columns.push(key); }
  return [columns.join(',')].concat(rows.map((row) => columns.map((c) => escape(row[c])).join(','))).join('\n') + '\n';
}

const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node backup.mjs <output-dir>');
fs.mkdirSync(outDir, { recursive: true });

for (const [table, order, required] of TABLES) {
  const rows = await selectAll(table, order);
  if (required && !rows.length) {
    throw new Error(`${table} came back empty; refusing to write a backup that looks complete but is not.`);
  }
  fs.writeFileSync(path.join(outDir, `${table}.csv`), toCsv(rows));
  console.log(`${table}: ${rows.length} rows`);
}
