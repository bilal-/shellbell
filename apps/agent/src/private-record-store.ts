import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { processAlive, validPid } from "./control-guard.js";
import {
  boundedRead,
  HostFileError,
  optionalStat,
  privateDirectory,
  sameFile,
} from "./host-files.js";
import { NativePathSchema } from "./local-path-schema.js";
import { NativeControllerError } from "./native/protocol.js";
export interface PrivateRecordTransaction<R extends { revision: string }> {
  readonly current: R | null;
  publish(record: Omit<R, "revision">): R;
}
interface Snapshot<R> {
  record: R | null;
  stat: Stats | undefined;
  bytes: Buffer | null;
}
interface Guard {
  assert(): void;
  release(): void;
}
function unsafe(): never {
  throw new NativeControllerError("unsafe-state");
}
function sameMetadata(a: Stats, b: Stats): boolean {
  return (
    sameFile(a, b) &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode &&
    a.uid === b.uid
  );
}
function nativeError(error: unknown): NativeControllerError {
  return error instanceof NativeControllerError
    ? error
    : new NativeControllerError(
        error instanceof HostFileError ? "unsafe-state" : "operation-failed",
      );
}

/** Owner-private, cooperative local POSIX storage. Metadata checks detect path
 * replacement but cannot provide filesystem CAS against a malicious same-user
 * writer between the final check and rename. Callers must hold this transaction
 * across the entire async lifecycle operation; published transitions survive failure. */
