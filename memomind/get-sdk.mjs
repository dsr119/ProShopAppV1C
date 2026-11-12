// Copies the two MemoMind SDK files the apps build with into common/vendor/.
// They come with the MemoMind SDK under its own terms, so they're not kept in
// this repo. Run once (and again after updating the SDK):
//   node memomind/get-sdk.mjs
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sdkRoot } from "./sdk-path.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(sdkRoot(), "PhoneSDK/examples/talking-pet/vendor");
const to = resolve(here, "common/vendor");
mkdirSync(to, { recursive: true });
for (const f of ["gm-plugin-web-sdk.esm.js", "opus-decoder.esm.js", "opus-decoder-LICENSE.txt"]) {
  copyFileSync(resolve(from, f), resolve(to, f));
  console.log(`copied ${f}`);
}
