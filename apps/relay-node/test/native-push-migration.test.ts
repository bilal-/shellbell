import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { pairingFixture } from "../../../packages/relay-core/test-support/identity-store-contract.js";
import {
  notice,
  tokenMessage,
} from "../../../packages/relay-core/test-support/notification-store-contract.js";
import { initializeSchema } from "../src/storage/schema.js";
import { computerFixture, fixture } from "./helpers.js";

it("atomically rolls back an acceptance tombstone if removing the job fails", async () => {
  const h = fixture();
  const fp = computerFixture().fingerprint;
  const phone = pairingFixture(1);
  try {
    await h.database.identity(fp).addPairing(phone, 1000);
    const store = h.database.notifications(fp);
    await store.register(phone.phoneFp, tokenMessage, "generation");
    await store.enqueue(
      {
        type: "notify-context",
        sessionId: "session",
        eventId: "a".repeat(22),
        kind: "idle",
        boxes: [],
      },
      1000,
    );
    const [claim] = await store.claimSends(1000, 1);
    h.sql.exec(
      "CREATE TRIGGER fail_acceptance BEFORE DELETE ON push_jobs BEGIN SELECT RAISE(ABORT, 'acceptance deletion failed'); END",
    );
    await expect(store.finishSend(claim!, { status: "accepted" }, 1001)).rejects.toThrow(
      "acceptance deletion failed",
    );
    expect(h.count("push_accepted", fp)).toBe(0);
    expect(await store.isCurrent(claim!, 1001)).toBe(true);
    h.sql.exec("DROP TRIGGER fail_acceptance");
    await store.finishSend(claim!, { status: "accepted" }, 1001);
    expect(h.count("push_accepted", fp)).toBe(1);
    expect(h.count("push_jobs", fp)).toBe(0);
  } finally {
    await h.close();
  }
});

it.each(["receipt", "checking"] as const)(
  "retires legacy %s jobs on restart without refunding attempts",
  async (phase) => {
    const h = fixture();
    const fp = computerFixture().fingerprint;
    const phone = pairingFixture(1);
    try {
      await h.database.identity(fp).addPairing(phone, 1000);
      const store = h.database.notifications(fp);
      await store.register(phone.phoneFp, tokenMessage, "generation");
      await store.enqueue(notice(), 1000);
      await store.claimSends(1000, 1);
      h.sql
        .prepare(
          "UPDATE push_jobs SET phase = ?, ticket_id = 'legacy-ticket' WHERE computer_fp = ?",
        )
        .run(phase, fp);
      h.restart();
      const restarted = h.database.notifications(fp);
      expect(await restarted.claimSends(1001, 10)).toEqual([]);
      expect(h.count("push_jobs", fp)).toBe(0);
      expect(h.count("push_attempts", fp)).toBe(1);
    } finally {
      await h.close();
    }
  },
);

it("never sends a stored token with no provider", async () => {
  const h = fixture();
  const fp = computerFixture().fingerprint;
  const phone = pairingFixture(1);
  try {
    await h.database.identity(fp).addPairing(phone, 1000);
    const store = h.database.notifications(fp);
    await store.register(
      phone.phoneFp,
      { type: "push-token", token: "ExponentPushToken[old]", platform: "ios", enabled: true },
      "legacy",
    );
    await store.enqueue(notice(), 1000);
    expect(await store.claimSends(1000, 10)).toEqual([]);
    expect(h.count("push_jobs", fp)).toBe(0);
    expect(h.count("push_attempts", fp)).toBe(0);
  } finally {
    await h.close();
  }
});

it("retains a long native FCM token through identity decoding and restart", async () => {
  const h = fixture();
  const fp = computerFixture().fingerprint;
  const phone = pairingFixture(1);
  try {
    await h.database.identity(fp).addPairing(phone, 1000);
    await h.database.notifications(fp).register(
      phone.phoneFp,
      {
        type: "push-token",
        token: "f".repeat(4096),
        provider: "fcm",
        platform: "android",
        enabled: true,
      },
      "generation",
    );
    h.restart();
    expect((await h.database.identity(fp).pairing(phone.phoneFp))?.pushToken).toBe(
      "f".repeat(4096),
    );
  } finally {
    await h.close();
  }
});

it("adds native push destinations to v4 without relabeling legacy Expo tokens or clearing spent attempts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSchema(db);
    for (const column of ["push_provider", "push_environment"]) {
      if (
        db
          .prepare("PRAGMA table_info(pairings)")
          .all()
          .some((row) => row.name === column)
      )
        db.exec(`ALTER TABLE pairings DROP COLUMN ${column}`);
    }
    db.exec("DROP TABLE IF EXISTS push_accepted; PRAGMA user_version = 4");
    db.prepare(
      "INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, name, push_token, paired_at) VALUES ('computer', 'phone', ?, 'Phone', 'ExponentPushToken[legacy]', 1000)",
    ).run(new Uint8Array(32));
    db.exec(
      "INSERT INTO push_attempts (computer_fp, phone_fp, attempted_at) VALUES ('computer', 'phone', 1000)",
    );
    initializeSchema(db);
    initializeSchema(db);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(5);
    expect(
      db.prepare("SELECT push_token, push_provider, push_environment FROM pairings").get(),
    ).toEqual({
      push_token: "ExponentPushToken[legacy]",
      push_provider: null,
      push_environment: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_attempts").get()!.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM push_accepted").get()!.n).toBe(0);
  } finally {
    db.close();
  }
});
