import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function privateEntry(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.geteuid?.() ||
    (!directory && stat.nlink !== 1)
  ) {
    throw new Error(`Insecure relay data path: ${path}`);
  }
}

/** Reject symbolic path components. Parents may be public but must not permit other users to rename children. */
export function privateDirectory(input: string): string {
  if (!isAbsolute(input) || resolve(input) !== input)
    throw new Error("Relay data directory must be an absolute canonical path");
  const root = parse(input).root;
  let current = root;
  for (const part of ["", ...relative(root, input).split("/").filter(Boolean)]) {
    current = join(current, part);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only create the final private directory; the operator owns parent provisioning.
      if (current !== input) throw new Error("Relay data directory parent must exist");
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Noncanonical relay data path: ${current}`);
    // A directory owner can replace children even when mode bits prohibit other writers.
    if (stat.uid !== 0 && stat.uid !== process.geteuid?.())
      throw new Error(`Untrusted owner of relay data parent: ${current}`);
    // A sticky temp parent protects this user's child from other users' renames.
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
      throw new Error(`Insecure relay data parent: ${current}`);
  }
  privateEntry(input, true);
  if (realpathSync(input) !== input) throw new Error("Noncanonical relay data directory");
  return input;
}

export function privateFile(path: string, create: boolean): void {
  try {
    privateEntry(path, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (create) {
      // Parent is private and checked before this call; do not follow or replace any existing entry.
      privateEntry(dirname(path), true);
      closeSync(
        openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        ),
      );
    }
  }
}

/** An OS-backed SQLite lock, never an unlinkable PID/lock-file convention. */
export function acquireOwnership(dir: string): () => void {
  const path = join(dir, "ownership.sqlite");
  privateFile(path, true);
  for (const suffix of ["-journal", "-wal", "-shm"]) privateFile(path + suffix, false);
  const owner = new DatabaseSync(path, { allowExtension: false, timeout: 0 });
  try {
    owner.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE");
  } catch (error) {
    owner.close();
    throw new Error("Relay data directory is already owned or cannot be locked", { cause: error });
  }
  return () => {
    owner.exec("ROLLBACK");
    owner.close();
  };
}
