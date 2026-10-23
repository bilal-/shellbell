import { execFile } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const clean = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const receiptName = "installation.json";
export const LAUNCHER = `#!/bin/sh
# Shellbell managed macOS CLI launcher v1. Do not edit.
set -eu
test -n "$HOME" || { echo 'Shellbell: HOME is required' >&2; exit 1; }
base="$HOME/.local/share/shellbell/installs/darwin-arm64"
version=$(/usr/bin/readlink "$base/current") || exit 1
case "$version" in ''|*[!0-9.]*|.*|*..*) echo 'Shellbell: invalid installation pointer' >&2; exit 1 ;; esac
unset NODE_OPTIONS NODE_PATH
exec "$base/$version/Shellbell.app/Contents/Helpers/node" "$base/$version/Shellbell.app/Contents/Resources/agent/dist/cli.js" "$@"
`;
function fail(message) {
  throw new Error(`Shellbell installer: ${message}`);
}
function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function version(value) {
  if (typeof value !== "string" || value.length > 32 || !VERSION.test(value))
    fail("invalid version");
  return value;
}
function directory(path, uid, create = false) {
  if (create && !stat(path)) mkdirSync(path, { mode: 0o700 });
  const st = stat(path);
  if (!st?.isDirectory() || st.isSymbolicLink() || st.uid !== uid || st.mode & 0o7022)
    fail("unsafe installation directory");
}
function file(path, uid) {
  const st = stat(path);
  if (
    !st?.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.uid !== uid ||
    st.mode & 0o7022 ||
    st.size > 1024 * 1024
  )
    fail("unsafe installation metadata");
  return readFileSync(path, "utf8");
}
export function prepare(home, uid = process.getuid?.()) {
  if (!uid || uid !== process.geteuid() || !isAbsolute(home ?? "") || resolve(home) === "/")
    fail("normal user and absolute HOME required");
  directory(home, uid);
  const canonical = realpathSync(home);
  for (let ancestor = dirname(canonical); ; ancestor = dirname(ancestor)) {
    const st = lstatSync(ancestor);
    if (
      !st.isDirectory() ||
      (st.uid !== uid && st.uid !== 0) ||
      (st.mode & 0o022 && !(st.uid === 0 && st.mode & 0o1000))
    )
      fail("unsafe HOME ancestor");
    if (ancestor === dirname(ancestor)) break;
  }
  let root = canonical;
  for (const part of [".local", "share", "shellbell", "installs"]) {
    root = join(root, part);
    directory(root, uid, true);
  }
  directory(join(canonical, ".local/bin"), uid, true);
  const launcher = join(canonical, ".local/bin/shellbell");
  if (stat(launcher) && file(launcher, uid) !== LAUNCHER)
    fail("existing launcher is not managed by this installer");
  return { home: canonical, root, launcher, uid };
}
async function command(path, args, options = {}) {
  return exec(path, args, {
    env: clean,
    timeout: 60000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
    ...options,
  });
}
export async function verifyApp(app, expectedVersion) {
  const { stdout } = await command("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    join(app, "Contents/Info.plist"),
  ]);
  const info = JSON.parse(stdout);
  if (
    info.CFBundleIdentifier !== "sh.bilal.shellbell.host" ||
    info.CFBundleShortVersionString !== expectedVersion
  )
    fail("unexpected app identity or version");
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  await command("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
  const pkg = JSON.parse(readFileSync(join(app, "Contents/Resources/agent/package.json"), "utf8"));
  if (pkg.name !== "shellbell" || pkg.version !== expectedVersion) fail("unexpected CLI version");
}
export function inspectTree(root) {
  const canonical = realpathSync(root);
  let count = 0;
  let bytes = 0;
  function visit(path) {
    const st = lstatSync(path);
    if (++count > 20000) fail("too many app entries");
    if (st.isSymbolicLink()) {
      const target = readlinkSync(path);
      // Preserve signed relative dependency links. realpath rejects dangling
      // links and cycles; traversal never follows a link outside the bundle.
      if (isAbsolute(target) || !realpathSync(path).startsWith(`${canonical}/`))
        fail("app symlink escapes the bundle");
      return;
    }
    if (st.mode & 0o7022) fail("unsafe app contents");
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else {
      bytes += st.size;
      if (!st.isFile() || st.nlink !== 1 || st.size > 268435456 || bytes > 1073741824)
        fail("unsafe app file");
    }
  }
  visit(root);
}
async function probe(app, expectedVersion, parent) {
  const home = mkdtempSync(join(parent, "probe-"));
  try {
    for (const flag of ["--version", "--help"]) {
      const { stdout } = await command(
        join(app, "Contents/Helpers/node"),
        [join(app, "Contents/Resources/agent/dist/cli.js"), flag],
        {
          cwd: home,
          timeout: 5000,
          env: {
            ...clean,
            HOME: home,
            TMPDIR: home,
            SHELLBELL_DIR: join(home, "state"),
            XDG_CONFIG_HOME: join(home, "config"),
            XDG_DATA_HOME: join(home, "data"),
          },
        },
      );
      if (
        flag === "--version"
          ? stdout.trim() !== expectedVersion
          : !stdout.startsWith("Usage: shellbell")
      )
        fail("CLI probe failed");
    }
    if (readdirSync(home).length) fail("CLI probe created state");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
export async function install({
  app,
  home,
  target,
  digest,
  previous,
  installerDirectory = dirname(fileURLToPath(import.meta.url)),
}) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("Apple silicon macOS required");
  version(target);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail("invalid release checksum");
  if (previous) {
    version(previous);
    const next = target.split(".").map(BigInt);
    const before = previous.split(".").map(BigInt);
    if ((next.map((n, i) => n - before[i]).find((n) => n !== 0n) ?? 0n) <= 0n)
      fail("update must be newer");
  }
  inspectTree(app);
  await verifyApp(app, target);
  const state = prepare(home);
  const lock = join(state.root, ".install.lock");
  mkdirSync(lock, { mode: 0o700 });
  let pointer;
  let stagedLauncher;
  try {
    const base = join(state.root, "darwin-arm64");
    directory(base, state.uid, true);
    const current = join(base, "current");
    const currentStat = stat(current);
    if (currentStat) {
      if (!currentStat.isSymbolicLink() || currentStat.uid !== state.uid)
        fail("unsafe current pointer");
      const old = version(readlinkSync(current));
      directory(join(base, old), state.uid);
      const receipt = JSON.parse(file(join(base, old, receiptName), state.uid));
      if (
        receipt.schema !== 1 ||
        receipt.version !== old ||
        receipt.platform !== "darwin-arm64" ||
        !/^[a-f0-9]{64}$/.test(receipt.dmgSha256)
      )
        fail("invalid installed receipt");
      if (previous && previous !== old) fail("current version changed");
    } else if (previous) fail("current version changed");
    const receipt = `${JSON.stringify({ schema: 1, version: target, platform: "darwin-arm64", dmgSha256: digest }, null, 2)}\n`;
    const scripts = {
      "install.mjs": readFileSync(join(installerDirectory, "install.mjs"), "utf8"),
      "install.sh": readFileSync(join(installerDirectory, "install.sh"), "utf8"),
    };
    const destination = join(base, target);
    if (stat(destination)) {
      directory(destination, state.uid);
      if (
        file(join(destination, receiptName), state.uid) !== receipt ||
        Object.entries(scripts).some(
          ([name, text]) => file(join(destination, name), state.uid) !== text,
        )
      )
        fail("immutable version conflict");
      inspectTree(join(destination, "Shellbell.app"));
      await verifyApp(join(destination, "Shellbell.app"), target);
      await probe(join(destination, "Shellbell.app"), target, lock);
    } else {
      const stage = mkdtempSync(join(base, ".staging-"));
      await command("/usr/bin/ditto", [app, join(stage, "Shellbell.app")]);
      inspectTree(join(stage, "Shellbell.app"));
      await verifyApp(join(stage, "Shellbell.app"), target);
      await probe(join(stage, "Shellbell.app"), target, lock);
      for (const [name, text] of Object.entries({ ...scripts, [receiptName]: receipt }))
        writeFileSync(join(stage, name), text, { flag: "wx", mode: 0o600 });
      renameSync(stage, destination);
    }
    pointer = join(lock, "current");
    symlinkSync(target, pointer);
    if (!stat(state.launcher)) {
      stagedLauncher = join(lock, "launcher");
      writeFileSync(stagedLauncher, LAUNCHER, { flag: "wx", mode: 0o755 });
      chmodSync(stagedLauncher, 0o755);
      renameSync(stagedLauncher, state.launcher);
      stagedLauncher = undefined;
    }
    renameSync(pointer, current);
    pointer = undefined;
    return state.launcher;
  } finally {
    if (pointer) unlinkSync(pointer);
    if (stagedLauncher) unlinkSync(stagedLauncher);
    // Failed payload staging is retained. Never reclaim another installer's lock.
    rmdirSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app, target, digest, previous, ...extra] = process.argv.slice(2);
  try {
    if (extra.length) fail("unexpected arguments");
    const launcher = await install({ app, target, digest, previous, home: process.env.HOME });
    console.log(`Installed Shellbell ${target}. Launcher: ${launcher}`);
    console.log(
      "Add ~/.local/bin to PATH if needed. Existing identities, pairings and services are unchanged.",
    );
    console.log(
      "For a new Mac: shellbell start. Optional login service: shellbell service install.",
    );
    console.log(
      "Existing services keep their previous runtime. Stop and reinstall the service explicitly when ready to switch.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
