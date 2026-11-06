# Demo

A clickable copy of the ProShop App that runs on made-up sample data:
**https://dsr119.github.io/ProShopAppV1C/demo/**

It is the real app. The pages here load the same scripts and styles from
`app/`, with one swap: `demo-db.js` stands in for `app/db.js` and
`app/config.js` is not loaded. `demo-db.js` keeps every table in memory and
answers the same PostgREST-style queries (filters, `or`/`and`, ordering), so
nothing in the demo reaches Supabase or any other backend. Edits work for the
session and reset on refresh. Names are fake and phone numbers are in the
reserved 555-01xx range.

After changing a page in `app/`, rebuild the demo copies:

```bash
node demo/build.mjs
```
