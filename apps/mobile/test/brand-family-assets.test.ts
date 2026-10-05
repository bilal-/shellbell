import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

// Same root as brand-family-sources.test.ts -- the logo family's rasters, not the app icon set.
const FAMILY_PNG_DIR = join(__dirname, "../../../brand/png");

const VARIANTS = ["mark", "wordmark", "horizontal", "stacked"];
const COLOURWAYS = ["on-dark", "on-light", "black", "white"];
const NAMES = VARIANTS.flatMap((v) => COLOURWAYS.map((c) => `${v}-${c}`));
const SCALES: ReadonlyArray<readonly [string, number]> = [
  ["1x", 128],
  ["2x", 256],
];
const FILES: ReadonlyArray<readonly [string, number]> = NAMES.flatMap((n) =>
  SCALES.map(([suffix, height]) => [`${n}@${suffix}.png`, height] as const),
);

/** Alpha of the pixel `off` pixels in from each corner, sampled away from the very edge to avoid
 *  antialiasing artefacts at the corner pixel itself. Mirrors brand-assets.test.ts's helper. */
async function cornerAlphas(file: string, off = 2) {
  const { data, info } = await sharp(join(FAMILY_PNG_DIR, file)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const { width, height, channels } = info;
  const at = (x: number, y: number) => data[(y * width + x) * channels + 3]!;
  return {
    topLeft: at(off, off),
    topRight: at(width - 1 - off, off),
    bottomLeft: at(off, height - 1 - off),
    bottomRight: at(width - 1 - off, height - 1 - off),
  };
}

/** Fraction of pixels that are non-transparent, and fraction that are specifically amber
 *  (`#F59E0B`-ish, same tolerance brand-assets.test.ts uses for the app icon). Corner-alpha and
 *  height/aspect checks all pass trivially for a fully blank, correctly-sized transparent PNG --
 *  a render regression (wrong source path, failed compositing, an empty resize) would slip
 *  through everything else in this file. This is the guard for "something was actually drawn". */
async function pixelStats(file: string) {
  const { data, info } = await sharp(join(FAMILY_PNG_DIR, file)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const { channels } = info;
  let total = 0;
  let nonTransparent = 0;
  let amber = 0;
  for (let i = 0; i < data.length; i += channels) {
    total++;
    const a = data[i + 3]!;
    if (a === 0) continue;
    nonTransparent++;
    if (data[i]! > 200 && data[i + 1]! > 120 && data[i + 1]! < 190 && data[i + 2]! < 80) amber++;
  }
  return { nonTransparentFraction: nonTransparent / total, amberFraction: amber / total };
}

describe("brand family PNG assets", () => {
  it("has all 32 expected files (16 SVGs x @1x/@2x)", async () => {
    for (const [file] of FILES) {
      await expect(sharp(join(FAMILY_PNG_DIR, file)).metadata()).resolves.toBeDefined();
    }
  });

  it.each(FILES)("%s is transparent at all four corners", async (file) => {
    const corners = await cornerAlphas(file);
    for (const alpha of Object.values(corners)) expect(alpha).toBe(0);
  });

  it.each(FILES)("%s has the expected height", async (file, height) => {
    const m = await sharp(join(FAMILY_PNG_DIR, file)).metadata();
    expect(m.height).toBe(height);
  });

  // Coverage catches blank renders without depending on libvips-specific antialiasing.
  // Only the symbol is amber; the wordmark is uniformly light or dark.
  it.each(FILES)("%s is not blank: more than 5%% of pixels are non-transparent", async (file) => {
    const { nonTransparentFraction } = await pixelStats(file);
    expect(nonTransparentFraction).toBeGreaterThan(0.05);
  });

  it.each(FILES.filter(([name]) => !name.startsWith("wordmark") && name.includes("-on-")))(
    "%s carries the amber symbol",
    async (file) => {
      const { amberFraction } = await pixelStats(file);
      expect(amberFraction).toBeGreaterThan(0.01);
    },
  );

  it("every @2x is exactly double its @1x height, aspect ratio preserved", async () => {
    for (const n of NAMES) {
      const m1 = await sharp(join(FAMILY_PNG_DIR, `${n}@1x.png`)).metadata();
      const m2 = await sharp(join(FAMILY_PNG_DIR, `${n}@2x.png`)).metadata();
      expect(m1.height).toBe(128);
      expect(m2.height).toBe(256);
      const ratio1 = (m1.width ?? 0) / (m1.height ?? 1);
      const ratio2 = (m2.width ?? 0) / (m2.height ?? 1);
      expect(ratio2).toBeCloseTo(ratio1, 1);
    }
  });
});
