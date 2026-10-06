import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// These regressions run inside the archive qualification container. Execute
// the actual harness with a fault, then prove it refuses to report success.
const source = readFileSync(new URL("./qualify.mjs", import.meta.url), "utf8");
const checksum = createHash("sha256").update(readFileSync("/opt/archive.tar.gz")).digest("hex");
function replaceOnce(source, marker, replacement) {
  assert.equal(source.split(marker).length, 2, "fault injection must have one target");
  return source.replace(marker, replacement);
}
function qualifyWithFault(source) {
  const root = mkdtempSync(join(tmpdir(), "sq-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home };
  const options = { env, encoding: "utf8", timeout: 120000 };
  try {
    const installed = spawnSync(
      "/bin/sh",
      ["/opt/install.sh", "--archive", "/opt/archive.tar.gz", "--sha256", checksum],
      options,
    );
    assert.equal(installed.error, undefined);
    assert.equal(installed.signal, null);
    assert.equal(installed.status, 0, installed.stderr);
    const fixture = join(root, "qualify.mjs");
    writeFileSync(fixture, source);
    const result = spawnSync(process.execPath, [fixture], options);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("qualification rejects a launcher that still runs the old payload after upgrade", () => {
  let fault = replaceOnce(
    source,
    "install(archive, sha(archive));",
    "install(archive, sha(archive));\nconst healthyLauncher = readFileSync(launcher);\n" +
      'writeFileSync(launcher, `#!/bin/sh\\nexec "${initialPath}/runtime/bin/node" "${initialPath}/agent/dist/cli.js" "$@"\\n`);',
  );
  // Restore after the version assertion window so removal's independent
  // unmanaged-launcher check cannot conceal a missing version assertion.
  fault = replaceOnce(
    fault,
    'run(process.execPath, ["/opt/payload/install.mjs", "--uninstall"]);',
    'writeFileSync(launcher, healthyLauncher);\nrun(process.execPath, ["/opt/payload/install.mjs", "--uninstall"]);',
  );
  const result = qualifyWithFault(fault);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /launcher must run the upgraded version/);
});
