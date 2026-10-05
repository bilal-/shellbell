import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../../../brand/svg");
const variants = ["mark", "wordmark", "horizontal", "stacked"];
const colors = ["on-dark", "on-light", "black", "white"];
const files = variants.flatMap((v) => colors.map((c) => `${v}-${c}.svg`));
describe("brand family vectors", () => {
  it("contains all four compositions in all four colorways", () => {
    expect(
      readdirSync(DIR)
        .filter((f) => f.endsWith(".svg"))
        .sort(),
    ).toEqual([...files].sort());
  });
  it.each(files)("%s has portable outlines and an accessible title", (name) => {
    const source = readFileSync(join(DIR, name), "utf8");
    expect(source).not.toMatch(/<text[\s>]|font-family|<image[\s>]/);
    expect(source).toMatch(/<path[\s>]/);
    expect(source).toContain("<title>");
    const fills = [...source.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    const allowed = name.endsWith("-white.svg")
      ? ["#FFFFFF"]
      : name.endsWith("-black.svg")
        ? ["#17191D"]
        : name.endsWith("-on-dark.svg")
          ? ["#F59E0B", "#F8F7F4"]
          : ["#F59E0B", "#17191D"];
    for (const fill of fills) expect(allowed).toContain(fill);
    if (name.startsWith("wordmark") && name.includes("on-")) expect(fills).not.toContain("#F59E0B");
  });
});
