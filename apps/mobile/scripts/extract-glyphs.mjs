// Retained command name for compatibility. The symbol is now custom geometry, not glyphs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { centeredMark, svg } from "../../../scripts/brand-art.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SHELLBELL_BRAND_OUT ?? join(here, "../assets/brand");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "lockup.svg"), svg("Shellbell terminal attention mark", centeredMark()));
writeFileSync(
  join(out, "monogram.svg"),
  svg("Shellbell small optical mark", centeredMark(undefined, 750, true)),
);
