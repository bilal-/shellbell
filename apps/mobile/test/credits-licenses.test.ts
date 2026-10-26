import { expect, it } from "vitest";

const { allowed, licenseIds, parseLicense } = await import("../scripts/build-credits.mjs");

it("reads SPDX expressions with AND binding tighter than OR, and parentheses", () => {
  expect(allowed("MIT")).toBe(true);
  expect(allowed("(MIT OR CC0-1.0)")).toBe(true);
  expect(allowed("MIT AND Apache-2.0")).toBe(true);
  // Grouping can't hide a licence outside the allowed set.
  expect(allowed("(MIT OR CC0-1.0) AND GPL-3.0")).toBe(false);
  expect(allowed("MIT OR GPL-3.0 AND Apache-2.0")).toBe(true);
  expect(allowed("GPL-3.0 OR LGPL-2.1")).toBe(false);
  expect(licenseIds(parseLicense("(MIT OR CC0-1.0) AND Apache-2.0"))).toEqual([
    "MIT",
    "CC0-1.0",
    "Apache-2.0",
  ]);
  // Exceptions and malformed expressions are refused, not guessed at.
  for (const odd of ["GPL-2.0 WITH Classpath-exception-2.0", "(MIT", "MIT AND", "OR MIT"])
    expect(() => allowed(odd)).toThrow(/Can't read/);
});

it("credits a package by its licence files only, and every licence it names without one", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { packageCredit } = await import("../scripts/build-credits.mjs");
  const dir = mkdtempSync(join(tmpdir(), "credits-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "dual",
        version: "1.0.0",
        license: "MIT AND Apache-2.0",
        author: "Ada <a@x>",
      }),
    );
    // A folder named like a licence file isn't one.
    mkdirSync(join(dir, "license"));
    const credit = packageCredit(dir)!;
    expect(credit.text).toContain("Copyright (c) Ada");
    expect(credit.text).toContain("Apache License");
    expect(credit.text).not.toContain("a@x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
