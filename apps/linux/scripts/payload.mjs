import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const runtimeManifest = JSON.parse(
  readFileSync(new URL("../runtime-manifest.json", import.meta.url), "utf8"),
);
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_INVENTORY = 8 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const SHA = /^[a-f0-9]{64}$/;
const STATE = /^(?:identity|pairings|config|host)\.json$|\.log$|\.sock$|\.pid$/;
export function fail(code) {
  throw Object.assign(new Error(`Linux payload: ${code}`), { code });
}
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-object");
  if (Object.keys(value).sort().join("\n") !== expected.sort().join("\n")) fail("invalid-fields");
}
export function validVersion(value) {
  return typeof value === "string" && value.length <= 64 && VERSION.test(value);
}
export function validPath(name) {
  return (
    typeof name === "string" &&
    name.length <= 240 &&
    /^[A-Za-z0-9_@.+/-]+$/.test(name) &&
    name.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !STATE.test(name.split("/").at(-1))
  );
}
function metadata(value) {
  keys(value, [
    "schema",
    "version",
    "arch",
    "sourceCommit",
    "runtimeVersion",
    "runtimeArchiveSha256",
    "files",
  ]);
  if (
    value.schema !== 1 ||
    !validVersion(value.version) ||
    !["arm64", "x64"].includes(value.arch) ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    value.runtimeVersion !== runtimeManifest.version ||
    value.runtimeArchiveSha256 !== runtimeManifest.archives[value.arch]?.sha256
  )
    fail("invalid-metadata");
  if (!value.files || typeof value.files !== "object" || Array.isArray(value.files))
    fail("invalid-files");
  for (const [name, entry] of Object.entries(value.files)) {
    if (!validPath(name) || name === "inventory.json") fail("invalid-path");
    keys(entry, ["sha256", "mode"]);
    if (!SHA.test(entry.sha256) || ![0o644, 0o755].includes(entry.mode)) fail("invalid-entry");
  }
}
export function inventoryFiles(root) {
  if (!isAbsolute(root) || root !== resolve(root)) fail("absolute-root-required");
  const files = Object.create(null);
  let total = 0;
  let count = 0;
  function visit(path, name) {
    const st = lstatSync(path);
    if (++count > MAX_ENTRIES) fail("too-many-entries");
    if (name && !validPath(name)) fail("invalid-path");
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail("unsupported-entry");
    if (st.mode & 0o7022) fail("unsafe-mode");
    if (st.isDirectory()) {
      for (const child of readdirSync(path).sort())
        visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    if (st.nlink !== 1 || st.size > MAX_FILE) fail("unsafe-file");
    total += st.size;
    if (total > MAX_TOTAL) fail("payload-too-large");
    if (name === "inventory.json") return;
    const mode = st.mode & 0o777;
    if (![0o644, 0o755].includes(mode)) fail("invalid-file-mode");
    files[name] = { sha256: sha256(readFileSync(path)), mode };
  }
  visit(root, "");
  return files;
}
function layout(root, value, files) {
  for (const name of [
    "runtime/bin/node",
    "runtime/LICENSE",
    "agent/package.json",
    "agent/dist/cli.js",
    "licenses/Shellbell-LICENSE",
    "install.mjs",
  ]) {
    if (!Object.hasOwn(files, name)) fail("missing-payload-file");
  }
  if (files["runtime/bin/node"].mode !== 0o755) fail("runtime-not-executable");
  const pkg = JSON.parse(readFileSync(join(root, "agent/package.json"), "utf8"));
  if (pkg.name !== "shellbell" || pkg.type !== "module" || pkg.version !== value.version)
    fail("package-metadata");
}
export async function writeInventory(root, input) {
  const value = { schema: 1, ...input, files: inventoryFiles(root) };
  metadata(value);
  layout(root, value, value.files);
  writeFileSync(join(root, "inventory.json"), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return value;
}
export async function verifyPayload(root, expected = {}) {
  const st = lstatSync(join(root, "inventory.json"));
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_INVENTORY)
    fail("invalid-inventory");
  const value = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
  metadata(value);
  for (const key of ["arch", "version", "sourceCommit"]) {
    if (expected[key] !== undefined && value[key] !== expected[key]) fail("unexpected-target");
  }
  const files = inventoryFiles(root);
  const names = Object.keys(value.files).sort();
  if (names.join("\n") !== Object.keys(files).sort().join("\n")) fail("inventory-file-set");
  for (const name of names) {
    if (
      files[name].sha256 !== value.files[name].sha256 ||
      files[name].mode !== value.files[name].mode
    )
      fail("inventory-mismatch");
  }
  layout(root, value, files);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPayload(resolve(process.argv[2] ?? "")).then(
    ({ arch, version, sourceCommit }) =>
      console.log(JSON.stringify({ arch, version, sourceCommit })),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
