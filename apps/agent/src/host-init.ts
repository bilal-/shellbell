import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  opendirSync,
  openSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { generateIdentity, identityToJson } from "@shellbell/protocol";
import { writeSecretFile } from "./config.js";
import { acquireControlGuard, processAlive, validPid } from "./control-guard.js";
import {
  boundedRead,
  canonicalDestination,
  HostFileError,
  optionalStat,
  privateDirectory,
  sameFile,
} from "./host-files.js";
import { type LinuxPaths, prepareLinuxRuntime, validateLinuxRuntimeSibling } from "./host-paths.js";
import { inspectLinuxState, readCredentialBytes } from "./host-state.js";
import { type AgentConfig, AgentConfigSchema } from "./state-schema.js";

export type HostInitMode =
  | { kind: "new" }
  | { kind: "adopt"; source: string; confirmSourceInactive: true };
export type HostInitResult = { status: "initialized" | "already-initialized"; stateDir: string };
/** Test seams: checkpoint throws to model failure; probes replace only local observations. */
export interface HostInitDependencies {
  checkpoint?: (point: string) => void;
  probeSocket?: (path: string) => Promise<"absent" | "active" | "ambiguous">;
  processAlive?: (pid: number) => boolean;
}
function probeSocket(path: string): Promise<"absent" | "active" | "ambiguous"> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (result: "absent" | "active" | "ambiguous") => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250, () => finish("ambiguous"));
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? "absent" : "ambiguous"),
    );
  });
}
async function sourceInactive(
  source: string,
  p: LinuxPaths,
  deps: HostInitDependencies,
): Promise<void> {
  const runtime = join(
    dirname(p.runtimeDir),
    createHash("sha256").update(source).digest("hex").slice(0, 32),
  );
  for (const dir of [source, runtime]) {
    if (!optionalStat(dir)) continue;
    privateDirectory(dir, p.linuxHost.uid);
    if (dir === runtime) validateLinuxRuntimeSibling(p, dir);
    const pidPath = join(dir, "agent.pid");
    if (optionalStat(pidPath)) {
      const pid = validPid(boundedRead(pidPath, 64, p.linuxHost.uid).toString("utf8").trim());
      if (!pid || (deps.processAlive ?? processAlive)(pid)) throw new HostFileError("unsafe");
    }
    // A guard candidate exists before publication and may not yet have an owner
    // marker. Its name alone is ambiguous activity evidence. Enumerate without
    // opening candidate entries, following symlinks, or reaping another owner.
    const guards = ["agent.sock.lock", "init.sock.lock", "service.lock"];
    const entries = opendirSync(dir);
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (
          guards.some(
            (guard) => entry.name === guard || entry.name.startsWith(`${guard}-candidate-`),
          )
        )
          throw new HostFileError("unsafe");
      }
    } finally {
      entries.closeSync();
    }
    const sock = join(dir, "agent.sock");
    if (Buffer.byteLength(sock) > 107) throw new HostFileError("unsafe");
    const st = optionalStat(sock);
    if (st && (!st.isSocket() || st.uid !== p.linuxHost.uid || (st.mode & 0o7777) !== 0o600))
      throw new HostFileError("unsafe");
    // Probing missing paths closes the ordinary lstat-to-connect race. Neither a
    // refused local endpoint nor confirmation proves inactivity on another host.
    if ((await (deps.probeSocket ?? probeSocket)(sock)) !== "absent")
      throw new HostFileError("unsafe");
  }
}
function syncDirectory(path: string, uid?: number): void {
  const before = uid === undefined ? optionalStat(path) : privateDirectory(path, uid);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!before || !sameFile(before, fstatSync(fd))) throw new HostFileError("unsafe");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function createParents(path: string, uid: number): void {
  const current = optionalStat(path);
  if (current) {
    if (!current.isDirectory() || current.isSymbolicLink()) throw new HostFileError("unsafe");
    return;
  }
  createParents(dirname(path), uid);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateDirectory(path, uid);
  syncDirectory(dirname(path));
}
export async function initializeLinuxHost(
  p: LinuxPaths,
  mode: HostInitMode,
  config: AgentConfig,
  deps: HostInitDependencies = {},
): Promise<HostInitResult> {
  let release: (() => void) | undefined;
  try {
    if (canonicalDestination(p.dir) !== p.dir) throw new HostFileError("unsafe");
    const first = inspectLinuxState(p);
    if (first.status === "ready") return { status: "already-initialized", stateDir: p.dir };
    if (first.status !== "absent") throw new HostFileError("unsafe");
    let adopted: ReturnType<typeof readCredentialBytes> | undefined;
    let source: string | undefined;
    let parsed: AgentConfig | undefined;
    if (mode.kind === "adopt") {
      if (mode.confirmSourceInactive !== true || !isAbsolute(mode.source))
        throw new HostFileError("unsafe");
      source = canonicalDestination(mode.source);
      if (source === p.dir) throw new HostFileError("unsafe");
      adopted = readCredentialBytes(source, p.linuxHost.uid);
      await sourceInactive(source, p, deps);
    } else if (mode.kind === "new") {
      parsed = AgentConfigSchema.parse(config);
      if (Buffer.byteLength(`${JSON.stringify(parsed, null, 2)}\n`) > 65536)
        throw new HostFileError("invalid");
    } else throw new HostFileError("invalid");
    prepareLinuxRuntime(p);
    release = acquireControlGuard(join(p.runtimeDir, "init.sock"));
    const second = inspectLinuxState(p);
    if (second.status === "ready") return { status: "already-initialized", stateDir: p.dir };
    if (second.status !== "absent") throw new HostFileError("unsafe");
    if (source) {
      await sourceInactive(source, p, deps);
      const current = readCredentialBytes(source, p.linuxHost.uid);
      if (
        !adopted ||
        !current.identity.equals(adopted.identity) ||
        !current.config.equals(adopted.config) ||
        !current.pairings.equals(adopted.pairings)
      )
        throw new HostFileError("unsafe");
    }
    createParents(dirname(p.dir), p.linuxHost.uid);
    if (canonicalDestination(p.dir) !== p.dir) throw new HostFileError("unsafe");
    mkdirSync(p.dir, { mode: 0o700 }); // exclusive: never rename over another owner
    const owned = privateDirectory(p.dir, p.linuxHost.uid);
    syncDirectory(dirname(p.dir));
    const checkOwned = () => {
      if (!sameFile(owned, privateDirectory(p.dir, p.linuxHost.uid)))
        throw new HostFileError("unsafe");
    };
    const bytes = adopted ?? {
      identity: Buffer.from(`${JSON.stringify(identityToJson(generateIdentity()), null, 2)}\n`),
      config: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`),
      pairings: Buffer.from('{"v":1,"phones":[]}\n'),
    };
    for (const name of ["identity", "config", "pairings"] as const) {
      deps.checkpoint?.(`before-${name}`);
      checkOwned();
      const path = join(p.dir, `${name}.json`);
      if (optionalStat(path)) throw new HostFileError("unsafe");
      writeSecretFile(path, bytes[name], () => {
        checkOwned();
        if (optionalStat(path)) throw new HostFileError("unsafe");
      });
      deps.checkpoint?.(`after-${name}`);
    }
    readCredentialBytes(p.dir, p.linuxHost.uid);
    syncDirectory(p.dir, p.linuxHost.uid);
    deps.checkpoint?.("before-marker");
    checkOwned();
    const marker = join(p.dir, "host.json");
    writeSecretFile(
      marker,
      `${JSON.stringify({ v: 1, hostDigest: p.linuxHost.hostDigest, installationId: randomUUID() })}\n`,
      () => {
        checkOwned();
        if (optionalStat(marker)) throw new HostFileError("unsafe");
      },
    );
    deps.checkpoint?.("after-marker");
    deps.checkpoint?.("before-directory-fsync");
    syncDirectory(p.dir, p.linuxHost.uid);
    deps.checkpoint?.("after-directory-fsync");
    return { status: "initialized", stateDir: p.dir };
  } catch {
    // Once published, the valid marker is preserved even when durability is
    // uncertain. A retry admits this identity; it must never invent a new one.
    throw new Error(
      `shellbell: host initialization failed; inspect ${p.dir} before retrying. Preserve existing credentials; move partial state aside only after explicit recovery. Adoption requires the source to be inactive on every host.`,
    );
  } finally {
    release?.();
  }
}
