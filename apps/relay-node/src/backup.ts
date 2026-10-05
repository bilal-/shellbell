import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { openRelayDatabase } from "./storage/database.js";
import { acquireOwnership, privateDirectory, privateFile } from "./storage/ownership.js";

function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("An absolute canonical path is required");
}
function verify(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()!.user_version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5)
    throw new Error("Unsupported backup schema");
  if (
    db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").get()
  )
    throw new Error("Backup integrity check failed");
}
async function snapshot(source: string, destination: string): Promise<void> {
  canonical(destination);
  privateDirectory(dirname(destination));
  privateFile(source, false);
  for (const suffix of ["-wal", "-shm", "-journal"]) privateFile(source + suffix, false);
  const db = new DatabaseSync(source, { readOnly: true, allowExtension: false });
  try {
    verify(db);
    const fd = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await backup(db, destination);
      const copy = new DatabaseSync(destination, { readOnly: true, allowExtension: false });
      try {
        verify(copy);
      } finally {
        copy.close();
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = openSync(dirname(destination), constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    db.close();
  }
}
/** Offline OS-lock-owned consistent backup. Source v1 is not migrated. */
export async function backupRelay(source: string, destination: string): Promise<void> {
  canonical(destination);
  lstatSync(source);
  const dir = privateDirectory(source);
  // Guard the entire reserved subtree before snapshot can create its parent.
  const firstComponent = relative(dir, destination).split(sep)[0] ?? "";
  if (/^(relay|ownership)\.sqlite(?:-(wal|shm|journal))?$/.test(firstComponent))
    throw new Error("Reserved relay storage path cannot be a backup destination");
  lstatSync(join(dir, "relay.sqlite"));
  const release = acquireOwnership(dir);
  try {
    await snapshot(join(dir, "relay.sqlite"), destination);
  } finally {
    release();
  }
}
/** New directory only; failed/incomplete results are retained for inspection. */
export async function restoreRelay(source: string, destination: string): Promise<void> {
  canonical(source);
  canonical(destination);
  privateDirectory(dirname(source));
  privateDirectory(dirname(destination));
  lstatSync(source);
  mkdirSync(destination, { mode: 0o700 });
  await snapshot(source, join(destination, "relay.sqlite"));
  const database = openRelayDatabase(destination, { attentive: () => false });
  try {
    database.deadlines();
    for (const fp of database.computers()) {
      await database.identity(fp).computer();
      await database.identity(fp).pairings();
    }
  } finally {
    await database.close();
  }
}
