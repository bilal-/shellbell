import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const A = join(__dirname, "../assets");

/** The template placeholders were light (white / #E8E8ED-ish graph paper); the brand is near-black.
 *  Mean luminance is a blunt but honest guard: it fails loudly if a template is ever restored.
 *  Only valid for opaque assets -- `removeAlpha` turns transparent pixels black, which would make
 *  a transparent layer pass this assertion for the wrong reason (see the Android layer tests
 *  below for those). */
async function meanLuma(file: string) {
  const { data, info } = await sharp(join(A, file))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels)
    sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  return sum / (data.length / info.channels);
}

const dark = ["icon.png", "splash-icon.png", "favicon.png", "android-icon-background.png"];

/** Alpha of the pixel `off` pixels in from each corner, sampled away from the very edge to avoid
 *  antialiasing artefacts at the corner pixel itself. */
async function cornerAlphas(file: string, off = 4) {
  const { data, info } = await sharp(join(A, file)).ensureAlpha().raw().toBuffer({
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

describe("brand raster assets", () => {
  it.each(dark)("%s is dark, not an Expo template", async (f) => {
    expect(await meanLuma(f)).toBeLessThan(85);
  });

  it("the icon actually carries the amber accent", async () => {
    const { data, info } = await sharp(join(A, "icon.png"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let amber = 0;
    for (let i = 0; i < data.length; i += info.channels)
      if (data[i]! > 200 && data[i + 1]! > 120 && data[i + 1]! < 190 && data[i + 2]! < 80) amber++;
    expect(amber).toBeGreaterThan(15000);
  });

  it.each(["icon.png", "android-icon-foreground.png", "android-icon-monochrome.png"])(
    "%s is 1024x1024",
    async (f) => {
      const m = await sharp(join(A, f)).metadata();
      expect([m.width, m.height]).toEqual([1024, 1024]);
    },
  );

  it("favicon.png is 196x196", async () => {
    const m = await sharp(join(A, "favicon.png")).metadata();
    expect([m.width, m.height]).toEqual([196, 196]);
  });

  // Task 3 shipped a Critical defect: the Android foreground and monochrome layers were fully
  // opaque with the tile baked in, which defeats Android's two-layer adaptive-icon compositing
  // (the OS draws background, then foreground, then substitutes monochrome for both when themed).
  // Nothing above catches this -- all four assets in `dark` are meant to be opaque, and the
  // luminance/size checks don't know anything about alpha. These tests assert the layer contract
  // directly: the two mark-only layers must be transparent so the background shows through, and
  // the background plate must be fully opaque so it isn't itself see-through.
  describe("Android adaptive-icon layer contract (spec §3, §4)", () => {
    it.each(["android-icon-foreground.png", "android-icon-monochrome.png"])(
      "%s is transparent at all four corners",
      async (f) => {
        const corners = await cornerAlphas(f);
        for (const alpha of Object.values(corners)) expect(alpha).toBe(0);
      },
    );

    it("android-icon-background.png is opaque at all four corners", async () => {
      const corners = await cornerAlphas("android-icon-background.png");
      for (const alpha of Object.values(corners)) expect(alpha).toBe(255);
    });

    it("android-icon-background.png carries the 135deg gradient (lighter top-left than bottom-right)", async () => {
      const { data, info } = await sharp(join(A, "android-icon-background.png"))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      const off = 8;
      const lumaAt = (x: number, y: number) => {
        const i = (y * width + x) * channels;
        return 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      };
      const topLeft = lumaAt(off, off);
      const bottomRight = lumaAt(width - 1 - off, height - 1 - off);
      expect(topLeft).toBeGreaterThan(bottomRight);
    });
  });

  // Task 3's Critical (opaque tile baked into foreground/monochrome) got a regression test above.
  // Its sibling finding never did: nothing asserted that the monochrome layer is actually
  // single-colour, or that foreground and monochrome carry the *same* mark in the *same* place
  // inside the safe zone. A regression here could silently ship a themed icon that doesn't match
  // the normal one, or a mark that bleeds outside the guaranteed-visible window.
  describe("Android foreground/monochrome mark parity (spec §3, §4)", () => {
    /** Bounding box of non-transparent pixels, in source pixel coordinates. */
    async function opaqueBBox(file: string) {
      const { data, info } = await sharp(join(A, file)).ensureAlpha().raw().toBuffer({
        resolveWithObject: true,
      });
      const { width, height, channels } = info;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const alpha = data[(y * width + x) * channels + 3]!;
          if (alpha === 0) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return { minX, minY, maxX, maxY };
    }

    it("android-icon-monochrome.png is single-colour: every opaque pixel is #FFFFFF", async () => {
      const { data, info } = await sharp(join(A, "android-icon-monochrome.png"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { channels } = info;
      for (let i = 0; i < data.length; i += channels) {
        if (data[i + 3] === 0) continue;
        expect([data[i], data[i + 1], data[i + 2]]).toEqual([255, 255, 255]);
      }
    });

    it("foreground and monochrome carry the same mark (matching opaque-pixel bounding boxes)", async () => {
      const fg = await opaqueBBox("android-icon-foreground.png");
      const mono = await opaqueBBox("android-icon-monochrome.png");
      const TOLERANCE = 2; // pixels -- allows for antialiasing/rounding, not a different mark.
      expect(Math.abs(fg.minX - mono.minX)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(fg.minY - mono.minY)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(fg.maxX - mono.maxX)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(fg.maxY - mono.maxY)).toBeLessThanOrEqual(TOLERANCE);
    });

    // Conservative bounding box, plus a per-pixel circular safe-zone check below.
    const SAFE_MIN = 199;
    const SAFE_MAX = 824;

    it.each(["android-icon-foreground.png", "android-icon-monochrome.png"])(
      "%s's mark sits inside the Android safe zone (199..824)",
      async (f) => {
        const bbox = await opaqueBBox(f);
        expect(bbox.minX).toBeGreaterThanOrEqual(SAFE_MIN);
        expect(bbox.minY).toBeGreaterThanOrEqual(SAFE_MIN);
        expect(bbox.maxX).toBeLessThanOrEqual(SAFE_MAX);
        expect(bbox.maxY).toBeLessThanOrEqual(SAFE_MAX);
      },
    );
    it.each(["android-icon-foreground.png", "android-icon-monochrome.png"])(
      "%s fits entirely within the 66/108 safe circle",
      async (file) => {
        const { data, info } = await sharp(join(A, file))
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const radius = (info.width * 33) / 108;
        let outside = 0;
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++) {
            if (
              data[(y * info.width + x) * 4 + 3]! > 0 &&
              Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) > radius
            )
              outside++;
          }
        expect(outside).toBe(0);
      },
    );
  });
});
