import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const name of ["vectors.json", "notification-vectors.json"]) {
  const src = resolve(here, "../../../packages/protocol/test", name);
  const dest = resolve(here, "../src/util", name);
  const wanted = readFileSync(src, "utf8");
  if (process.argv.includes("--check")) {
    const have = readFileSync(dest, "utf8");
    if (have !== wanted) {
      console.error(`src/util/${name} is stale; run: pnpm -F @shellbell/mobile sync:vectors`);
      process.exit(1);
    }
  } else {
    writeFileSync(dest, wanted);
  }
}
