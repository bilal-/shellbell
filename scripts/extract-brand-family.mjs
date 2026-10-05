import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { AMBER, INK, mark, PAPER, svg } from "./brand-art.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SHELLBELL_BRAND_FAMILY_SVG_OUT ?? join(here, "../brand/svg");
const buf = readFileSync(join(here, "../apps/mobile/assets/fonts/JetBrainsMonoNerdFont-Bold.ttf"));
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const word = new opentype.Path();
let pen = 0;
for (const letter of "shellbell") {
  const glyph = font.charToGlyph(letter);
  word.extend(glyph.getPath(pen, 0, 220));
  pen += (glyph.advanceWidth * 220) / font.unitsPerEm;
}
const bb = word.getBoundingBox();
const width = bb.x2 - bb.x1;
const height = bb.y2 - bb.y1;
const wordAt = (x, y, color) =>
  `<g transform="translate(${x - bb.x1} ${y - bb.y1})"><path d="${word.toPathData(3)}" fill="${color}"/></g>`;
mkdirSync(out, { recursive: true });
for (const [colorway, ink, accent] of [
  ["on-dark", PAPER, AMBER],
  ["on-light", INK, AMBER],
  ["black", INK, INK],
  ["white", "#FFFFFF", "#FFFFFF"],
]) {
  const variants = {
    mark: svg("Shellbell mark", mark(accent), "-20 -20 400 320"),
    wordmark: svg("Shellbell wordmark", wordAt(20, 20, ink), `0 0 ${width + 40} ${height + 40}`),
    horizontal: svg(
      "Shellbell horizontal logo",
      `<g transform="translate(20 20) scale(0.68)">${mark(accent)}</g>` +
        wordAt(310, 20 + (190.4 - height) / 2, ink),
      `0 0 ${width + 330} 230.4`,
    ),
    stacked: svg(
      "Shellbell stacked logo",
      `<g transform="translate(${(width + 40 - 360) / 2} 20)">${mark(accent)}</g>` +
        wordAt(20, 370, ink),
      `0 0 ${width + 40} ${height + 390}`,
    ),
  };
  for (const [name, content] of Object.entries(variants))
    writeFileSync(join(out, `${name}-${colorway}.svg`), content);
}
console.log("brand: generated 16 vector logos");
