// Packs a built app (its dist/ folder) into an .mmpkg the MemoMind app
// installs, with the SDK's own packager (it checks the manifest and hashes
// every file).
//   node ../pack.mjs dist ../release/edith-0.1.0.mmpkg
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sdkRoot } from "./sdk-path.mjs";

const [input, output] = process.argv.slice(2).map((p) => resolve(p));
if (!input || !output) { console.error("usage: node pack.mjs <dist> <out.mmpkg>"); process.exit(1); }
mkdirSync(dirname(output), { recursive: true });
const tool = resolve(sdkRoot(), "PhoneSDK/tools/build-mmpkg.mjs");
const r = spawnSync(process.execPath, [tool, input, output], { stdio: "inherit" });
process.exit(r.status ?? 1);
