// Where the MemoMind SDK (Plugin Open Platform) is. By default it sits next
// to this repo, as on Doug's desktop:
//   Desktop/ProShopAppV1C-main/   (this repo)
//   Desktop/plugin-open-platform-main/
// Set MEMOMIND_SDK to its folder if it lives somewhere else.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function sdkRoot() {
  const root = resolve(process.env.MEMOMIND_SDK || resolve(here, "../../plugin-open-platform-main"));
  if (!existsSync(resolve(root, "PhoneSDK"))) {
    console.error(`Can't find the MemoMind SDK at ${root}.\nSet MEMOMIND_SDK to the plugin-open-platform-main folder.`);
    process.exit(1);
  }
  return root;
}
