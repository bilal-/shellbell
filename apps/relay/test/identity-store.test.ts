/// <reference types="node" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { fingerprint } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import {
  identityStoreScenarios,
  pairingFixture,
} from "../../../packages/relay-core/test-support/identity-store-contract.js";
import { createCloudflareIdentityStore } from "../src/adapters/identity-store.js";
import type { Env } from "../src/env.js";
import { upgradePairIdSchema, upgradeRevocationProofSchema } from "../src/schema.js";

const relayEnv = env as typeof env & Env;
const publicKey = new Uint8Array(32).fill(50);
const computer = {
  fingerprint: fingerprint(publicKey),
  publicKey,
  name: "Mac",
  firstSeen: 100,
  lastSeen: 100,
};

function harness(test: (storage: DurableObjectStorage) => Promise<void>) {
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId());
  return runInDurableObject(stub, (_instance, state) => test(state.storage));
}

describe("Cloudflare identity store contract", () => {
  it("upgrades an existing tombstone table without losing its pending rows", () =>
    harness(async (storage) => {
      const sql = storage.sql;
      sql.exec("ALTER TABLE pending_unpairs DROP COLUMN proof");
      const phoneFp = pairingFixture(1).phoneFp;
      sql.exec("INSERT INTO pending_unpairs (phone_fp, at) VALUES (?, 100)", phoneFp);
      upgradeRevocationProofSchema(sql);
      upgradeRevocationProofSchema(sql);
      expect(
        sql.exec<{ phone_fp: string }>("SELECT phone_fp FROM pending_unpairs").one().phone_fp,
      ).toBe(phoneFp);
      expect(sql.exec<{ name: string }>("PRAGMA table_info(pending_unpairs)").toArray()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "proof" })]),
      );
    }));

  it("adds pair IDs to existing pairing rows idempotently", () =>
    harness(async (storage) => {
      const sql = storage.sql;
      sql.exec("ALTER TABLE pairings DROP COLUMN pair_id");
      const phone = pairingFixture(7);
      sql.exec(
        "INSERT INTO pairings (phone_fp, ed25519_pub, name, paired_at) VALUES (?, ?, ?, ?)",
        phone.phoneFp,
        new Uint8Array(phone.publicKey).buffer,
        phone.name,
        phone.pairedAt,
      );
      upgradePairIdSchema(sql);
      upgradePairIdSchema(sql);
      expect(sql.exec<{ name: string }>("PRAGMA table_info(pairings)").toArray()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "pair_id" })]),
      );
      expect(sql.exec<{ phone_fp: string }>("SELECT phone_fp FROM pairings").one().phone_fp).toBe(
        phone.phoneFp,
      );
    }));

  it.each([
    ["Node Buffer", () => Buffer.alloc(32, 2)],
    ["offset Node Buffer", () => Buffer.alloc(96, 8).subarray(16, 48).fill(2)],
    ["offset Uint8Array", () => new Uint8Array(96).fill(8).subarray(16, 48).fill(2)],
  ] as const)("stores only the visible 32 bytes of %s keys and gates", (_name, create) =>
    harness(async (storage) => {
      const key = create();
      const gate = create();
      const fp = fingerprint(key);
      const store = createCloudflareIdentityStore(storage, fp);
      await store.registerComputer({ ...computer, fingerprint: fp, publicKey: key });
      await store.addPairing({ ...pairingFixture(2), publicKey: key }, 100);
      await store.openWindow(gate, 500);
      expect(
        storage.sql.exec<{ n: number }>("SELECT length(ed25519_pub) AS n FROM computer").one().n,
      ).toBe(32);
      expect(
        storage.sql.exec<{ n: number }>("SELECT length(ed25519_pub) AS n FROM pairings").one().n,
      ).toBe(32);
      expect(
        storage.sql.exec<{ n: number }>("SELECT length(gate_hash) AS n FROM pairing_window").one()
          .n,
      ).toBe(32);
      key.fill(9);
      gate.fill(9);
      expect((await store.computer())?.publicKey).toEqual(new Uint8Array(32).fill(2));
      expect((await store.pairing(fp))?.publicKey).toEqual(new Uint8Array(32).fill(2));
      expect((await store.window())?.gateHash).toEqual(new Uint8Array(32).fill(2));
    }),
  );

  for (const scenario of identityStoreScenarios) {
    it(scenario.name, () =>
      harness(async (storage) => {
        const sql = storage.sql;
        await scenario.run(
          {
            store: createCloudflareIdentityStore(storage, computer.fingerprint),
            computer: { ...computer, publicKey: publicKey.slice() },
            seedNotifications(phoneFp) {
              sql.exec(
                "INSERT INTO push_registrations (phone_fp, generation) VALUES (?, 'generation')",
                phoneFp,
              );
              sql.exec(
                "INSERT INTO push_jobs (id, phone_fp, generation, phase, admitted_at, expires_at, due_at) VALUES (?, ?, 'generation', 'send', 100, 200, 100)",
                phoneFp,
                phoneFp,
              );
              sql.exec(
                "INSERT INTO push_limits (phone_fp, window_start, count) VALUES (?, 100, 1)",
                phoneFp,
              );
              sql.exec(
                "INSERT INTO push_attempts (phone_fp, attempted_at) VALUES (?, 100)",
                phoneFp,
              );
            },
            async notificationCounts(phoneFp) {
              return ["push_registrations", "push_jobs", "push_limits", "push_attempts"].map(
                (table) =>
                  sql
                    .exec<{ n: number }>(
                      `SELECT COUNT(*) AS n FROM ${table} WHERE phone_fp = ?`,
                      phoneFp,
                    )
                    .one().n,
              );
            },
            failRevocation(phoneFp) {
              sql.exec(
                `CREATE TRIGGER injected_failure BEFORE DELETE ON push_attempts WHEN OLD.phone_fp = '${phoneFp}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
              );
            },
            failPairingWrite(phoneFp) {
              sql.exec(
                `CREATE TRIGGER injected_failure BEFORE INSERT ON pairings WHEN NEW.phone_fp = '${phoneFp}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
              );
            },
            clearFailure() {
              sql.exec("DROP TRIGGER injected_failure");
            },
          },
          (actual, expected) => expect(actual).toEqual(expected),
        );
      }),
    );
  }

  it("rejects malformed stored blobs and fingerprint/key disagreement", () =>
    harness(async (storage) => {
      const store = createCloudflareIdentityStore(storage, computer.fingerprint);
      const phone = pairingFixture(1);
      await store.addPairing(phone, 100);
      storage.sql.exec(
        "UPDATE pairings SET ed25519_pub = ? WHERE phone_fp = ?",
        new ArrayBuffer(31),
        phone.phoneFp,
      );
      await expect(store.pairing(phone.phoneFp)).rejects.toThrow();
      storage.sql.exec(
        "UPDATE pairings SET ed25519_pub = ? WHERE phone_fp = ?",
        new Uint8Array(32).fill(2).buffer,
        phone.phoneFp,
      );
      await expect(store.pairings()).rejects.toThrow();
      await store.registerComputer(computer);
      storage.sql.exec("UPDATE computer SET ed25519_pub = ?", new Uint8Array(32).fill(2).buffer);
      await expect(store.computer()).rejects.toThrow();
      await store.openWindow(new Uint8Array(32), 200);
      storage.sql.exec("UPDATE pairing_window SET gate_hash = ?", new ArrayBuffer(1));
      await expect(store.window()).rejects.toThrow();
    }));

  it("rejects invalid records and cross-computer registration before persisting", () =>
    harness(async (storage) => {
      const store = createCloudflareIdentityStore(storage, computer.fingerprint);
      const phone = pairingFixture(1);
      await expect(
        store.addPairing({ ...phone, publicKey: new Uint8Array(32).fill(2) }, 100),
      ).rejects.toThrow();
      await expect(store.addPairing({ ...phone, pairedAt: Number.NaN }, 100)).rejects.toThrow();
      await expect(store.addPairing({ ...phone, pushPlatform: "windows" }, 100)).rejects.toThrow();
      await expect(
        store.registerComputer({
          ...computer,
          fingerprint: phone.phoneFp,
          publicKey: phone.publicKey,
        }),
      ).rejects.toThrow();
      await expect(store.openWindow(new Uint8Array(31), 200)).rejects.toThrow();
      expect(await store.pairings()).toEqual([]);
      expect(await store.computer()).toBeNull();
    }));

  it.each([
    ["push_enabled", 2],
    ["push_platform", "windows"],
    ["push_token", ""],
    ["name", ""],
    ["paired_at", -1],
    ["last_seen", -1],
  ])("rejects malformed stored pairing field %s", (field, value) =>
    harness(async (storage) => {
      const store = createCloudflareIdentityStore(storage, computer.fingerprint);
      const phone = pairingFixture(1);
      await store.addPairing(phone, 100);
      storage.sql.exec(`UPDATE pairings SET ${field} = ? WHERE phone_fp = ?`, value, phone.phoneFp);
      await expect(store.pairing(phone.phoneFp)).rejects.toThrow();
    }),
  );

  it.each([
    ["admitted", -1],
    ["admitted", 6],
    ["expires_at", -1],
  ])("rejects malformed stored window field %s=%s", (field, value) =>
    harness(async (storage) => {
      const store = createCloudflareIdentityStore(storage, computer.fingerprint);
      await store.openWindow(new Uint8Array(32), 200);
      storage.sql.exec(`UPDATE pairing_window SET ${field} = ?`, value);
      await expect(store.window()).rejects.toThrow();
    }),
  );
});
