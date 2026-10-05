import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../brand");
describe("platform icon contracts", () => {
  it("every manifest entry exists", () => {
    const manifest = JSON.parse(readFileSync(join(root, "asset-manifest.json"), "utf8"));
    expect(manifest.files.length).toBeGreaterThan(100);
    for (const file of manifest.files) expect(existsSync(join(root, file)), file).toBe(true);
  });
  it.each(["app", "service", "light", "tinted"])(
    "iOS %s is a full-bleed 1024px RGB image",
    async (role) => {
      const meta = await sharp(join(root, `ios/${role}-1024.png`)).metadata();
      expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1024, 1024, false]);
    },
  );
  it.each([16, 18])(
    "%ipoint menu-bar template and white fallback have identical alpha at both scales",
    async (size) => {
      for (const suffix of ["", "@2x"]) {
        const template = sharp(join(root, `macos/menu-bar/${size}/ShellbellTemplate${suffix}.png`));
        const white = sharp(join(root, `macos/menu-bar/${size}/ShellbellWhite${suffix}.png`));
        const meta = await template.metadata();
        const pixels = size * (suffix ? 2 : 1);
        expect([meta.width, meta.height]).toEqual([pixels, pixels]);
        const alpha = await template.clone().extractChannel("alpha").raw().toBuffer();
        expect(alpha.equals(await white.clone().extractChannel("alpha").raw().toBuffer())).toBe(
          true,
        );
        expect(alpha[0]).toBe(0);
        expect([...alpha].filter((v) => v > 0).length).toBeGreaterThan(pixels * pixels * 0.15);
        const rgb = await white.removeAlpha().raw().toBuffer();
        for (let i = 0; i < alpha.length; i++)
          if (alpha[i]! > 0) expect([...rgb.subarray(i * 3, i * 3 + 3)]).toEqual([255, 255, 255]);
      }
    },
  );
  it.each(["app", "service"])(
    "Windows %s ICO contains decodable images at required sizes",
    async (role) => {
      const data = readFileSync(join(root, `windows/shellbell-${role}.ico`));
      expect(data.readUInt16LE(0)).toBe(0);
      expect(data.readUInt16LE(2)).toBe(1);
      const count = data.readUInt16LE(4);
      const sizes = [];
      for (let i = 0; i < count; i++) {
        const p = 6 + i * 16;
        const size = data[p] || 256;
        sizes.push(size);
        const length = data.readUInt32LE(p + 8);
        const offset = data.readUInt32LE(p + 12);
        expect(offset + length).toBeLessThanOrEqual(data.length);
        const meta = await sharp(data.subarray(offset, offset + length)).metadata();
        expect([meta.width, meta.height]).toEqual([size, size]);
      }
      for (const size of [16, 24, 32, 48, 256]) expect(sizes).toContain(size);
    },
  );
  it.each(["app", "service"])("macOS %s ICNS has complete, decodable entries", async (role) => {
    const data = readFileSync(join(root, `macos/shellbell-${role}.icns`));
    expect(data.toString("ascii", 0, 4)).toBe("icns");
    expect(data.readUInt32BE(4)).toBe(data.length);
    let offset = 8;
    const sizes = [];
    while (offset < data.length) {
      const length = data.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThan(8);
      expect(offset + length).toBeLessThanOrEqual(data.length);
      const meta = await sharp(data.subarray(offset + 8, offset + length)).metadata();
      expect(meta.width).toBe(meta.height);
      sizes.push(meta.width);
      offset += length;
    }
    expect(offset).toBe(data.length);
    expect(sizes.sort((a, b) => a! - b!)).toEqual([16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
  });
});
