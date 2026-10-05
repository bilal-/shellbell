import { expect, it } from "vitest";
import { pairingFixture } from "../../../packages/relay-core/test-support/identity-store-contract.js";
import {
  notice,
  tokenMessage,
} from "../../../packages/relay-core/test-support/notification-store-contract.js";
import { computerFixture, fixture } from "./helpers.js";

it("rolls back unregistered completion if deleting jobs fails", async () => {
  const h = fixture();
  const computer = computerFixture(),
    phone = pairingFixture(1);
  const fp = computer.fingerprint;
  const identity = h.database.identity(fp),
    store = h.database.notifications(fp);
  try {
    await identity.addPairing(phone, 100);
    await store.register(phone.phoneFp, tokenMessage, "generation");
    await store.enqueue(notice(), 1000);
    await store.enqueue(notice("other"), 1000);
    const sends = await store.claimSends(1000, 10);
    const claim = sends[0]!;
    const now = 1001;

    const pairingBefore = await identity.pairing(phone.phoneFp);
    const jobsBefore = h.sql
      .prepare("SELECT * FROM push_jobs WHERE computer_fp = ? ORDER BY id")
      .all(fp);
    const registrationsBefore = h.sql
      .prepare("SELECT * FROM push_registrations WHERE computer_fp = ?")
      .all(fp);
    const attemptsBefore = h.count("push_attempts", fp);
    const deadlineBefore = await store.nextDeadline();
    h.sql.exec(
      "CREATE TRIGGER fail_unregistered BEFORE DELETE ON push_jobs BEGIN SELECT RAISE(ABORT, 'injected job deletion failure'); END",
    );
    const complete = () => store.finishSend(claim, { status: "unregistered" }, now);
    await expect(complete()).rejects.toThrow("injected job deletion failure");
    expect(await identity.pairing(phone.phoneFp)).toEqual(pairingBefore);
    expect(
      h.sql.prepare("SELECT * FROM push_jobs WHERE computer_fp = ? ORDER BY id").all(fp),
    ).toEqual(jobsBefore);
    expect(h.sql.prepare("SELECT * FROM push_registrations WHERE computer_fp = ?").all(fp)).toEqual(
      registrationsBefore,
    );
    expect(h.count("push_attempts", fp)).toBe(attemptsBefore);
    expect(await store.nextDeadline()).toBe(deadlineBefore);
    expect(await store.isCurrent(claim, now)).toBe(true);
    h.sql.exec("DROP TRIGGER fail_unregistered");
    await complete();
    expect((await identity.pairing(phone.phoneFp))?.pushToken).toBeNull();
    expect((await identity.pairing(phone.phoneFp))?.pushPlatform).toBeNull();
    expect(h.count("push_jobs", fp)).toBe(0);
    expect(h.count("push_attempts", fp)).toBe(attemptsBefore);
    expect(await store.isCurrent(claim, now)).toBe(false);
  } finally {
    await h.close();
  }
});

it.each(["expiry", "orphan"] as const)(
  "rolls back all %s deletions if a late identity delete fails",
  async (cleanup) => {
    const h = fixture();
    const computer = computerFixture(),
      phone = pairingFixture(1);
    const fp = computer.fingerprint;
    const identity = h.database.identity(fp),
      store = h.database.notifications(fp);
    try {
      if (cleanup === "expiry") await identity.registerComputer(computer);
      await identity.addPairing(phone, 100);
      await identity.openWindow(new Uint8Array(32), 500);
      await store.register(phone.phoneFp, tokenMessage, "generation");
      await store.enqueue(notice(), 1000);
      await store.claimSends(1000, 10);
      h.sql.exec(
        "CREATE TRIGGER fail_cleanup BEFORE DELETE ON pairings BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END",
      );
      await expect(
        cleanup === "expiry"
          ? identity.deleteExpiredComputer(90 * 24 * 3600 * 1000 + 101)
          : identity.deleteOrphanedComputer(),
      ).rejects.toThrow("injected cleanup failure");
      expect(await identity.pairing(phone.phoneFp)).not.toBeNull();
      expect((await identity.window())?.expiresAt).toBe(500);
      expect(h.count("push_jobs", fp)).toBe(1);
      expect(h.count("push_registrations", fp)).toBe(1);
      expect(h.count("push_attempts", fp)).toBe(1);
      expect(h.count("ring_limits", fp)).toBe(1);
      expect(await store.nextDeadline()).toBe(11000);
    } finally {
      await h.close();
    }
  },
);

it("rolls back ring admission and supersession if the replacement notification cannot persist", async () => {
  const h = fixture();
  const computer = computerFixture(),
    phone = pairingFixture(1);
  const fp = computer.fingerprint;
  const identity = h.database.identity(fp),
    store = h.database.notifications(fp);
  try {
    await identity.addPairing(phone, 100);
    await store.register(phone.phoneFp, tokenMessage, "generation");
    await store.enqueue(notice(), 1000);
    h.sql.exec(
      "CREATE TRIGGER fail_enqueue BEFORE INSERT ON push_jobs BEGIN SELECT RAISE(ABORT, 'injected enqueue failure'); END",
    );
    await expect(store.enqueue(notice(), 61000)).rejects.toThrow("injected enqueue failure");
    expect(await store.nextDeadline()).toBe(1000);
    expect(h.count("push_jobs", fp)).toBe(1);
    expect(
      h.sql
        .prepare(
          "SELECT last_ring_at FROM ring_limits WHERE computer_fp = ? AND session_id = 'session'",
        )
        .get(fp)!.last_ring_at,
    ).toBe(1000);
    h.sql.exec("DROP TRIGGER fail_enqueue");
    await store.enqueue(notice(), 61000);
    expect(await store.nextDeadline()).toBe(61000);
  } finally {
    await h.close();
  }
});

