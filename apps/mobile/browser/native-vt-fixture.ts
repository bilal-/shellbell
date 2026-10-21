import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";

/** Playwright's Node CJS loader cannot require the protocol's ESM-only dependencies.
 * Bundle the actual native bridge/log together, as Metro does, for the browser duplex test. */
export function nativeVtFixture(): {
  TerminalVtBridge: typeof import("../src/terminal/vt-bridge").TerminalVtBridge;
  VtReplayLog: typeof import("../src/terminal/vt-replay-log").VtReplayLog;
} {
  const directory = mkdtempSync(join(tmpdir(), "shellbell-vt-fixture-"));
  const file = join(directory, "bridge.cjs");
  try {
    buildSync({
      stdin: {
        contents:
          'export { TerminalVtBridge } from "./vt-bridge.ts"; export { VtReplayLog } from "./vt-replay-log.ts";',
        resolveDir: resolve("src/terminal"),
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: file,
      logLevel: "silent",
    });
    return createRequire(resolve("package.json"))(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
