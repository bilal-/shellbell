import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openRelayDatabase } from "../src/storage/database.js";
import { computerFixture, fixture, temporaryDirectory } from "./helpers.js";

it("persists isolated deadlines, cancellation, and computers with no scheduled deadline", async () => {
  const f = fixture();
  try {
    const a = computerFixture(70),
      b = computerFixture(71);
    await f.database.identity(a.fingerprint).registerComputer(a);
    await f.database.identity(b.fingerprint).registerComputer(b);
    f.database.setDeadline(a.fingerprint, 1234);
    f.database.setDeadline(b.fingerprint, 5678);
    f.restart();
    expect(f.database.deadlines()).toEqual(
      [
        { computerFp: a.fingerprint, deadline: 1234 },
        { computerFp: b.fingerprint, deadline: 5678 },
      ].sort((x, y) => x.computerFp.localeCompare(y.computerFp)),
    );
    f.database.setDeadline(a.fingerprint, null);
    expect(f.database.computers().sort()).toEqual([a.fingerprint, b.fingerprint].sort());
    expect(f.database.deadlines()).toEqual([{ computerFp: b.fingerprint, deadline: 5678 }]);
  } finally {
    await f.close();
  }
});

it("upgrades version one additively and preserves its existing identity rows", async () => {
  const dir = temporaryDirectory();
  let db = openRelayDatabase(dir, { attentive: () => false });
  const a = computerFixture(72);
  await db.identity(a.fingerprint).registerComputer(a);
  await db.close();
  const sql = new DatabaseSync(join(dir, "relay.sqlite"));
  sql.exec("DROP TABLE IF EXISTS computer_deadlines; PRAGMA user_version=1");
  sql.close();
  try {
    db = openRelayDatabase(dir, { attentive: () => false });
    expect(await db.identity(a.fingerprint).computer()).toEqual(a);
    db.setDeadline(a.fingerprint, 1000);
    expect(db.deadlines()).toEqual([{ computerFp: a.fingerprint, deadline: 1000 }]);
    const check = new DatabaseSync(join(dir, "relay.sqlite"));
    expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(5);
    check.close();
  } finally {
    await db.close();
    rmSync(dir, { recursive: true });
  }
});

it("upgrades version two tombstones without losing pending revocations", async () => {
  const dir = temporaryDirectory();
  let db = openRelayDatabase(dir, { attentive: () => false });
  const computer = computerFixture(74);
  const phoneFp = computerFixture(75).fingerprint;
  await db.identity(computer.fingerprint).registerComputer(computer);
  await db.close();
  const old = new DatabaseSync(join(dir, "relay.sqlite"));
  old.exec("ALTER TABLE pending_unpairs DROP COLUMN proof; PRAGMA user_version = 2");
  old
    .prepare("INSERT INTO pending_unpairs (computer_fp, phone_fp, at) VALUES (?, ?, 100)")
    .run(computer.fingerprint, phoneFp);
  old.close();
  db = openRelayDatabase(dir, { attentive: () => false });
  try {
    expect(await db.identity(computer.fingerprint).pendingRevocations()).toEqual([phoneFp]);
    expect(await db.identity(computer.fingerprint).pendingRevocationProofs()).toEqual([]);
  } finally {
    await db.close();
  }
});

it("upgrades version three pairings without losing existing phones", async () => {
  const dir = temporaryDirectory();
  let db = openRelayDatabase(dir, { attentive: () => false });
  const computer = computerFixture(76);
  const phone = computerFixture(77);
  await db.identity(computer.fingerprint).registerComputer(computer);
  await db.identity(computer.fingerprint).addPairing(
    {
      phoneFp: phone.fingerprint,
      publicKey: phone.publicKey,
      name: "Phone",
      pushToken: null,
      pushPlatform: null,
      pushEnabled: true,
      pairedAt: 100,
      lastSeenAt: null,
      pairId: new Uint8Array(32).fill(5),
    },
    100,
  );
  await db.close();
  const old = new DatabaseSync(join(dir, "relay.sqlite"));
  old.exec("ALTER TABLE pairings DROP COLUMN pair_id; PRAGMA user_version = 3");
  old.close();
  db = openRelayDatabase(dir, { attentive: () => false });
  try {
    const restored = await db.identity(computer.fingerprint).pairing(phone.fingerprint);
    expect(restored?.phoneFp).toBe(phone.fingerprint);
    expect(restored?.pairId).toBeUndefined();
    const check = new DatabaseSync(join(dir, "relay.sqlite"));
    expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(5);
    check.close();
  } finally {
    await db.close();
    rmSync(dir, { recursive: true });
  }
});
