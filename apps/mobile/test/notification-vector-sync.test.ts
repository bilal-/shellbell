import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it } from "vitest";

it("syncs both independent vector files and detects drift in the notification vectors", () => {
  const root = mkdtempSync(join(tmpdir(), "shellbell-vector-sync-"));
  try {
    const script = join(root, "apps/mobile/scripts/sync-vectors.mjs");
    const source = join(root, "packages/protocol/test");
    const dest = join(root, "apps/mobile/src/util");
    mkdirSync(join(root, "apps/mobile/scripts"), { recursive: true });
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });
    copyFileSync(new URL("../scripts/sync-vectors.mjs", import.meta.url), script);
    writeFileSync(join(source, "vectors.json"), '{"legacy":true}\n');
    writeFileSync(join(source, "notification-vectors.json"), '{"notification":true}\n');
    execFileSync(process.execPath, [script]);
    expect(readFileSync(join(dest, "vectors.json"), "utf8")).toBe('{"legacy":true}\n');
    expect(readFileSync(join(dest, "notification-vectors.json"), "utf8")).toBe(
      '{"notification":true}\n',
    );
    expect(spawnSync(process.execPath, [script, "--check"]).status).toBe(0);
    writeFileSync(join(dest, "notification-vectors.json"), "stale");
    expect(spawnSync(process.execPath, [script, "--check"]).status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
