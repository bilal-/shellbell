import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { adaptive, background, centeredMark, icon, svg } from "../../../scripts/brand-art.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "../assets");
for (const [name, source, size, opaque] of [
  ["icon", icon(), 1024, true],
  ["android-icon-foreground", adaptive(), 1024, false],
  ["android-icon-monochrome", adaptive("#FFFFFF"), 1024, false],
  ["android-icon-background", background(), 1024, true],
  [
    "splash-icon",
    svg("Shellbell splash", `<rect width="1024" height="1024" fill="#000000"/>${centeredMark()}`),
    1024,
    true,
  ],
  ["favicon", icon({ flat: true, small: true }), 196, true],
]) {
  let render = sharp(Buffer.from(source)).resize(size, size);
  if (opaque) render = render.removeAlpha();
  writeFileSync(join(out, `${name}.png`), await render.png().toBuffer());
}
console.log("brand: rendered mobile assets");
