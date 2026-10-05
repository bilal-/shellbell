import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { acquireControlGuard } from "./control-guard.js";
import {
  boundedRead,
  HostFileError,
  optionalStat,
  privateDirectory,
  sameFile,
} from "./host-files.js";
import { type LinuxPaths, prepareLinuxRuntime } from "./host-paths.js";
import {
  readLinuxConfig,
  readLinuxPairings,
  requireLinuxState,
  validatedPairings,
} from "./host-state.js";
import {
  type AgentConfig,
  AgentConfigSchema,
  type Pairing,
  PairingsFile,
  preservePairProtocolFloor,
} from "./state-schema.js";

export {
  type AgentConfig,
  AgentConfigSchema,
  type Pairing,
  PairingSchema,
} from "./state-schema.js";

export const DEFAULT_RELAY = "wss://relay.shellbell.dev";
export const ACCENTS = [
  "emerald",
  "blue",
  "amber",
  "violet",
  "rose",
  "cyan",
  "lime",
  "orange",
] as const;

export interface Paths {
  dir: string;
  serviceOwner: string;
  identity: string;
  pairings: string;
  config: string;
  log: string;
  sock: string;
  pid: string;
  runtimeDir?: string;
  linuxHost?: { uid: number; hostDigest: string; hostScope: string };
}

export function paths(dir = process.env.SHELLBELL_DIR ?? join(homedir(), ".shellbell")): Paths {
  return {
    dir,
    serviceOwner: join(dir, "service-owner.json"),
    identity: join(dir, "identity.json"),
    pairings: join(dir, "pairings.json"),
    config: join(dir, "config.json"),
    log: join(dir, "agent.log"),
    sock: join(dir, "agent.sock"),
    pid: join(dir, "agent.pid"),
  };
}

export function ensureDir(p: Paths): void {
  if (p.linuxHost) {
    requireLinuxState(p as LinuxPaths);
    return;
  }
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
}

/**
 * Writes `text` to `path` atomically: the file at `path` is either the old
 * content or the new content in full, never a partial write. Writes to a
 * sibling temp file, fsyncs it, then renames over the target. A pre-existing
 * staging entry is preserved and causes failure. On failure, remove only
 * a staging file created by this invocation (best effort), then rethrow.
 */
export function writeSecretFile(
  path: string,
  text: string | Uint8Array,
  beforePublish?: () => void,
): void {
  const tmp = `${path}.tmp-${process.pid}`;
  let owned: { dev: number; ino: number } | null = null;
  try {
    // Exclusive creation also rejects symlinks; a pre-existing staging entry
    // belongs to an unknown writer and must never be followed or removed.
    const fd = openSync(tmp, "wx", 0o600);
    const identity = fstatSync(fd);
    owned = { dev: identity.dev, ino: identity.ino };
    try {
      const bytes = typeof text === "string" ? Buffer.from(text) : text;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (count <= 0) throw new Error("atomic file write made no progress");
        offset += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    beforePublish?.();
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (owned) {
        const current = lstatSync(tmp);
        if (current.dev === owned.dev && current.ino === owned.ino) rmSync(tmp);
      }
    } catch {
      // best effort cleanup; the original error is what matters
    }
    throw err;
  }
}

/**
 * Reads and JSON-parses `path`, throwing a diagnostic `Error` naming the
 * file (never its content) if it cannot be read or is not valid JSON.
 */
