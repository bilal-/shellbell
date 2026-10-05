import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileInventory, manifest, powerHelperPath } from "./package-lib.mjs";

export const appIdentifier = "sh.bilal.shellbell.host";
export const helperIdentifier = "sh.bilal.shellbell.host.runtime.node";
export const powerHelperIdentifier = "sh.bilal.shellbell.power";
export const dataChannelIdentifier = "sh.bilal.shellbell.host.runtime.node-datachannel";
export const dataChannelVersion = JSON.parse(
  readFileSync(new URL("../../agent/package.json", import.meta.url), "utf8"),
).dependencies["node-datachannel"];
if (!/^\d+\.\d+\.\d+$/.test(dataChannelVersion)) reject("candidate-addon-version");
export function dataChannelPath(arch) {
  if (!Object.hasOwn(manifest.archives, arch)) reject("candidate-addon-arch");
  return `Contents/Resources/agent/node_modules/@node-datachannel/darwin-${arch}/node_datachannel.node`;
}
function inspectDataChannelPackages(app, arch) {
  for (const [name, relative] of [
    ["node-datachannel", "Contents/Resources/agent/node_modules/node-datachannel/package.json"],
    [
      `@node-datachannel/darwin-${arch}`,
      dataChannelPath(arch).replace(/node_datachannel\.node$/, "package.json"),
    ],
  ]) {
    const path = join(app, relative);
    regular(path, 1024 * 1024);
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (pkg.name !== name || pkg.version !== dataChannelVersion) reject("candidate-addon-package");
  }
}
export const diskIdentifier = "sh.bilal.shellbell.host.disk-image";
export const candidatePath = "Contents/Resources/signed-candidate.json";
export const developmentPath = "Contents/Resources/build-inventory.json";
const nativePaths = ["Contents/Helpers/node", "Contents/MacOS/Shellbell", powerHelperPath];
const signaturePath = "Contents/_CodeSignature/CodeResources";
const exclusions = new Set([candidatePath, nativePaths[1], signaturePath]);
const format = "shellbell-signed-candidate-v3";
const recordKeys = [
  "format",
  "appIdentifier",
  "helperIdentifier",
  "powerHelperIdentifier",
  "dataChannelIdentifier",
  "dataChannelVersion",
  "runtimeVersion",
  "arch",
  "sourceCommit",
  "runtimeArchiveSha256",
  "developmentInventorySha256",
  "teamId",
  "files",
].sort();
const metadataKeys = [
  "arch",
  "sourceCommit",
  "runtimeArchiveSha256",
  "developmentInventorySha256",
  "teamId",
].sort();
const machOMagic = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
export function reject(code) {
  throw Object.assign(new Error(code), { code });
}
export function validateTeamId(teamId) {
  if (typeof teamId !== "string" || !/^[A-Z0-9]{10}$/.test(teamId)) reject("signing-team-id");
  return teamId;
}
function keysMatch(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}
function optionalStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function regular(path, maxBytes = Infinity) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > maxBytes)
    reject("candidate-file");
  return st;
}
function native(path) {
  // Inspect only the header, never evaluate a candidate or load an addon.
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && machOMagic.has(header.toString("hex"));
  } finally {
    closeSync(fd);
  }
}
function assertRoot(app) {
  if (
    typeof app !== "string" ||
    !isAbsolute(app) ||
    resolve(app) !== app ||
    Buffer.byteLength(app) > 4096 ||
    [...app].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    reject("candidate-path");
  const st = lstatSync(app);
  if (!st.isDirectory() || st.isSymbolicLink()) reject("candidate-root");
  if (optionalStat(join(app, developmentPath))) reject("candidate-development-inventory");
  if (optionalStat(join(app, signaturePath))) regular(join(app, signaturePath));
}
export function assertNativeAllowlist(app, arch) {
  // Existing traversal enforces confinement, safe modes, file types and count.
  const files = fileInventory(app);
  const allowed = [...nativePaths, dataChannelPath(arch)];
  inspectDataChannelPackages(app, arch);
  for (const name of allowed) {
    regular(join(app, name));
    if (!native(join(app, name))) reject("candidate-native-required");
  }
  for (const name of Object.keys(files)) {
    const path = join(app, name);
    // Include links to files in the scan: an alias must not add another native
    // code location. Directory link targets are already inside the walked tree.
    if (statSync(path).isFile() && native(path) && !allowed.includes(name))
      reject("candidate-extra-native-code");
  }
  return files;
}
function payload(app, arch) {
  assertRoot(app);
  const files = assertNativeAllowlist(app, arch);
  for (const name of exclusions) delete files[name];
  return files;
}
function validateMetadata(metadata, expectedTeamId) {
  validateTeamId(expectedTeamId);
  if (
    !keysMatch(metadata, metadataKeys) ||
    metadata.teamId !== expectedTeamId ||
    typeof metadata.arch !== "string" ||
    !Object.hasOwn(manifest.archives, metadata.arch) ||
    metadata.runtimeArchiveSha256 !== manifest.archives[metadata.arch].sha256 ||
    typeof metadata.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(metadata.sourceCommit) ||
    typeof metadata.developmentInventorySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.developmentInventorySha256)
  )
    reject("candidate-provenance");
}
export function createCandidateInventory(app, metadata) {
  validateMetadata(metadata, metadata?.teamId);
  if (optionalStat(join(app, candidatePath))) reject("candidate-output-exists");
  const record = {
    format,
    appIdentifier,
    helperIdentifier,
    powerHelperIdentifier,
    dataChannelIdentifier,
    dataChannelVersion,
    runtimeVersion: manifest.version,
    ...metadata,
    files: payload(app, metadata.arch),
  };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) reject("candidate-inventory-limit");
  writeFileSync(join(app, candidatePath), bytes, { flag: "wx", mode: 0o644 });
  return record;
}
export function verifyCandidateInventory(app, expectedTeamId) {
  validateTeamId(expectedTeamId);
  assertRoot(app);
  const path = join(app, candidatePath);
  regular(path, 4 * 1024 * 1024);
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (
    !keysMatch(record, recordKeys) ||
    record.format !== format ||
    record.appIdentifier !== appIdentifier ||
    record.helperIdentifier !== helperIdentifier ||
    record.powerHelperIdentifier !== powerHelperIdentifier ||
    record.dataChannelIdentifier !== dataChannelIdentifier ||
    record.dataChannelVersion !== dataChannelVersion ||
    record.runtimeVersion !== manifest.version
  )
    reject("candidate-provenance");
  const { arch, sourceCommit, runtimeArchiveSha256, developmentInventorySha256, teamId } = record;
  validateMetadata(
    { arch, sourceCommit, runtimeArchiveSha256, developmentInventorySha256, teamId },
    expectedTeamId,
  );
  if (JSON.stringify(record.files) !== JSON.stringify(payload(app, record.arch)))
    reject("candidate-integrity");
  return record;
}
