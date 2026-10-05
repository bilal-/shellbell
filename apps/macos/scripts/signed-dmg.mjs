import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withReadonlyDmg } from "./dmg-mount.mjs";
import { copyTree, fileInventory, requireNewPath } from "./package-lib.mjs";
import {
  diskIdentifier,
  reject,
  validateTeamId,
  verifyCandidateInventory,
} from "./signed-inventory.mjs";
import {
  publisherRequirement,
  runCaptured,
  verifySignedCandidate,
} from "./signed-verification.mjs";

export const signedDmgReadme =
  "Shellbell\nCopy Shellbell.app to Applications. Opening the app does not enable a future-login service without explicit consent.\nTo remove: explicitly stop/disable the service in Shellbell, quit the UI, then remove the app. Preserve keys/configuration unless you separately choose to delete them.\n";
const commandOptions = Object.freeze({ timeout: 60000, maxBuffer: 65536 });
const maxImageBytes = 1024 ** 3;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const buildDmgUsage =
  "native:build-signed-dmg --app ABS_APP --output UNUSED_ABS_DIR --identity-sha1 HEX40 --team-id TEAM10";
export const verifyDmgUsage =
  "native:verify-signed-dmg --image ABS_DMG --team-id TEAM10 --stage candidate|notarized --report UNUSED_ABS_FILE";
export function parseDmgArgs(args, mode) {
  if (!["build", "verify"].includes(mode)) reject("dmg-arguments");
  const keys =
    mode === "build"
      ? {
          "--app": "app",
          "--output": "output",
          "--identity-sha1": "identitySha1",
          "--team-id": "teamId",
        }
      : { "--image": "image", "--team-id": "teamId", "--stage": "stage", "--report": "report" };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!Object.hasOwn(keys, args[i]) || !args[i + 1] || Object.hasOwn(options, keys[args[i]]))
      reject("dmg-arguments");
    options[keys[args[i]]] = args[i + 1];
  }
  if (Object.keys(options).length !== Object.keys(keys).length) reject("dmg-arguments");
  validateTeamId(options.teamId);
  if (mode === "build") {
    absolute(options.app);
    absolute(options.output);
    if (!/^[a-fA-F0-9]{40}$/.test(options.identitySha1)) reject("signing-identity");
  } else {
    absolute(options.image);
    absolute(options.report);
    if (!["candidate", "notarized"].includes(options.stage)) reject("dmg-stage");
  }
  return options;
}

export async function verifySignedDmgReport(options, dependencies = {}) {
  absolute(options.report);
  requireNewPath(options.report);
  const report = await verifySignedDmg(options, dependencies);
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return report;
}

function absolute(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    Buffer.byteLength(path) > 4096 ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    reject("dmg-path");
}
function admitImageStat(st) {
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    (st.mode & 0o022) !== 0 ||
    st.size <= 0 ||
    st.size > maxImageBytes
  )
    reject("dmg-file");
}
function imageDigest(image) {
  absolute(image);
  if (!image.endsWith(".dmg")) reject("dmg-extension");
  const initial = lstatSync(image);
  admitImageStat(initial);
  const fd = openSync(image, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    admitImageStat(opened);
    if (initial.dev !== opened.dev || initial.ino !== opened.ino) reject("dmg-mutated");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!n) reject("dmg-mutated");
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    const after = fstatSync(fd),
      pathAfter = lstatSync(image);
    admitImageStat(after);
    admitImageStat(pathAfter);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    )
      reject("dmg-mutated");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function singleLine(text, prefix) {
  const matches = text.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) reject("dmg-signature-metadata");
  return matches[0].slice(prefix.length);
}
async function verifyPublisher(image, teamId, command) {
  await command(
    "/usr/bin/codesign",
    [
      "--verify",
      "--strict",
      "--test-requirement",
      publisherRequirement(teamId, diskIdentifier),
      image,
    ],
    commandOptions,
  );
  const { stderr } = await command(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", image],
    commandOptions,
  );
  if (
    singleLine(stderr, "Identifier=") !== diskIdentifier ||
    singleLine(stderr, "TeamIdentifier=") !== teamId
  )
    reject("dmg-signature-identity");
  const timestamp = singleLine(stderr, "Timestamp=").trim();
  if (!timestamp || /^(none|not set)$/i.test(timestamp)) reject("dmg-signature-timestamp");
}
async function assess(path, image, command) {
  const args = image
    ? ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", path]
    : ["--assess", "--type", "execute", "--verbose=4", path];
  const { stderr } = await command("/usr/sbin/spctl", args, commandOptions);
  if (
    !stderr.split(/\r?\n/).includes(`${path}: accepted`) ||
    singleLine(stderr, "source=") !== "Notarized Developer ID"
  )
    reject("dmg-gatekeeper");
}
function admitVolume(mount) {
  if (
    JSON.stringify(readdirSync(mount).sort()) !==
    JSON.stringify(["Applications", "READ-ME.txt", "Shellbell.app"])
  )
    reject("dmg-payload");
  const link = join(mount, "Applications");
  if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "/Applications")
    reject("dmg-payload");
  const readme = join(mount, "READ-ME.txt"),
    st = lstatSync(readme);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.size !== Buffer.byteLength(signedDmgReadme) ||
    readFileSync(readme, "utf8") !== signedDmgReadme
  )
    reject("dmg-payload");
}

