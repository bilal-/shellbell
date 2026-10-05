import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, "../assets/brand", name), "utf8");
describe("terminal attention mark", () => {
  it.each(["monogram.svg", "lockup.svg"])("%s is a standalone amber vector", (name) => {
    const source = read(name);
    expect(source).not.toMatch(/<text[\s>]|font-family|<image[\s>]/);
    expect(source).toContain("<title>");
    expect([...source.matchAll(/<path[\s>]/g)]).toHaveLength(4);
    expect([...source.matchAll(/fill="([^"]+)"/g)].map((m) => m[1])).toEqual(
      Array(4).fill("#F59E0B"),
    );
  });
});
