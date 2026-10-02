#!/usr/bin/env node
/**
 * One-time import of the "Proshop Ball Sheet" into Supabase.
 *
 *   python3 export-sheet.py "Proshop Ball Sheet.xlsx" > sheet.json
 *   node import-sheet.mjs sheet.json > import.sql
 *
 * Runs the sheet's "Bowling Balls" tab through the same loadProductStore_ the
 * scraper uses (dedupe, condition-listing filter, column cleanup), so the
 * first scraper run finds the rows exactly as it would have found the sheet.
 * Prints SQL to paste into the Supabase SQL editor.
 */

import fs from 'fs';
import { loadProductStore_, BOWLING_SCRAPER_HEADERS } from './rules.mjs';
import { sheetRowsToDbRows, valuesSheet } from './catalog.mjs';

const sheet = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const store = loadProductStore_(valuesSheet([BOWLING_SCRAPER_HEADERS].concat(sheet.balls)));
const balls = sheetRowsToDbRows(store.rows, [], new Date().toISOString());

const quote = (json) => '$json$' + JSON.stringify(json) + '$json$';
const columns = Object.keys(balls[0]).join(', ');

console.log(`-- ${balls.length} balls, ${balls.filter((b) => b.is_recent_release).length} recent releases, ${sheet.staff.length} staff bags`);
console.log(`insert into public.balls (${columns})
select ${columns} from jsonb_populate_recordset(null::public.balls, ${quote(balls)}::jsonb)
on conflict (match_key) do nothing;`);
console.log(`insert into public.staff_bags (staff_member, sort_order, balls)
select staff_member, sort_order, balls from jsonb_populate_recordset(null::public.staff_bags, ${quote(sheet.staff)}::jsonb)
on conflict (staff_member) do nothing;`);