export async function verifySignedDmg(
  { image, teamId, stage },
  { run: command = runCaptured } = {},
) {
  validateTeamId(teamId);
  if (!["candidate", "notarized"].includes(stage)) reject("dmg-stage");
  const before = imageDigest(image);
  // Never inspect/mount a distribution image on display metadata alone.
  await verifyPublisher(image, teamId, command);
  if (stage === "notarized") {
    await command("/usr/bin/xcrun", ["stapler", "validate", image], commandOptions);
    const status = await command("/usr/sbin/spctl", ["--status"], commandOptions);
    if (status.stdout.trim() !== "assessments enabled") reject("dmg-gatekeeper-disabled");
    await assess(image, true, command);
  }
  const embedded = await withReadonlyDmg(
    image,
    async (mount) => {
      admitVolume(mount);
      const app = join(mount, "Shellbell.app");
      if (stage === "notarized") await assess(app, false, command);
      const verified = await verifySignedCandidate(app, { teamId, run: command });
      admitVolume(mount);
      const appFiles = fileInventory(app);
      return { ...verified, appFiles, appFilesSha256: digest(JSON.stringify(appFiles)) };
    },
    { run: command },
  );
  const sha256 = imageDigest(image);
  if (before !== sha256) reject("dmg-mutated");
  return {
    format: "shellbell-signed-dmg-report-v1",
    image,
    ...embedded,
    sha256,
    stage,
    notarized: stage === "notarized",
    releaseReady: false,
  };
}

export async function buildSignedDmg(
  { app, output, identitySha1, teamId },
  { run: command = runCaptured } = {},
) {
  absolute(app);
  absolute(output);
  validateTeamId(teamId);
  if (typeof identitySha1 !== "string" || !/^[a-fA-F0-9]{40}$/.test(identitySha1))
    reject("signing-identity");
  requireNewPath(output);
  const sourceReal = realpathSync(app);
  const outputReal = join(realpathSync(dirname(output)), basename(output));
  const rel = relative(sourceReal, outputReal);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    reject("dmg-nested-output");
  await verifySignedCandidate(app, { teamId, run: command });
  const sourceFiles = fileInventory(app);
  const sourceSnapshot = JSON.stringify(sourceFiles);
  mkdirSync(output, { mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), "shellbell-signed-dmg-build-"));
  const volume = join(scratch, "volume");
  const image = join(output, "Shellbell.dmg");
  let report;
  try {
    mkdirSync(volume, { mode: 0o700 });
    const copy = join(volume, "Shellbell.app");
    copyTree(app, copy);
    await verifySignedCandidate(copy, { teamId, run: command });
    if (JSON.stringify(fileInventory(copy)) !== sourceSnapshot) reject("dmg-copy-mismatch");
    symlinkSync("/Applications", join(volume, "Applications"));
    writeFileSync(join(volume, "READ-ME.txt"), signedDmgReadme, { flag: "wx", mode: 0o644 });
    await command(
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        "Shellbell",
        "-srcfolder",
        volume,
        "-format",
        "UDZO",
        "-fs",
        "HFS+",
        image,
      ],
      commandOptions,
    );
    await command("/usr/bin/hdiutil", ["verify", image], commandOptions);
    await command(
      "/usr/bin/codesign",
      ["--force", "--timestamp", "--identifier", diskIdentifier, "--sign", identitySha1, image],
      commandOptions,
    );
    report = await verifySignedDmg({ image, teamId, stage: "candidate" }, { run: command });
    if (JSON.stringify(report.appFiles) !== sourceSnapshot) reject("dmg-embedded-mismatch");
    verifyCandidateInventory(app, teamId);
    if (JSON.stringify(fileInventory(app)) !== sourceSnapshot) reject("dmg-input-mutated");
  } finally {
    // Mounting owns a separate scratch root; even a failed detach never causes
    // this cleanup to recurse into its mount. Preserve the output on failure.
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(output, "signed-dmg-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return report;
}
