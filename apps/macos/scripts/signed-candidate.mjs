import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  copyTree,
  fileInventory,
  powerHelperPath,
  requireNewPath,
  verifyBundle,
} from "./package-lib.mjs";
import {
  appIdentifier,
  assertNativeAllowlist,
  candidatePath,
  createCandidateInventory,
  dataChannelIdentifier,
  dataChannelPath,
  developmentPath,
  helperIdentifier,
  powerHelperIdentifier,
  reject,
  validateTeamId,
} from "./signed-inventory.mjs";
import {
  appEntitlements,
  helperEntitlements,
  runCaptured,
  verifySignedCandidate,
} from "./signed-verification.mjs";

export const signUsage =
  "native:sign-candidate --app ABS_APP --output UNUSED_ABS_DIR --identity-sha1 HEX40 --team-id TEAM10";
export const verifyUsage = "native:verify-signed-candidate --app ABS_APP --team-id TEAM10";
function absolute(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    Buffer.byteLength(path) > 4096 ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    reject("candidate-path");
}
function validateOptions(options, mode) {
  absolute(options.app);
  validateTeamId(options.teamId);
  if (mode === "sign") {
    absolute(options.output);
    if (typeof options.identitySha1 !== "string" || !/^[a-fA-F0-9]{40}$/.test(options.identitySha1))
      reject("signing-identity");
  }
}
export function parseCandidateArgs(args, mode) {
  if (!["sign", "verify"].includes(mode)) reject("candidate-arguments");
  const keys = {
    "--app": "app",
    "--team-id": "teamId",
    ...(mode === "sign" ? { "--output": "output", "--identity-sha1": "identitySha1" } : {}),
  };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!Object.hasOwn(keys, args[i]) || !args[i + 1] || Object.hasOwn(options, keys[args[i]]))
      reject("candidate-arguments");
    options[keys[args[i]]] = args[i + 1];
  }
  if (Object.keys(options).length !== Object.keys(keys).length) reject("candidate-arguments");
  validateOptions(options, mode);
  return options;
}
function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function plist(entitlements) {
  // Keys/booleans are fixed local policy, never caller-supplied XML.
  return (
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    Object.keys(entitlements)
      .sort()
      .map((key) => `<key>${key}</key><true/>`)
      .join("") +
    "</dict></plist>\n"
  );
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function signCandidate(options, { run: command = runCaptured } = {}) {
  validateOptions(options, "sign");
  const { app: input, output, identitySha1, teamId } = options;
  requireNewPath(output);
  const sourceReal = realpathSync(input);
  const outputReal = join(realpathSync(dirname(output)), basename(output));
  const rel = relative(sourceReal, outputReal);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    reject("candidate-nested-output");
  if (entryExists(join(input, candidatePath))) reject("candidate-already-present");
  const legacyRun = async (file, args, opts) => (await command(file, args, opts)).stdout.trim();
  const admitted = await verifyBundle(input, { run: legacyRun });
  const sourceFiles = JSON.stringify(assertNativeAllowlist(input, admitted.arch));
  const developmentBytes = readFileSync(join(input, developmentPath));
  const development = JSON.parse(developmentBytes.toString("utf8"));
  mkdirSync(output, { mode: 0o700 });
  const app = join(output, "Shellbell.app");
  copyTree(input, app);
  await verifyBundle(app, { run: legacyRun });
  if (
    JSON.stringify(assertNativeAllowlist(app, admitted.arch)) !== sourceFiles ||
    !readFileSync(join(app, developmentPath)).equals(developmentBytes)
  )
    reject("candidate-copy-mismatch");

  const scratch = mkdtempSync(join(tmpdir(), "shellbell-signing-policy-"));
  try {
    const helperPolicy = join(scratch, "helper.plist"),
      appPolicy = join(scratch, "app.plist");
    writeFileSync(helperPolicy, plist(helperEntitlements), { flag: "wx", mode: 0o600 });
    writeFileSync(appPolicy, plist(appEntitlements), { flag: "wx", mode: 0o600 });
    const sign = (path, identifier, entitlements) =>
      command(
        "/usr/bin/codesign",
        [
          "--force",
          "--options",
          "runtime",
          "--timestamp",
          "--identifier",
          identifier,
          "--entitlements",
          entitlements,
          "--sign",
          identitySha1,
          path,
        ],
        { timeout: 60000, maxBuffer: 65536 },
      );
    await sign(join(app, dataChannelPath(admitted.arch)), dataChannelIdentifier, appPolicy);
    await sign(join(app, "Contents/Helpers/node"), helperIdentifier, helperPolicy);
    await sign(join(app, powerHelperPath), powerHelperIdentifier, appPolicy);
    // Only the known copied inventory is removed; the caller's app is untouched.
    unlinkSync(join(app, developmentPath));
    createCandidateInventory(app, {
      arch: admitted.arch,
      sourceCommit: development.sourceCommit,
      runtimeArchiveSha256: development.runtimeArchiveSha256,
      developmentInventorySha256: digest(developmentBytes),
      teamId,
    });
    await sign(app, appIdentifier, appPolicy);
    // No writes to the app after its outer signature, including provenance.
    const verification = await verifySignedCandidate(app, { teamId, run: command });
    if (
      JSON.stringify(fileInventory(input)) !== sourceFiles ||
      !readFileSync(join(input, developmentPath)).equals(developmentBytes)
    )
      reject("candidate-input-mutated");
    const files = fileInventory(app);
    const report = {
      format: "shellbell-signed-candidate-report-v1",
      app,
      ...verification,
      filesSha256: digest(JSON.stringify(files)),
      files,
    };
    writeFileSync(join(output, "candidate-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    return report;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
