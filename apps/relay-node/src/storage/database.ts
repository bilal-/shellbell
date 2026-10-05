import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FpSchema } from "@shellbell/protocol";
import type { IdentityStore, NotificationStore } from "@shellbell/relay-core";
import { createNodeIdentityStore } from "./identity-store.js";
import { createNodeNotificationStore } from "./notification-store.js";
import { acquireOwnership, privateDirectory, privateFile } from "./ownership.js";
import { initializeSchema } from "./schema.js";

export interface RelayDatabaseOptions {
  /** Synchronous live-session query; no provider I/O or database mutations. */
  attentive(computerFp: string, phoneFp: string, now: number): boolean;
  randomId?(): string;
}
export interface RelayDatabase {
  identity(computerFp: string): IdentityStore;
  notifications(computerFp: string): NotificationStore;
  /** Includes orphaned durable work, so a lost scheduler update cannot strand jobs. */
  computers(): string[];
  deadlines(): { computerFp: string; deadline: number }[];
  setDeadline(computerFp: string, deadline: number | null): void;
  close(): Promise<void>;
}
/** Concrete Node handle, not a cross-runtime SQL port. No transaction body may yield. */
export interface NodeDatabase {
  db: DatabaseSync;
  assertOpen(): void;
  transaction<T>(action: () => T): T;
}

export function openRelayDatabase(dataDir: string, options: RelayDatabaseOptions): RelayDatabase {
  if (typeof options?.attentive !== "function")
    throw new Error("Relay database requires synchronous attentive callback");
  if (process.versions.node !== "22.23.1")
    throw new Error("Standalone relay requires Node 22.23.1");
  const dir = privateDirectory(dataDir);
  const release = acquireOwnership(dir);
  let db: DatabaseSync | undefined;
  try {
    const path = join(dir, "relay.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      privateFile(path + suffix, suffix === "");
    db = new DatabaseSync(path, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    });
    // Check/migrate before WAL changes, so unsupported databases remain untouched.
    initializeSchema(db);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000; PRAGMA journal_size_limit = 67108864; PRAGMA trusted_schema = OFF",
    );
    const connection = db;
    let closed = false;
    const context: NodeDatabase = {
      db: connection,
      assertOpen() {
        if (closed) throw new Error("Relay database is closed");
      },
      transaction(action) {
        context.assertOpen();
        connection.exec("BEGIN IMMEDIATE");
        try {
          const result = action();
          if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("SQLite transaction must be synchronous");
          connection.exec("COMMIT");
          return result;
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      },
    };
    return {
      computers() {
        context.assertOpen();
        return connection
          .prepare(`SELECT computer_fp FROM computer
          UNION SELECT computer_fp FROM push_jobs
          UNION SELECT computer_fp FROM push_accepted
          UNION SELECT computer_fp FROM pairing_window
          UNION SELECT computer_fp FROM computer_deadlines`)
          .all()
          .map((row) => FpSchema.parse(row.computer_fp));
      },
      deadlines() {
        context.assertOpen();
        return connection
          .prepare("SELECT computer_fp, deadline FROM computer_deadlines ORDER BY computer_fp")
          .all()
          .map((row) => {
            if (!Number.isSafeInteger(row.deadline) || Number(row.deadline) < 0)
              throw new Error("Invalid stored deadline");
            return { computerFp: FpSchema.parse(row.computer_fp), deadline: Number(row.deadline) };
          });
      },
      setDeadline(computerFp, deadline) {
        context.assertOpen();
        FpSchema.parse(computerFp);
        if (deadline === null) {
          connection
            .prepare("DELETE FROM computer_deadlines WHERE computer_fp = ?")
            .run(computerFp);
        } else {
          if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error("Invalid deadline");
          connection
            .prepare(`INSERT INTO computer_deadlines(computer_fp, deadline) VALUES (?, ?)
            ON CONFLICT(computer_fp) DO UPDATE SET deadline=excluded.deadline`)
            .run(computerFp, deadline);
        }
      },
      identity(computerFp) {
        context.assertOpen();
        return createNodeIdentityStore(context, FpSchema.parse(computerFp));
      },
      notifications(computerFp) {
        context.assertOpen();
        FpSchema.parse(computerFp);
        return createNodeNotificationStore(context, {
          computerFp,
          attentive(phoneFp, now) {
            const value = options.attentive(computerFp, phoneFp, now);
            if (typeof value !== "boolean")
              throw new Error("attentive callback must return a boolean synchronously");
            return value;
          },
          randomId: options.randomId ?? randomUUID,
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        // Keep ownership if database close fails; another process must never overlap it.
        connection.close();
        release();
      },
    };
  } catch (error) {
    db?.close();
    release();
    throw error;
  }
}
