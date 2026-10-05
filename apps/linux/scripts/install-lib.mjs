import { execFile, execFileSync } from "node:child_process";
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
import { promisify } from "node:util";
import { fail, validVersion, verifyPayload } from "./payload.mjs";

export const LAUNCHER = `#!/bin/sh
# Shellbell managed archive launcher v1. Do not edit.
set -eu
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Shellbell: unsupported CPU architecture' >&2; exit 1 ;;
esac
test -n "$HOME" || { echo 'Shellbell: HOME is required' >&2; exit 1; }
base="$HOME/.local/share/shellbell/installs/linux-$arch"
version=$(readlink "$base/current") || { echo 'Shellbell: no installed version for this CPU' >&2; exit 1; }
case "$version" in ''|*[!0-9A-Za-z.-]*|.*|*..*) echo 'Shellbell: invalid installation pointer' >&2; exit 1 ;; esac
unset NODE_OPTIONS NODE_PATH
exec "$base/$version/runtime/bin/node" "$base/$version/agent/dist/cli.js" "$@"
`;

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function refuseReferences({ home, root, uid }) {
  if (process.platform !== "linux") fail("removal-requires-linux");
  // Also inspect disabled units: their pinned runtime must remain startable.
  const directories = new Set([
    join(home, ".config/systemd/user.control"),
    join(home, ".config/systemd/user"),
    join(home, ".local/share/systemd/user"),
    "/etc/xdg/systemd/user",
    "/etc/systemd/user",
    "/run/systemd/user",
    "/usr/local/share/systemd/user",
    "/usr/share/systemd/user",
    "/usr/local/lib/systemd/user",
    "/usr/lib/systemd/user",
    "/lib/systemd/user",
  ]);
  function add(path) {
    if (!isAbsolute(path)) fail("invalid-unit-search-path");
    directories.add(path);
  }
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    if (!process.env[key]) continue;
    add(join(process.env[key], "systemd/user"));
    if (key === "XDG_CONFIG_HOME") add(join(process.env[key], "systemd/user.control"));
  }
  for (const key of ["XDG_CONFIG_DIRS", "XDG_DATA_DIRS"])
    for (const path of (process.env[key] ?? "").split(":"))
      if (path) add(join(path, "systemd/user"));
  for (const runtime of new Set([`/run/user/${uid}`, process.env.XDG_RUNTIME_DIR].filter(Boolean)))
    for (const name of [
      "user",
      "user.control",
      "transient",
      "generator.early",
      "generator",
      "generator.late",
    ])
      add(join(runtime, "systemd", name));
  for (const path of (process.env.SYSTEMD_UNIT_PATH ?? "").split(":")) if (path) add(path);
  // Ask the installed systemd build too: distro-specific compiled search paths
  // need not match our fallback. No running manager is required for this query.
  const analyzer = "/usr/bin/systemd-analyze";
  if (stat(analyzer)) {
    const paths = execFileSync(analyzer, ["--user", "unit-paths"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const path of paths.trim().split("\n")) if (path) add(path);
  }
  let count = 0;
  const visited = new Set();
  function inspect(path) {
    if (++count > 10000) fail("service-inspection-limit");
    const st = stat(path);
    if (!st) return;
    if (st.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (target.includes(root)) fail("service-references-installation");
      const canonical = realpathSync(path);
      if (canonical === "/dev/null") return; // unrelated masked unit
      if (visited.has(canonical)) return;
      visited.add(canonical);
      inspect(canonical);
    } else if (st.isDirectory()) {
      for (const name of readdirSync(path)) inspect(join(path, name));
    } else if (st.isFile()) {
      if (st.size > 1024 * 1024) fail("service-inspection-limit");
      const text = readFileSync(path, "utf8");
      const decoded = text.replace(/\\x([a-fA-F0-9]{2})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
      // Systemd may escape spaces; shellbell-named units are conservatively
      // refused even when their exact invocation is not recognizable here.
      if (
        path.toLowerCase().includes("shellbell") ||
        decoded.toLowerCase().includes("shellbell") ||
        text.includes(root) ||
        text.includes(root.replaceAll(" ", "\\x20"))
      )
        fail("service-references-installation");
    } else fail("unsupported-service-entry");
  }
  for (const dir of directories) inspect(dir);
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const path = join("/proc", pid);
    try {
      if (lstatSync(path).uid !== uid) continue;
      const command = readFileSync(join(path, "cmdline"), "utf8");
      if (command.includes(root)) fail("process-references-installation");
      const exe = readlinkSync(join(path, "exe"));
      if (exe === root || exe.startsWith(`${root}/`)) fail("process-references-installation");
    } catch (error) {
      // A process may exit between enumeration and inspection. All other
      // failures deny deletion, including unreadable same-user processes.
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
}

export async function removeInstallation({ home }) {
  const installation = prepare(home);
  const { root, launcher, uid } = installation;
  if (!stat(launcher)) fail("managed-launcher-missing");
  const lock = join(root, ".install.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    const removals = [];
    const pointers = [];
    const bases = [];
    for (const archName of readdirSync(root)) {
      if (archName === ".install.lock") continue;
      if (!["linux-x64", "linux-arm64"].includes(archName)) fail("unmanaged-install-entry");
      const base = join(root, archName);
      safeDirectory(base, uid);
      bases.push(base);
      for (const version of readdirSync(base)) {
        const path = join(base, version);
        if (version === "current") {
          const st = lstatSync(path);
          if (!st.isSymbolicLink() || st.uid !== uid || !validVersion(readlinkSync(path)))
            fail("invalid-current-pointer");
          pointers.push(path);
          continue;
        }
        if (!validVersion(version)) fail("unmanaged-install-entry");
        safeDirectory(path, uid);
        const manifest = await verifyPayload(path, { arch: archName.slice(6), version });
        const files = [...Object.keys(manifest.files), "inventory.json"];
        const dirs = new Set([path]);
        for (const file of files) {
          let dir = dirname(join(path, file));
          while (dir !== path) {
            dirs.add(dir);
            dir = dirname(dir);
          }
          if (lstatSync(join(path, file)).uid !== uid) fail("foreign-install-file");
        }
        // Refuse untracked empty directories too; deletion only consumes the
        // exact directories implied by the inventory, never arbitrary trees.
        for (const dir of dirs) {
          safeDirectory(dir, uid);
          for (const child of readdirSync(dir)) {
            const full = join(dir, child);
            if (lstatSync(full).isDirectory() && !dirs.has(full)) fail("unmanaged-install-entry");
          }
        }
        removals.push({ path, files, dirs: [...dirs].sort((a, b) => b.length - a.length) });
      }
    }
    refuseReferences(installation);
    // No recursive deletion: every leaf and directory was enumerated above.
    for (const { path, files, dirs } of removals) {
      for (const file of files) unlinkSync(join(path, file));
      for (const dir of dirs) rmdirSync(dir);
    }
    for (const pointer of pointers) unlinkSync(pointer);
    for (const base of bases) rmdirSync(base);
    unlinkSync(launcher);
    return { removedVersions: removals.length };
  } finally {
    rmdirSync(lock);
  }
}
function owner() {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0 || process.geteuid() !== uid) fail("non-root-user-required");
  return uid;
}
function safeDirectory(path, uid, create = false) {
  if (create && !stat(path)) mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || st.mode & 0o7022)
    fail("unsafe-install-directory");
}
function prepare(home) {
  const uid = owner();
  if (!isAbsolute(home ?? "") || resolve(home) === "/") fail("invalid-home");
  safeDirectory(home, uid);
  // Canonicalize the explicitly selected home; never follow aliases below it.
  const canonical = realpathSync(home);
  for (let ancestor = dirname(canonical); ; ancestor = dirname(ancestor)) {
    const st = lstatSync(ancestor);
    const trustedSticky = st.uid === 0 && (st.mode & 0o1000) !== 0;
    if (
      !st.isDirectory() ||
      (st.uid !== uid && st.uid !== 0) ||
      ((st.mode & 0o022) !== 0 && !trustedSticky)
    )
      fail("unsafe-home-ancestor");
    if (ancestor === dirname(ancestor)) break;
  }
  let path = canonical;
  for (const name of [".local", "share", "shellbell", "installs"]) {
    path = join(path, name);
    safeDirectory(path, uid, true);
  }
  const root = path;
  const bin = join(canonical, ".local/bin");
  safeDirectory(bin, uid, true);
  const launcher = join(bin, "shellbell");
  const existing = stat(launcher);
  if (
    existing &&
    (!existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      existing.uid !== uid ||
      existing.mode & 0o7022 ||
      readFileSync(launcher, "utf8") !== LAUNCHER)
  )
    fail("unmanaged-launcher");
  return { home: canonical, uid, root, launcher };
}
function copyVerified(source, destination, inventory) {
  for (const name of [...Object.keys(inventory.files), "inventory.json"].sort()) {
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, readFileSync(join(source, name)), {
      flag: "wx",
      mode: name === "inventory.json" ? 0o644 : inventory.files[name].mode,
    });
    chmodSync(target, name === "inventory.json" ? 0o644 : inventory.files[name].mode);
  }
}
const exec = promisify(execFile);
async function probePayload(payload, inventory, parent) {
  const probe = mkdtempSync(join(parent, ".probe-"));
  try {
    const runtime = join(probe, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: probe,
      TMPDIR: probe,
      SHELLBELL_DIR: join(probe, "state"),
      XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: join(probe, "config"),
      XDG_DATA_HOME: join(probe, "data"),
      XDG_CACHE_HOME: join(probe, "cache"),
      XDG_STATE_HOME: join(probe, "state-home"),
    };
    for (const flag of ["--version", "--help"]) {
      let output;
      try {
        output = await exec(
          join(payload, "runtime/bin/node"),
          [join(payload, "agent/dist/cli.js"), flag],
          {
            cwd: probe,
            env,
            timeout: 5000,
            killSignal: "SIGKILL",
            maxBuffer: 256 * 1024,
          },
        );
      } catch {
        fail("cli-probe-failed");
      }
      if (flag === "--version" && output.stdout.trim() !== inventory.version)
        fail("cli-probe-version");
      if (flag === "--help" && !output.stdout.startsWith("Usage: shellbell"))
        fail("cli-probe-help");
    }
  } finally {
    // This exact private mkdtemp directory is solely a disposable probe HOME;
    // no real customer state or arbitrary parent directory is removed.
    rmSync(probe, { recursive: true, force: true });
  }
}
export async function installPayload({ payload, home }) {
  const admitted = await verifyPayload(payload);
  const installation = prepare(home);
  const lock = join(installation.root, ".install.lock");
  // No stale-lock reclamation: a failed owner must be inspected, not overwritten.
  mkdirSync(lock, { mode: 0o700 });
  let stage;
  let pointer;
  let launcherStage;
  try {
    const base = join(installation.root, `linux-${admitted.arch}`);
    safeDirectory(base, installation.uid, true);
    const current = join(base, "current");
    const existing = stat(current);
    if (existing) {
      if (!existing.isSymbolicLink() || existing.uid !== installation.uid)
        fail("invalid-current-pointer");
      const previous = readlinkSync(current);
      if (!validVersion(previous)) fail("invalid-current-pointer");
      safeDirectory(join(base, previous), installation.uid);
      await verifyPayload(join(base, previous), { arch: admitted.arch, version: previous });
    }
    const destination = join(base, admitted.version);
    if (stat(destination)) {
      safeDirectory(destination, installation.uid);
      const old = await verifyPayload(destination, {
        arch: admitted.arch,
        version: admitted.version,
      });
      if (JSON.stringify(old) !== JSON.stringify(admitted)) fail("immutable-version-conflict");
      await probePayload(destination, admitted, lock);
    } else {
      stage = mkdtempSync(join(base, ".staging-"));
      copyVerified(payload, stage, admitted);
      await verifyPayload(stage, { arch: admitted.arch, version: admitted.version });
      await probePayload(stage, admitted, lock);
      renameSync(stage, destination);
      stage = undefined;
    }
    // Stage both publications before switching the existing version. The only
    // overwrite is a previously validated managed symlink, never a user file.
    pointer = join(lock, "current");
    symlinkSync(admitted.version, pointer);
    if (!stat(installation.launcher)) {
      launcherStage = join(lock, "launcher");
      writeFileSync(launcherStage, LAUNCHER, { flag: "wx", mode: 0o755 });
      chmodSync(launcherStage, 0o755);
      renameSync(launcherStage, installation.launcher);
      launcherStage = undefined;
    }
    renameSync(pointer, current);
    pointer = undefined;
    return {
      version: admitted.version,
      arch: admitted.arch,
      location: destination,
      launcher: installation.launcher,
    };
  } finally {
    if (pointer) unlinkSync(pointer);
    if (launcherStage) unlinkSync(launcherStage);
    // Failed payload staging is preserved for diagnosis; never delete broadly.
    rmdirSync(lock);
  }
}
