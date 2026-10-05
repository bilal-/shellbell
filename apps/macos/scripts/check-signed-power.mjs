#!/usr/bin/env node
// Explicitly gated, read-only IPC qualification against an already approved
// installed helper. This script never registers a daemon or requests a lease.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  if (process.env.SHELLBELL_SIGNED_POWER_TEST !== "1") {
    throw new Error("explicit authorization required");
  }
  const identity = process.env.SHELLBELL_POWER_SIGN_ID;
  const foreignIdentity = process.env.SHELLBELL_FOREIGN_SIGN_ID;
  const team = process.env.SHELLBELL_TEAM_ID;
  if (!identity || !foreignIdentity || !/^[A-Z0-9]{10}$/.test(team ?? "")) {
    throw new Error("both signing identities and the expected Team ID are required");
  }
  if (process.platform !== "darwin" || process.getuid?.() === 0) {
    throw new Error("run as the logged-in non-root macOS user");
  }
  const work = mkdtempSync(join(tmpdir(), "shellbell-power-probe-"));
  const run = (file, args, timeout = 30_000) =>
    execFileSync(file, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  const base = join(work, "base");
  const source = fileURLToPath(new URL("../Tests/Fixtures/PowerPeerProbe.swift", import.meta.url));
  run(
    "/usr/bin/xcrun",
    ["swiftc", "-module-cache-path", join(work, "cache"), source, "-o", base],
    120_000,
  );
  const variants = [
    ["genuine", identity, "sh.bilal.shellbell.host", "accept"],
    ["wrong-bundle", identity, "sh.bilal.shellbell.unrelated", "reject"],
    ["foreign-publisher", foreignIdentity, "sh.bilal.shellbell.host", "reject"],
    ["ad-hoc", "-", "sh.bilal.shellbell.host", "reject"],
    ["unsigned", null, null, "reject"],
  ];
  for (const [name, signer, identifier] of variants) {
    const binary = join(work, name);
    copyFileSync(base, binary);
    if (signer)
      run("/usr/bin/codesign", ["--force", "--sign", signer, "--identifier", identifier, binary]);
    else run("/usr/bin/codesign", ["--remove-signature", binary]);
  }
  // A genuine success before AND after rejection checks prevents an offline
  // helper from being misreported as successful peer rejection.
  for (const [name, , , expectation] of [...variants, variants[0]]) {
    // Apple Silicon may refuse an unsigned Mach-O before XPC is reached. Do not
    // count a kernel launch failure as evidence of helper authentication.
    if (name === "unsigned" && process.arch === "arm64") continue;
    run(join(work, name), [team, expectation], 12_000);
    console.log(`${name}: ${expectation} verified`);
  }
  if (process.arch === "arm64") {
    throw new Error(
      `unsigned IPC probe requires separate qualification; signed probe artifacts: ${work}`,
    );
  }
  console.log(`Read-only IPC probes passed. Artifacts retained at ${work}`);
} catch (error) {
  console.error(`signed-power-probe: ${error.message}`);
  process.exitCode = 2;
}