export function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`shellbell: cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`shellbell: ${path} is not valid JSON`);
  }
}

export function defaultConfig(): AgentConfig {
  return {
    v: 1,
    relayUrl: DEFAULT_RELAY,
    computerName: hostname().replace(/\.local$/, "") || "Mac",
    accent: ACCENTS[0],
    notifyMinCommandMs: 10_000,
    idleQuietMs: 30_000,
    idleMinActiveMs: 1_500,
  };
}

export function readConfig(p: Paths): AgentConfig {
  return configIo(p, () => {
    validateConfigPaths(p);
    if (p.linuxHost) return readLinuxConfig(p as LinuxPaths);
    if (!optionalStat(p.dir)) return defaultConfig();
    const before = privateDirectory(p.dir, process.getuid!());
    if (!optionalStat(p.config)) return defaultConfig();
    const bytes = boundedRead(p.config, CONFIG_BYTES, process.getuid!());
    if (!sameFile(before, privateDirectory(p.dir, process.getuid!())))
      throw new HostFileError("unsafe");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ConfigEditError("invalid", p.config, "not valid JSON");
    }
    return validateConfig(p, value);
  });
}

export function loadConfig(p: Paths): AgentConfig {
  if (p.linuxHost) return readConfig(p);
  return withConfigGuard(p, () => {
    const cfg = readConfig(p);
    if (!optionalStat(p.config)) writeConfigUnlocked(p, cfg);
    return cfg;
  });
}

export function saveConfig(p: Paths, cfg: AgentConfig): void {
  editConfig(p, () => cfg);
}

const CONFIG_BYTES = 65_536;
export class ConfigEditError extends Error {
  constructor(
    readonly code: "busy" | "unsafe" | "invalid" | "io",
    path: string,
    detail: string = code,
  ) {
    super(`shellbell: config ${detail} at ${path}`);
    this.name = "ConfigEditError";
  }
}
function configIo<T>(p: Paths, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ConfigEditError) throw error;
    throw new ConfigEditError(
      error instanceof HostFileError ? (error.kind === "invalid" ? "invalid" : "unsafe") : "io",
      p.config,
    );
  }
}
function validateConfig(p: Paths, value: unknown): AgentConfig {
  const result = AgentConfigSchema.safeParse(value);
  if (!result.success) throw new ConfigEditError("invalid", p.config);
  return result.data;
}
function admitConfigState(p: Paths): void {
  if (p.linuxHost) {
    requireLinuxState(p as LinuxPaths);
    return;
  }
  privateDirectory(p.dir, process.getuid!());
}
function validateConfigPaths(p: Paths): void {
  if (
    [p.dir, p.config].some((path) => Buffer.byteLength(path) > 4096 || path.includes("\0")) ||
    dirname(resolve(p.config)) !== resolve(p.dir)
  )
    throw new ConfigEditError("unsafe", p.config);
}
function admitConfigGuards(key: string, uid: number): void {
  const prefix = `${basename(key)}.lock`;
  for (const name of readdirSync(dirname(key))) {
    if (name !== prefix && !name.startsWith(`${prefix}-candidate-`)) continue;
    const dir = join(dirname(key), name);
    // A cooperating owner may release between the directory listing and admission.
    if (!optionalStat(dir)) continue;
    privateDirectory(dir, uid);
    for (const entry of readdirSync(dir)) {
      const st = optionalStat(join(dir, entry));
      if (
        st &&
        (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o600)
      )
        throw new HostFileError("unsafe");
    }
  }
}
function withConfigGuard<T>(p: Paths, action: () => T): T {
  const release = configIo(p, () => {
    validateConfigPaths(p);
    if (!p.linuxHost && !optionalStat(p.dir)) {
      try {
        mkdirSync(p.dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    admitConfigState(p);
    let guardKey = p.config;
    if (p.linuxHost) {
      prepareLinuxRuntime(p as LinuxPaths);
      guardKey = join(
        p.runtimeDir!,
        `config-${createHash("sha256").update(p.config).digest("hex")}`,
      );
    }
    admitConfigGuards(guardKey, p.linuxHost?.uid ?? process.getuid!());
    try {
      return acquireControlGuard(guardKey);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Control endpoint busy"))
        throw new ConfigEditError("busy", p.config);
      if (error instanceof Error && error.message.startsWith("Invalid control guard"))
        throw new ConfigEditError("unsafe", p.config);
      throw error;
    }
  });
  let result: T;
  try {
    result = action();
  } catch (error) {
    try {
      release();
    } catch {
      /* Preserve the callback/admission failure unchanged. */
    }
    throw error;
  }
  configIo(p, release);
  return result;
}
function writeConfigUnlocked(p: Paths, cfg: AgentConfig): void {
  configIo(p, () => {
    const text = `${JSON.stringify(validateConfig(p, cfg), null, 2)}\n`;
    if (Buffer.byteLength(text) > CONFIG_BYTES) throw new ConfigEditError("invalid", p.config);
    writeSecretFile(p.config, text, () => {
      admitConfigState(p);
      readConfig(p);
    });
  });
}
/** Synchronous cooperative read/validate/edit/publish. Callback failures escape unchanged. */
export function editConfig(p: Paths, edit: (current: AgentConfig) => AgentConfig): AgentConfig {
  return withConfigGuard(p, () => {
    const next = edit(readConfig(p));
    const validated = validateConfig(p, next);
    writeConfigUnlocked(p, validated);
    return validated;
  });
}

export function loadPairings(p: Paths): Pairing[] {
  if (p.linuxHost) return readLinuxPairings(p as LinuxPaths);
  ensureDir(p);
  if (!existsSync(p.pairings)) return [];
  const result = PairingsFile.safeParse(readJsonFile(p.pairings));
  if (!result.success) {
    throw new Error(
      `shellbell: invalid pairings at ${p.pairings}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data.phones;
}

export function savePairings(p: Paths, phones: Pairing[]): Pairing[] {
  ensureDir(p);
  const previous = new Map(loadPairings(p).map((pair) => [pair.phoneFp, pair]));
  const merged = phones.map((pair) => preservePairProtocolFloor(previous.get(pair.phoneFp), pair));
  const validated = PairingsFile.parse({ v: 1, phones: merged });
  const bytes = `${JSON.stringify(validated, null, 2)}\n`;
  if (p.linuxHost) {
    if (Buffer.byteLength(bytes) > 1048576)
      throw new Error("shellbell: Linux pairings exceed their state size limit");
    validatedPairings(Buffer.from(bytes));
  }
  writeSecretFile(
    p.pairings,
    bytes,
    p.linuxHost ? () => requireLinuxState(p as LinuxPaths) : undefined,
  );
  return validated.phones;
}
