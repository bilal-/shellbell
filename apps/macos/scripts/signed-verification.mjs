import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileInventory, inspectBundle, manifest, powerHelperPath } from "./package-lib.mjs";
import {
  appIdentifier,
  dataChannelIdentifier,
  dataChannelPath,
  diskIdentifier,
  helperIdentifier,
  powerHelperIdentifier,
  reject,
  validateTeamId,
  verifyCandidateInventory,
} from "./signed-inventory.mjs";

const exec = promisify(execFile);
export const cleanEnvironment = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
export const helperEntitlements = Object.freeze({ "com.apple.security.cs.allow-jit": true });
export const appEntitlements = Object.freeze({});
export async function runCaptured(file, args, options = {}) {
  const timeout = options.timeout ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60000)
    reject("signature-command-timeout");
  const started = performance.now();
  const { stdout, stderr } = await exec(file, args, {
    cwd: options.cwd,
    env: options.env ?? cleanEnvironment,
    timeout,
    // A child can handle SIGTERM and later exit zero. These are owned short-lived
    // verification/signing subprocesses, so the deadline must force termination.
    killSignal: "SIGKILL",
    maxBuffer: options.maxBuffer ?? 65536,
    encoding: "utf8",
    shell: false,
  });
  // Also fail if delayed parent scheduling let an otherwise successful result
  // arrive after the wall-clock bound. Never treat an overdue result as success.
  if (performance.now() - started >= timeout) reject("signature-command-timeout");
  return { stdout, stderr };
}
export function publisherRequirement(teamId, identifier) {
  validateTeamId(teamId);
  if (
    ![
      appIdentifier,
      helperIdentifier,
      powerHelperIdentifier,
      diskIdentifier,
      dataChannelIdentifier,
    ].includes(identifier)
  )
    reject("signing-identifier");
  return (
    `=anchor apple generic and identifier "${identifier}" and ` +
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists and " +
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and " +
    `certificate leaf[subject.OU] = "${teamId}"`
  );
}
function singleLine(text, prefix) {
  const matches = text.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) reject("signature-metadata");
  return matches[0].slice(prefix.length);
}
async function inspectEntitlements(path, expected, command) {
  const { stdout } = await command("/usr/bin/codesign", [
    "--display",
    "--entitlements",
    "-",
    "--xml",
    path,
  ]);
  let actual = {};
  if (stdout.trim()) {
    const scratch = mkdtempSync(join(tmpdir(), "shellbell-entitlements-"));
    try {
      const plist = join(scratch, "entitlements.plist");
      writeFileSync(plist, stdout, { flag: "wx", mode: 0o600 });
      const output = await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
      actual = JSON.parse(output.stdout);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual) ||
    JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
    Object.keys(expected).some((key) => actual[key] !== expected[key])
  )
    reject("signature-entitlements");
}
async function verifyCode(path, identifier, teamId, entitlements, command, deep = false) {
  await command("/usr/bin/codesign", [
    "--verify",
    "--strict",
    ...(deep ? ["--deep"] : []),
    "--test-requirement",
    publisherRequirement(teamId, identifier),
    path,
  ]);
  // Display is checked only after successful cryptographic verification with
  // the external publisher requirement; display alone never grants admission.
  const { stderr } = await command("/usr/bin/codesign", ["--display", "--verbose=4", path]);
  if (
    singleLine(stderr, "Identifier=") !== identifier ||
    singleLine(stderr, "TeamIdentifier=") !== teamId
  )
    reject("signature-identity");
  const directory = singleLine(stderr, "CodeDirectory ");
  const flags = /(?:^| )flags=0x([0-9a-fA-F]{1,8})(?:\(| |$)/.exec(directory);
  if (!flags || (Number.parseInt(flags[1], 16) & 0x10000) === 0) reject("signature-runtime");
  if ((Number.parseInt(flags[1], 16) & 2) !== 0) reject("signature-development");
  const timestamp = singleLine(stderr, "Timestamp=").trim();
  if (!timestamp || /^(none|not set)$/i.test(timestamp)) reject("signature-timestamp");
  await inspectEntitlements(path, entitlements, command);
}

// A hot, deterministic numeric loop exercises normal V8 compilation. This is
// a bounded runtime smoke, not proof of every JIT tier/addon/platform behavior.
const runtimeProbe =
  "function sum(n){let x=0;for(let i=0;i<n;i++)x=(x+i)>>>0;return x;}" +
  "for(let i=0;i<200;i++){if(sum(10000)!==49995000)process.exit(2);}" +
  'process.stdout.write("shellbell-candidate-runtime-ok");';
async function probeRuntime(app, command) {
  const isolation = mkdtempSync(join(tmpdir(), "shellbell-signed-runtime-"));
  const options = {
    cwd: isolation,
    timeout: 5000,
    maxBuffer: 65536,
    env: {
      ...cleanEnvironment,
      HOME: isolation,
      SHELLBELL_DIR: join(isolation, "state"),
      XDG_STATE_HOME: join(isolation, "xdg-state"),
      XDG_RUNTIME_DIR: join(isolation, "runtime"),
    },
  };
  try {
    const node = join(app, "Contents/Helpers/node");
    const version = await command(node, ["--version"], options);
    if (version.stdout.trim() !== `v${manifest.version}`) reject("signed-runtime-version");
    const probe = await command(node, ["-e", runtimeProbe], options);
    if (probe.stdout.trim() !== "shellbell-candidate-runtime-ok") reject("signed-runtime-probe");
    const addon = await command(
      node,
      [
        "-e",
        'const api=require("node:module").createRequire(process.argv[1])("node-datachannel");' +
          'if(typeof api.PeerConnection!=="function"||typeof api.cleanup!=="function")process.exit(2);' +
          'api.cleanup();process.stdout.write("shellbell-candidate-datachannel-ok");',
        join(app, "Contents/Resources/agent/package.json"),
      ],
      options,
    );
    if (addon.stdout.trim() !== "shellbell-candidate-datachannel-ok")
      reject("signed-runtime-addon");
    if (readdirSync(isolation).length) reject("signed-runtime-state");
  } finally {
    // Only the directory created here; never any caller-supplied cleanup root.
    rmSync(isolation, { recursive: true, force: true });
  }
}
export async function verifySignedCandidate(app, { teamId, run: command = runCaptured } = {}) {
  validateTeamId(teamId);
  const record = verifyCandidateInventory(app, teamId);
  const before = JSON.stringify(fileInventory(app));
  const addon = join(app, dataChannelPath(record.arch));
  const addonArch = await command("/usr/bin/lipo", ["-archs", addon]);
  if (addonArch.stdout.trim() !== (record.arch === "x64" ? "x86_64" : record.arch))
    reject("signature-addon-arch");
  await verifyCode(addon, dataChannelIdentifier, teamId, appEntitlements, command);
  const inspected = await inspectBundle(app, {
    arch: record.arch,
    signedAddonSha256: record.files[dataChannelPath(record.arch)].sha256,
    run: async (file, args, options) => (await command(file, args, options)).stdout.trim(),
  });
  await verifyCode(
    join(app, "Contents/Helpers/node"),
    helperIdentifier,
    teamId,
    helperEntitlements,
    command,
  );
  await verifyCode(app, appIdentifier, teamId, appEntitlements, command, true);
  await verifyCode(
    join(app, powerHelperPath),
    powerHelperIdentifier,
    teamId,
    appEntitlements,
    command,
  );
  await probeRuntime(app, command);
  // fileInventory intentionally omits the development manifest. Re-admit the
  // candidate policy too, so a newly created legacy manifest cannot hide there.
  verifyCandidateInventory(app, teamId);
  if (JSON.stringify(fileInventory(app)) !== before) reject("signed-candidate-mutated");
  return {
    ...inspected,
    teamId,
    sourceCommit: record.sourceCommit,
    runtimeVersion: manifest.version,
    notarized: false,
    releaseReady: false,
  };
}
