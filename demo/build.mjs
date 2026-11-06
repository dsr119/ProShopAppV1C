// Rebuilds the demo pages from app/.
//
//   node demo/build.mjs
//
// Each app page is copied into demo/ with three changes:
//   - config.js is dropped (no Supabase URL or key in the demo)
//   - db.js is replaced by demo-db.js (in-memory sample data, no network)
//   - other scripts and stylesheets load from ../app/, so the demo always runs
//     the same code as the real app
// Links between pages stay relative, so they open the demo copies.

import { readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..", "app");

let pages = 0;
for (const name of readdirSync(app).filter(f => f.endsWith(".html"))) {
  let html = readFileSync(join(app, name), "utf8");
  html = html
    .replace(/<script src="config\.js[^"]*"><\/script>\s*/g, "")
    .replace(/src="db\.js[^"]*"/g, 'src="demo-db.js"')
    .replace(/(src|href)="(?!https?:|\/|#|\.\.\/|demo-db)([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g, '$1="../app/$2"')
    .replace("<head>", '<head>\n  <meta name="robots" content="noindex">');
  if (/config\.js|[^-]db\.js/.test(html.replace("demo-db.js", ""))) {
    throw new Error(`${name}: still references config.js or db.js`);
  }
  writeFileSync(join(here, name), html);
  pages++;
}
copyFileSync(join(app, "patch-notes.json"), join(here, "patch-notes.json"));
console.log(`demo: wrote ${pages} pages`);
