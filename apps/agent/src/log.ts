import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
} from "node:fs";
import { writeSecretFile } from "./config.js";

export type Level = "debug" | "info" | "warn" | "error";

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "ProtocolError",
  "BackendUnavailable",
  "SessionGone",
  "Unsupported",
  "BadWindow",
  "HerdrError",
  "ITerm2AuthError",
  "ConfigEditError",
  "NativeControllerError",
  "ControlV2ClientError",
]);

/** Error messages, custom names and coercion can all contain terminal content or credentials. */
export function safeErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "unknown";
    const name = error.name;
    return typeof name === "string" && SAFE_ERROR_NAMES.has(name) ? name : "Error";
  } catch {
    return "unknown";
  }
}
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const MAX_BYTES = 1_048_576;
const KEEP = 5;

function ownedLog(stat: Stats): boolean {
  return stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1;
}

function sameLog(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function appendPrivate(file: string, line: string): void {
  let fd: number | undefined;
  try {
    let before: Stats | undefined;
    try {
      before = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (before && !ownedLog(before)) return;
    fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (before ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    const opened = fstatSync(fd);
    const current = lstatSync(file);
    if (
      !ownedLog(opened) ||
      !ownedLog(current) ||
      !sameLog(opened, current) ||
      (before && !sameLog(before, opened))
    )
      return;
    fchmodSync(fd, 0o600);
    appendFileSync(fd, line);
  } catch {
    // Logging must not crash the agent or mutate an inadmissible destination.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

function rotate(file: string): void {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!ownedLog(before) || before.size < MAX_BYTES) return;
    // launchd holds an append descriptor to this inode. Renaming the active
    // path would leave inherited stdout/stderr writing to an old archive.
    fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const active = fstatSync(fd);
    if (!ownedLog(active) || !sameLog(before, active) || active.size < MAX_BYTES) return;
    fchmodSync(fd, 0o600);

    // Bound both memory use and archive size even if a writer emits one huge
    // burst. A concurrent append can still race with this best-effort copy.
    const start = Math.max(0, active.size - MAX_BYTES);
    const tail = Buffer.alloc(active.size - start);
    for (let offset = 0; offset < tail.length; ) {
      const count = readSync(fd, tail, offset, tail.length - offset, start + offset);
      if (count === 0) return; // truncated by another writer; do not discard data
      offset += count;
    }

    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    writeSecretFile(`${file}.1`, tail);

    // Do not truncate an inode whose active pathname was replaced meanwhile.
    const current = lstatSync(file);
    if (ownedLog(current) && sameLog(current, active) && ownedLog(fstatSync(fd))) {
      ftruncateSync(fd, 0);
    }
  } catch {
    // best effort
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // disk problems must never crash the agent
      }
    }
  }
}

export function createLogger(
  opts: { file?: string; verbose?: boolean; stdout?: boolean },
  base: Record<string, unknown> = {},
): Logger {
  const stdout = opts.stdout ?? process.stdout.isTTY === true;
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (level === "debug" && !opts.verbose) return;
    const rec = { t: new Date().toISOString(), level, msg, ...base, ...fields };
    if (opts.file) {
      rotate(opts.file);
      try {
        appendPrivate(opts.file, `${JSON.stringify(rec)}\n`);
      } catch {
        // disk problems must never crash the agent
      }
    }
    if (stdout) {
      const extra = Object.keys({ ...base, ...fields }).length
        ? ` ${JSON.stringify({ ...base, ...fields })}`
        : "";
      const line = `${rec.t.slice(11, 19)} ${level.padEnd(5)} ${msg}${extra}`;
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}