export class PrivateRecordStore<R extends { revision: string }> {
  private readonly root: string;
  private readonly path: string;
  private readonly uid: number;
  private readonly newId: () => string;
  constructor(
    private readonly options: {
      root: string;
      uid: number;
      filename: string;
      maxBytes: number;
      schema: z.ZodType<R>;
      newId?: () => string;
    },
  ) {
    if (
      !NativePathSchema.safeParse(options.root).success ||
      !Number.isSafeInteger(options.uid) ||
      options.uid < 0
    )
      unsafe();
    // lstat("link/") follows the final symlink on POSIX. Strip trailing slashes
    // before checking components; do not resolve away potentially unsafe ancestors.
    this.root = options.root.replace(/\/+$/, "") || "/";
    this.path = join(this.root, options.filename);
    this.uid = options.uid;
    this.newId = options.newId ?? randomUUID;
  }
  inspect(): R | null {
    try {
      this.checkAncestors();
      if (!optionalStat(this.root)) return null;
      return this.readSnapshot(privateDirectory(this.root, this.uid)).record;
    } catch {
      return unsafe();
    }
  }
  async mutate<T>(
    expectedRevision: string | null,
    action: (tx: PrivateRecordTransaction<R>) => Promise<T>,
  ): Promise<T> {
    let guard: Guard | undefined;
    let rootFd: number | undefined;
    let active = true;
    try {
      this.checkAncestors();
      if (!optionalStat(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const root = privateDirectory(this.root, this.uid);
      rootFd = openSync(
        this.root,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      if (!sameFile(root, fstatSync(rootFd))) unsafe();
      guard = this.acquireGuard(root);
      let snapshot = this.readSnapshot(root);
      if ((snapshot.record?.revision ?? null) !== expectedRevision)
        throw new NativeControllerError("conflict");
      const tx: PrivateRecordTransaction<R> = {
        get current() {
          return structuredClone(snapshot.record);
        },
        publish: (next) => {
          if (!active) throw new NativeControllerError("operation-failed");
          try {
            const parsed = this.options.schema.safeParse({ ...next, revision: this.newId() });
            if (!parsed.success || parsed.data.revision === snapshot.record?.revision) unsafe();
            const bytes = Buffer.from(JSON.stringify(parsed.data));
            if (bytes.length > this.options.maxBytes) unsafe();
            this.publish(bytes, root, snapshot, () => guard!.assert());
            fsyncSync(rootFd!);
            snapshot = this.readSnapshot(root);
            return structuredClone(parsed.data);
          } catch (error) {
            throw nativeError(error);
          }
        },
      };
      return await action(tx);
    } catch (error) {
      throw nativeError(error);
    } finally {
      active = false;
      try {
        guard?.release();
      } finally {
        if (rootFd !== undefined) closeSync(rootFd);
      }
    }
  }
  private checkAncestors(): void {
    let path = this.root;
    for (;;) {
      const stat = optionalStat(path);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) unsafe();
      const parent = dirname(path);
      if (parent === path) return;
      path = parent;
    }
  }
  private checkRoot(root: Stats): void {
    this.checkAncestors();
    if (!sameFile(root, privateDirectory(this.root, this.uid))) unsafe();
  }
  private readSnapshot(root: Stats): Snapshot<R> {
    this.checkRoot(root);
    const before = optionalStat(this.path);
    if (!before) {
      this.checkRoot(root);
      return { record: null, stat: undefined, bytes: null };
    }
    const bytes = boundedRead(this.path, this.options.maxBytes, this.uid);
    const stat = optionalStat(this.path);
    if (!stat || !sameMetadata(before, stat)) unsafe();
    this.checkRoot(root);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return unsafe();
    }
    const result = this.options.schema.safeParse(value);
    if (!result.success) return unsafe();
    return { record: result.data, stat, bytes };
  }
  private checkSnapshot(root: Stats, expected: Snapshot<R>): void {
    const current = this.readSnapshot(root);
    if (
      expected.stat
        ? !current.stat ||
          !sameMetadata(expected.stat, current.stat) ||
          !expected.bytes?.equals(current.bytes!)
        : current.stat !== undefined
    )
      unsafe();
  }
  private publish(
    bytes: Buffer,
    root: Stats,
    snapshot: Snapshot<R>,
    assertGuard: () => void,
  ): void {
    assertGuard();
    this.checkSnapshot(root, snapshot);
    const staging = `${this.path}.tmp-${randomUUID()}`;
    let fd: number | undefined;
    let owned: Stats | undefined;
    try {
      fd = openSync(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      owned = fstatSync(fd);
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (count <= 0) throw new NativeControllerError("operation-failed");
        offset += count;
      }
      fsyncSync(fd);
      const written = fstatSync(fd);
      this.checkSnapshot(root, snapshot);
      const current = optionalStat(staging);
      if (
        !current ||
        !sameFile(owned, written) ||
        !sameMetadata(written, current) ||
        !current.isFile() ||
        current.uid !== this.uid ||
        (current.mode & 0o7777) !== 0o600 ||
        written.size !== bytes.length
      )
        unsafe();
      assertGuard();
      renameSync(staging, this.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Never unlink an entry unless this call created it and still owns it.
      try {
        this.checkRoot(root);
        const current = optionalStat(staging);
        if (owned && current && sameFile(owned, current)) unlinkSync(staging);
      } catch {
        /* Preserve ambiguous entries. */
      }
    }
  }
  private acquireGuard(root: Stats): Guard {
    const guard = `${this.path}.lock`;
    const marker = `owner-${process.pid}-${randomUUID()}`;
    const candidate = `${this.path}.lock-candidate-${marker.slice(6)}`;
    let candidateStat: Stats | undefined;
    let markerStat: Stats | undefined;
    let published = false;
    const removeOwned = (
      directory: string,
      identity: Stats,
      ownedMarker = marker,
      ownedStat = markerStat,
    ): boolean => {
      try {
        this.checkRoot(root);
        if (!sameFile(identity, privateDirectory(directory, this.uid))) return false;
        let current = optionalStat(join(directory, ownedMarker));
        if (current && (!ownedStat || !sameMetadata(ownedStat, current))) return false;
        if (directory === guard) {
          if (!current || !ownedStat) return false;
          const retired = `${this.path}.lock-candidate-${ownedMarker.slice(6)}`;
          if (optionalStat(retired)) return false;
          // Withdraw the complete published guard before removing its marker.
          // Credential readers never observe an empty published lock.
          renameSync(directory, retired);
          directory = retired;
          if (!sameFile(identity, privateDirectory(directory, this.uid))) return false;
          current = optionalStat(join(directory, ownedMarker));
          if (!current || !sameMetadata(ownedStat, current)) return false;
        }
        if (current) unlinkSync(join(directory, ownedMarker));
        rmdirSync(directory);
        return true;
      } catch {
        // A replaced/ambiguous owner is never ours to clean up.
        return false;
      }
    };
    try {
      this.checkRoot(root);
      mkdirSync(candidate, { mode: 0o700 });
      candidateStat = privateDirectory(candidate, this.uid);
      const fd = openSync(join(candidate, marker), "wx", 0o600);
      try {
        markerStat = fstatSync(fd);
      } finally {
        closeSync(fd);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        this.checkRoot(root);
        if (optionalStat(guard)) {
          const identity = privateDirectory(guard, this.uid);
          const entries = readdirSync(guard);
          const name = entries[0];
          const match =
            name &&
            /^owner-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
              name,
            );
          const pid = match && validPid(match[1]!);
          if (entries.length !== 1 || !name || !pid) unsafe();
          const observed = optionalStat(join(guard, name));
          boundedRead(join(guard, name), 0, this.uid);
          if (processAlive(pid)) throw new NativeControllerError("busy");
          if (!sameFile(identity, privateDirectory(guard, this.uid))) unsafe();
          const current = optionalStat(join(guard, name));
          if (!observed || !current || !sameMetadata(observed, current)) unsafe();
          // Preserve the same withdrawal order when retiring a dead owner.
          if (!removeOwned(guard, identity, name, observed)) unsafe();
        }
        try {
          renameSync(candidate, guard);
          published = true;
          const identity = privateDirectory(guard, this.uid);
          if (!sameFile(candidateStat, identity)) unsafe();
          return {
            assert: () => {
              this.checkRoot(root);
              if (!sameFile(identity, privateDirectory(guard, this.uid))) unsafe();
              const current = optionalStat(join(guard, marker));
              if (!current || !markerStat || !sameMetadata(markerStat, current)) unsafe();
            },
            release: () => removeOwned(guard, identity),
          };
        } catch (error) {
          if (
            !["EEXIST", "ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
          )
            throw error;
        }
      }
      throw new NativeControllerError("busy");
    } finally {
      if (!published && candidateStat) removeOwned(candidate, candidateStat);
    }
  }
}
