import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  notice,
  tokenMessage,
} from "../../../packages/relay-core/test-support/notification-store-contract.js";
import { backupRelay, restoreRelay } from "../src/backup.js";
import { openRelayDatabase } from "../src/storage/database.js";
import { computerFixture, fixture, temporaryDirectory } from "./helpers.js";

it("refuses active owners and existing backup destinations without replacing bytes", async () => {
  const h = fixture();
  const archive = temporaryDirectory();
  const path = join(archive, "backup.sqlite");
  try {
    await expect(backupRelay(h.dir, path)).rejects.toThrow(/owned|lock/);
    await h.database.close();
    await backupRelay(h.dir, path);
    const bytes = readFileSync(path);
    await expect(backupRelay(h.dir, path)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    await h.close();
    rmSync(archive, { recursive: true });
  }
});

it("restores registrations, queued jobs, budgets and deadlines into a new private directory", async () => {
  const h = fixture();
  const archive = temporaryDirectory();
  const snapshot = join(archive, "backup.sqlite");
  const destination = join(archive, "restored");
  const computer = computerFixture();
  const phone = computerFixture(51);
  try {
    await h.database.identity(computer.fingerprint).registerComputer(computer);
    h.sql
      .prepare(
        "INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, name, paired_at) VALUES (?, ?, ?, 'Synthetic', 1000)",
      )
      .run(computer.fingerprint, phone.fingerprint, phone.publicKey);
    const store = h.database.notifications(computer.fingerprint);
    await store.register(phone.fingerprint, tokenMessage, "synthetic-generation");
    await store.enqueue(notice(), 1000);
    await store.claimSends(1000, 10);
    h.database.setDeadline(computer.fingerprint, 2000);
    const tables = [
      "computer",
      "pairings",
      "push_registrations",
      "push_jobs",
      "push_attempts",
      "computer_deadlines",
    ];
    const rows = tables.map((table) => h.sql.prepare(`SELECT * FROM ${table}`).all());
    expect(rows.every((table) => table.length > 0)).toBe(true);
    await h.database.close();
    await backupRelay(h.dir, snapshot);
    await restoreRelay(snapshot, destination);
    const sql = new DatabaseSync(join(destination, "relay.sqlite"));
    expect(tables.map((table) => sql.prepare(`SELECT * FROM ${table}`).all())).toEqual(rows);
    expect(sql.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    sql.close();
    const restored = openRelayDatabase(destination, { attentive: () => false });
    expect(restored.deadlines()).toEqual([{ computerFp: computer.fingerprint, deadline: 2000 }]);
    await restored.close();
    await expect(restoreRelay(snapshot, destination)).rejects.toThrow();
    mkdirSync(join(archive, "empty"), { mode: 0o700 });
    await expect(restoreRelay(snapshot, join(archive, "empty"))).rejects.toThrow();
  } finally {
    await h.close();
    rmSync(archive, { recursive: true });
  }
});

it("backs up schema v1 without modifying it and migrates only the fresh restored copy", async () => {
  const h = fixture();
  const archive = temporaryDirectory();
  try {
    h.sql.exec("DROP TABLE computer_deadlines; PRAGMA user_version = 1");
    await h.database.close();
    await backupRelay(h.dir, join(archive, "v1.sqlite"));
    expect(h.sql.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    await restoreRelay(join(archive, "v1.sqlite"), join(archive, "restored"));
    const restored = openRelayDatabase(join(archive, "restored"), { attentive: () => false });
    expect(restored.deadlines()).toEqual([]);
    await restored.close();
  } finally {
    await h.close();
    rmSync(archive, { recursive: true });
  }
});

it("refuses an archive name reserved for the source ownership WAL", async () => {
  const h = fixture();
  try {
    await h.database.close();
    await expect(backupRelay(h.dir, join(h.dir, "ownership.sqlite-wal"))).rejects.toThrow(
      /reserved/i,
    );
  } finally {
    await h.close();
  }
});

it.each([
  "relay.sqlite",
  "relay.sqlite-wal",
  "relay.sqlite-shm",
  "relay.sqlite-journal",
  "ownership.sqlite",
  "ownership.sqlite-wal",
  "ownership.sqlite-shm",
  "ownership.sqlite-journal",
])(
  "rejects a backup beneath reserved %s before creating a directory and leaves source reopenable",
  async (reserved) => {
    const h = fixture();
    const source = join(h.dir, reserved);
    try {
      await h.database.close();
      const existed = existsSync(source);
      await expect(backupRelay(h.dir, join(source, "archive.sqlite"))).rejects.toThrow(/reserved/i);
      expect(existsSync(source)).toBe(existed);
      const reopened = openRelayDatabase(h.dir, { attentive: () => false });
      await reopened.close();
    } finally {
      await h.close();
    }
  },
);
