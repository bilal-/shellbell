import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Paths } from "./config.js";
import {
  canonicalDestination,
  HostFileError,
  optionalStat,
  privateDirectory,
} from "./host-files.js";
import { readLinuxMachineIdentity } from "./host-machine.js";

export type LinuxPaths = Paths & {
  runtimeDir: string;
  linuxHost: { uid: number; hostDigest: string; hostScope: string };
};
export interface LinuxHostOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
  euid?: number;
  machineIdPath?: string;
  runtimeFsType?: (path: string) => number | bigint;
}
const runtimeFacts = new WeakMap<
  LinuxPaths,
  { root: string; fsType: (path: string) => number | bigint }
>();
const allowed = new Set([0x01021994, 0xef53, 0x58465342, 0x9123683e]);
function validateRuntime(p: LinuxPaths, create: boolean): void {
  const facts = runtimeFacts.get(p);
  const root = facts?.root ?? dirname(dirname(p.runtimeDir));
  const fsType = facts?.fsType ?? ((path: string) => statfsSync(path).type);
  try {
    privateDirectory(root, p.linuxHost.uid);
    if (!allowed.has(Number(fsType(root)))) throw new HostFileError("unsafe");
    for (const dir of [join(root, "shellbell"), p.runtimeDir]) {
      if (!optionalStat(dir)) {
        if (!create) continue;
        try {
          mkdirSync(dir, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      privateDirectory(dir, p.linuxHost.uid);
      if (!allowed.has(Number(fsType(dir)))) throw new HostFileError("unsafe");
    }
    if (optionalStat(p.runtimeDir)) validateEntries(p.runtimeDir, p.linuxHost.uid, 0, fsType);
  } catch {
    throw new Error(
      "shellbell: unsafe or unavailable Linux runtime; provide a private 0700 local XDG_RUNTIME_DIR",
    );
  }
}
function validateEntries(
  dir: string,
  uid: number,
  depth: number,
  fsType: (path: string) => number | bigint,
): void {
  // Guard trees are shallow. Refuse unexpected deep trees instead of unbounded traversal.
  if (depth > 2) throw new HostFileError("unsafe");
  const names = readdirSync(dir);
  if (names.length > 256) throw new HostFileError("unsafe");
  for (const name of names) {
    const path = join(dir, name);
    const st = optionalStat(path);
    if (!st || st.uid !== uid || st.isSymbolicLink()) throw new HostFileError("unsafe");
    if (st.isDirectory()) {
      privateDirectory(path, uid);
      if (!allowed.has(Number(fsType(path)))) throw new HostFileError("unsafe");
      validateEntries(path, uid, depth + 1, fsType);
    } else if ((!st.isFile() && !st.isSocket()) || (st.mode & 0o7777) !== 0o600)
      throw new HostFileError("unsafe");
  }
}
/** Adoption observes a sibling scope using the same qualified local runtime facts. */
export function validateLinuxRuntimeSibling(p: LinuxPaths, dir: string): void {
  if (dirname(dir) !== dirname(p.runtimeDir)) throw new HostFileError("unsafe");
  privateDirectory(dir, p.linuxHost.uid);
  const fsType = runtimeFacts.get(p)?.fsType ?? ((path: string) => statfsSync(path).type);
  if (!allowed.has(Number(fsType(dir)))) throw new HostFileError("unsafe");
  validateEntries(dir, p.linuxHost.uid, 0, fsType);
}
export function resolveLinuxPaths(options: LinuxHostOptions = {}): LinuxPaths {
  const { uid, hostDigest, hostScope } = readLinuxMachineIdentity(options);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const explicit = env.SHELLBELL_DIR;
  if (explicit !== undefined && !isAbsolute(explicit))
    throw new Error("shellbell: SHELLBELL_DIR must be absolute");
  const base =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : join(home, ".local", "state");
  const dir = canonicalDestination(explicit ?? join(base, "shellbell", "hosts", hostScope));
  if (optionalStat(dir)) privateDirectory(dir, uid);
  const root = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  if (!isAbsolute(root)) throw new Error("shellbell: XDG_RUNTIME_DIR must be absolute");
  const runtimeDir = join(
    resolve(root),
    "shellbell",
    createHash("sha256").update(dir).digest("hex").slice(0, 32),
  );
  const p: LinuxPaths = {
    dir,
    serviceOwner: join(dir, "service-owner.json"),
    identity: join(dir, "identity.json"),
    config: join(dir, "config.json"),
    pairings: join(dir, "pairings.json"),
    log: join(dir, "agent.log"),
    runtimeDir,
    sock: join(runtimeDir, "agent.sock"),
    pid: join(runtimeDir, "agent.pid"),
    linuxHost: { uid, hostDigest, hostScope },
  };
  if (Buffer.byteLength(p.sock) > 107)
    throw new Error(
      "shellbell: Linux socket path exceeds 107 bytes; choose a shorter XDG_RUNTIME_DIR",
    );
  runtimeFacts.set(p, {
    root: resolve(root),
    fsType: options.runtimeFsType ?? ((path) => statfsSync(path).type),
  });
  validateRuntime(p, false);
  return p;
}
export function prepareLinuxRuntime(p: LinuxPaths): void {
  validateRuntime(p, true);
}
