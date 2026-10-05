import { describe, expect, it } from "vitest";
import {
  identityStoreScenarios,
  pairingFixture,
} from "../../../packages/relay-core/test-support/identity-store-contract.js";
import { computerFixture, fixture } from "./helpers.js";

describe("Node identity repository contract", () => {
  it("retains a signed offline revocation through a relay process restart", async () => {
    const h = fixture();
    const computer = computerFixture();
    const phone = pairingFixture(1);
    const proof = {
      v: 2 as const,
      computerFp: computer.fingerprint,
      phoneFp: phone.phoneFp,
      pairId: new Uint8Array(32).fill(3),
      signature: new Uint8Array(64).fill(4),
    };
    try {
      const store = h.database.identity(computer.fingerprint);
      await store.registerComputer(computer);
      await store.addPairing(phone, 100);
      await store.revoke(phone.phoneFp, true, 200, proof);
      h.restart();
      expect(await h.database.identity(computer.fingerprint).pendingRevocationProofs()).toEqual([
        proof,
      ]);
    } finally {
      await h.close();
    }
  });

  it("rejects corrupt stored identity bytes and invalid input without returning aliased rows", async () => {
    const h = fixture();
    const computer = computerFixture(),
      phone = pairingFixture(1);
    const store = h.database.identity(computer.fingerprint);
    try {
      await expect(
        store.addPairing({ ...phone, publicKey: new Uint8Array(31) }, 100),
      ).rejects.toThrow();
      expect(await store.pairings()).toEqual([]);
      await store.addPairing(phone, 100);
      h.sql
        .prepare("UPDATE pairings SET ed25519_pub = ? WHERE computer_fp = ? AND phone_fp = ?")
        .run(new Uint8Array(32).fill(2), computer.fingerprint, phone.phoneFp);
      await expect(store.pairings()).rejects.toThrow();
      await store.registerComputer(computer);
      h.sql
        .prepare("UPDATE computer SET last_seen = -1 WHERE computer_fp = ?")
        .run(computer.fingerprint);
      await expect(store.computer()).rejects.toThrow();
      await store.openWindow(new Uint8Array(32), 500);
      h.sql
        .prepare("UPDATE pairing_window SET gate_hash = ? WHERE computer_fp = ?")
        .run(new Uint8Array(1), computer.fingerprint);
      await expect(store.window()).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
  for (const scenario of identityStoreScenarios) {
    it(scenario.name, async () => {
      const h = fixture();
      const computer = computerFixture();
      const fp = computer.fingerprint;
      try {
        await scenario.run(
          {
            store: h.database.identity(fp),
            computer,
            seedNotifications(phone) {
              h.sql
                .prepare(
                  "INSERT INTO push_registrations (computer_fp, phone_fp, generation) VALUES (?, ?, 'generation')",
                )
                .run(fp, phone);
              h.sql
                .prepare(
                  "INSERT INTO push_jobs (computer_fp, id, phone_fp, generation, phase, admitted_at, expires_at, due_at) VALUES (?, ?, ?, 'generation', 'send', 100, 200, 100)",
                )
                .run(fp, phone, phone);
              h.sql.prepare("INSERT INTO push_limits VALUES (?, ?, 100, 1)").run(fp, phone);
              h.sql
                .prepare(
                  "INSERT INTO push_attempts (computer_fp, phone_fp, attempted_at) VALUES (?, ?, 100)",
                )
                .run(fp, phone);
            },
            async notificationCounts(phone) {
              return ["push_registrations", "push_jobs", "push_limits", "push_attempts"].map((t) =>
                h.count(t, fp, phone),
              );
            },
            failRevocation(phone) {
              h.sql.exec(
                `CREATE TRIGGER injected_failure BEFORE DELETE ON push_attempts WHEN OLD.phone_fp = '${phone}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
              );
            },
            failPairingWrite(phone) {
              h.sql.exec(
                `CREATE TRIGGER injected_failure BEFORE INSERT ON pairings WHEN NEW.phone_fp = '${phone}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
              );
            },
            clearFailure() {
              h.sql.exec("DROP TRIGGER injected_failure");
            },
          },
          (actual, expected) => expect(actual).toEqual(expected),
        );
      } finally {
        await h.close();
      }
    });
  }
});
