import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Content-free failures shared by inspection, selection and adoption. */
export class HostFileError extends Error {
  constructor(public readonly kind: "unsafe" | "invalid" | "missing") {
    super(
      `shellbell: ${kind} Linux host state; inspect ownership, permissions and host initialization`,
    );
  }
}
export function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new HostFileError("unsafe");
  }
}
export function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export function privateDirectory(path: string, uid: number): Stats {
  const st = optionalStat(path);
  if (!st) throw new HostFileError("missing");
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o700)
    throw new HostFileError("unsafe");
  return st;
}
/** Resolve existing ancestors without requiring or creating the destination. */
export function canonicalDestination(path: string): string {
  const absolute = resolve(path);
  const st = optionalStat(absolute);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new HostFileError("unsafe");
    return realpathSync(absolute);
  }
  return join(realAncestor(dirname(absolute)), basename(absolute));
}
function realAncestor(path: string): string {
  if (optionalStat(path)) {
    try {
      return realpathSync(path);
    } catch {
      throw new HostFileError("unsafe");
    }
  }
  return join(realAncestor(dirname(path)), basename(path));
}
/** Fixed-size allocation; pathname and descriptor identity checked on both sides of reading. */
export function boundedRead(
  path: string,
  limit: number,
  uid?: number,
  overflowProbe = true,
): Buffer {
  let fd: number | undefined;
  try {
    const before = optionalStat(path);
    if (!before) throw new HostFileError("missing");
    const check = (st: Stats) => {
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        (uid !== undefined && (st.uid !== uid || (st.mode & 0o7777) !== 0o600))
      )
        throw new HostFileError("unsafe");
      if (st.size > limit) throw new HostFileError("invalid");
    };
    check(before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    check(opened);
    if (!sameFile(before, opened)) throw new HostFileError("unsafe");
    // Machine-ID reads are capped at 256 total bytes; private state additionally
    // probes one byte beyond its accepted bound to detect growth during reads.
    const bytes = Buffer.alloc(limit + (overflowProbe ? 1 : 0));
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (n === 0) break;
      count += n;
    }
    const after = fstatSync(fd);
    const current = optionalStat(path);
    check(after);
    if (
      !current ||
      !sameFile(opened, current) ||
      !sameFile(opened, after) ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    )
      throw new HostFileError("unsafe");
    check(current);
    if (count > limit || count !== after.size) throw new HostFileError("invalid");
    return bytes.subarray(0, count);
  } catch (error) {
    if (error instanceof HostFileError) throw error;
    throw new HostFileError("unsafe");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
