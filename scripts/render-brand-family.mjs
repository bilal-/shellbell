// Renders the committed brand/svg/*.svg logo family to brand/png/*@1x.png and *@2x.png. Mirrors
// apps/mobile/scripts/render-brand.mjs's sharp/SVG pattern, but simpler: every raster here is the
// mark on a fully transparent canvas at a fixed height, aspect ratio preserved -- there is no tile,
// no gradient and no flattening, because these files are for the website, README and press, not an
// app icon that a store would letterbox.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SVG_DIR = join(here, "../brand/svg");
const PNG_DIR = join(here, "../brand/png");

// @1x / @2x at fixed heights (spec: 128px / 256px); width follows from each SVG's own aspect
// ratio, so sharp's resize takes only `height` and lets width scale to match -- no cropping, no
// distortion.
const SCALES = [
  ["1x", 128],
  ["2x", 256],
];

mkdirSync(PNG_DIR, { recursive: true });

const files = readdirSync(SVG_DIR)
  .filter((f) => f.endsWith(".svg"))
  .sort();

for (const file of files) {
  const name = basename(file, ".svg");
  const svg = readFileSync(join(SVG_DIR, file));
  for (const [suffix, height] of SCALES) {
    // No `background` option -- the source SVG has no background rect, so sharp rasterises it
    // onto a transparent canvas by default. Composited into nothing, so no flatten step either.
    const buf = await sharp(svg).resize({ height }).png().toBuffer();
    writeFileSync(join(PNG_DIR, `${name}@${suffix}.png`), buf);
  }
  console.log(`brand: ${name}@1x.png, ${name}@2x.png`);
}
