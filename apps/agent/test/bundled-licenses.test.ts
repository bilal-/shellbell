import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("npm bundled licenses", () => {
  it.each(["cborg", "@noble/ciphers", "@noble/curves", "@noble/hashes"])(
    "ships %s and Shellbell's full license without changes",
    async (name) => {
      const { writeBundleLicenses } = await import(
        pathToFileURL(resolve("scripts/bundle-licenses.mjs")).href
      );
      const destination = mkdtempSync(join(tmpdir(), "sb-bundled-licenses-"));
      try {
        writeBundleLicenses(destination);
        const source = resolve("../../node_modules", name);
        const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
        const target = `${name.replaceAll("/", "_")}--${pkg.version}--LICENSE`;
        expect(readFileSync(join(destination, target))).toEqual(
          readFileSync(join(source, "LICENSE")),
        );
        expect(readFileSync(join(destination, "Shellbell-LICENSE"))).toEqual(
          readFileSync(resolve("../../LICENSE")),
        );
      } finally {
        rmSync(destination, { recursive: true });
      }
    },
  );
});