it("isolates same-phone revocation, renewal, tombstones and rolling budgets between computers", async () => {
  const h = fixture();
  const phone = pairingFixture(1);
  const a = computerFixture(50),
    b = computerFixture(51);
  const ai = h.database.identity(a.fingerprint),
    bi = h.database.identity(b.fingerprint);
  const an = h.database.notifications(a.fingerprint),
    bn = h.database.notifications(b.fingerprint);
  try {
    for (const [identity, notifications, computer] of [
      [ai, an, a],
      [bi, bn, b],
    ] as const) {
      await identity.registerComputer(computer);
      await identity.addPairing(phone, 100);
      await notifications.register(phone.phoneFp, tokenMessage, "same-generation");
      await notifications.enqueue(notice(), 1000);
    }
    const [ac] = await an.claimSends(1000, 10);
    const [bc] = await bn.claimSends(1000, 10);
    expect(ac).toBeDefined();
    expect(bc).toBeDefined();
    await an.register(phone.phoneFp, tokenMessage, "renewed");
    expect(await an.isCurrent(ac!, 1001)).toBe(false);
    expect(await bn.isCurrent(bc!, 1001)).toBe(true);
    await ai.revoke(phone.phoneFp, true, 1002);
    expect(await ai.pendingRevocations()).toEqual([phone.phoneFp]);
    expect(await bi.pendingRevocations()).toEqual([]);
    expect((await bi.pairing(phone.phoneFp))?.pushToken).toBe(tokenMessage.token);
    expect(await bn.isCurrent(bc!, 1003)).toBe(true);
    expect(h.count("push_attempts", a.fingerprint)).toBe(0);
    expect(h.count("push_attempts", b.fingerprint)).toBe(1);
    await ai.syncPairings([phone], 1100);
    await ai.addPairing(phone, 1100);
    await an.register(phone.phoneFp, tokenMessage, "new");
    await bn.finishSend(bc!, { status: "rejected", code: "http-permanent" }, 1003);
    for (let i = 0; i < 21; i++) {
      await an.enqueue(notice(`a-${i}`), 2000 + i);
      const claims = await an.claimSends(2000 + i, 10);
      expect(claims).toHaveLength(i < 20 ? 1 : 0);
      if (claims[0])
        await an.finishSend(claims[0], { status: "rejected", code: "http-permanent" }, 2000 + i);
    }
    await bn.enqueue(notice("still-has-budget"), 3000);
    expect(await bn.claimSends(3000, 10)).toHaveLength(1);
    expect(h.count("push_attempts", b.fingerprint)).toBe(2);
  } finally {
    await h.close();
  }
});

it.each(["expiry", "orphan"] as const)(
  "%s cleanup preserves the other computer's identical phone, gate, session and job IDs",
  async (cleanup) => {
    const h = fixture();
    const a = computerFixture(50),
      b = computerFixture(51);
    const phone = pairingFixture(1);
    try {
      for (const computer of [a, b]) {
        const store = h.database.identity(computer.fingerprint);
        if (cleanup === "expiry" || computer === b) await store.registerComputer(computer);
        await store.addPairing(phone, 100);
        await store.openWindow(new Uint8Array(32), 500);
        await h.database
          .notifications(computer.fingerprint)
          .register(phone.phoneFp, tokenMessage, "generation");
        await h.database.notifications(computer.fingerprint).enqueue(notice(), 1000);
        // Identical job IDs must be legal in the independently owned computer partitions.
        h.sql
          .prepare("UPDATE push_jobs SET id = 'same' WHERE computer_fp = ?")
          .run(computer.fingerprint);
      }
      const before = await h.database.identity(b.fingerprint).pairings();
      const ai = h.database.identity(a.fingerprint);
      expect(
        await (cleanup === "expiry"
          ? ai.deleteExpiredComputer(90 * 24 * 3600 * 1000 + 101)
          : ai.deleteOrphanedComputer()),
      ).toBe(true);
      expect(await h.database.identity(b.fingerprint).pairings()).toEqual(before);
      expect((await h.database.identity(b.fingerprint).window())?.expiresAt).toBe(500);
      expect(await h.database.notifications(b.fingerprint).nextDeadline()).toBe(1000);
      expect(h.count("push_jobs", a.fingerprint)).toBe(0);
      expect(h.count("ring_limits", b.fingerprint)).toBe(1);
    } finally {
      await h.close();
    }
  },
);

it("rolls back renewal cancellation and token updates if registration persistence fails", async () => {
  const h = fixture();
  const computer = computerFixture(),
    phone = pairingFixture(1);
  const identity = h.database.identity(computer.fingerprint);
  const store = h.database.notifications(computer.fingerprint);
  try {
    await identity.addPairing(phone, 100);
    await store.register(phone.phoneFp, tokenMessage, "original");
    await store.enqueue(notice(), 1000);
    const [claim] = await store.claimSends(1000, 10);
    h.sql.exec(
      "CREATE TRIGGER fail_registration BEFORE UPDATE ON push_registrations BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END",
    );
    await expect(
      store.register(phone.phoneFp, { ...tokenMessage, token: "ExponentPushToken[new]" }, "new"),
    ).rejects.toThrow("injected registration failure");
    expect(await store.isCurrent(claim!, 1001)).toBe(true);
    expect((await identity.pairing(phone.phoneFp))?.pushToken).toBe(tokenMessage.token);
    h.sql.exec("DROP TRIGGER fail_registration");
    await store.finishSend(claim!, { status: "accepted" }, 1001);
    expect(await store.nextDeadline()).toBeNull();
  } finally {
    await h.close();
  }
});
