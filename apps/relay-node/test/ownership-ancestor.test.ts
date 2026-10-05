import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { privateDirectory } from "../src/storage/ownership.js";

// Simulate only an ancestor's stat ownership/mode. No chown or privilege changes;
// all real filesystem effects remain confined to disposable temporary directories.
const simulated = vi.hoisted(() => ({ path: "", uid: 0, mode: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync(path: string) {
      const stat = fs.lstatSync(path);
      if (path === simulated.path) {
        stat.uid = simulated.uid;
        stat.mode = (stat.mode & ~0o7777) | simulated.mode;
      }
      return stat;
    },
  };
});

it.each([0o755, 0o1777])("rejects a foreign-user-owned ancestor with mode %s", (mode) => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "shellbell-ancestor-test-"));
  const dir = join(parent, "data");
  mkdirSync(dir, { mode: 0o700 });
  simulated.path = parent;
  simulated.uid = process.geteuid!() + 1;
  simulated.mode = mode;
  try {
    expect(() => privateDirectory(dir)).toThrow(/parent/);
  } finally {
    simulated.path = "";
    rmSync(parent, { recursive: true });
  }
});

it.each(["effective-user", "root"] as const)(
  "accepts a protected ancestor owned by %s",
  (owner) => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "shellbell-ancestor-test-"));
    const dir = join(parent, "data");
    mkdirSync(dir, { mode: 0o700 });
    simulated.path = parent;
    simulated.uid = owner === "root" ? 0 : process.geteuid!();
    simulated.mode = owner === "root" ? 0o1777 : 0o755;
    try {
      expect(privateDirectory(dir)).toBe(dir);
    } finally {
      simulated.path = "";
      rmSync(parent, { recursive: true });
    }
  },
);
