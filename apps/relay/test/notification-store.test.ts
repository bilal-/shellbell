import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createNotificationService,
  type NotificationProvider,
  type NotificationStore,
  type SendOutcome,
} from "@shellbell/relay-core";
import { describe, expect, it } from "vitest";
import {
  notice,
  notificationComputerFp,
  notificationStoreScenarios,
  tokenMessage,
} from "../../../packages/relay-core/test-support/notification-store-contract.js";
import {
  recoveryCases,
  recoveryPhoneFp,
} from "../../../packages/relay-core/test-support/recovery-cases.js";
import type { RecoveryCase } from "../../../packages/relay-core/test-support/repository-contracts.js";
import { createCloudflareIdentityStore } from "../src/adapters/identity-store.js";
import { createCloudflareNotificationStore } from "../src/adapters/notification-store.js";
import type { Env } from "../src/env.js";
import { upgradePushContextSchema } from "../src/schema.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function withStore(
  test: (create: () => NotificationStore, storage: DurableObjectStorage) => Promise<void>,
) {
  const namespace = (env as typeof env & Env).COMPUTER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO pairings (phone_fp, ed25519_pub, name, paired_at) VALUES ('phone', ?, 'Phone', 1000)",
      new ArrayBuffer(32),
    );
    const create = () =>
      createCloudflareNotificationStore(state.storage, {
        computerFp: "computer",
        attentive: () => false,
        randomId: () => crypto.randomUUID(),
      });
    await create().register("phone", tokenMessage, "generation");
    await test(create, state.storage);
  });
}

describe("notification service on durable SQL", () => {
  it("excludes private computer names from notification registration snapshots", () =>
    withStore(async (create, storage) => {
      const privateComputerLabel = "private repository label";
      storage.sql.exec(
        "INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES ('computer', ?, ?, 1000, 1000)",
        new ArrayBuffer(32),
        privateComputerLabel,
      );
      const store = create();
      await store.enqueue(notice(), 1000);
      const [claim] = await store.claimSends(1000, 10);
      expect(claim).toBeDefined();
      expect(claim!.registration).not.toHaveProperty("computerName");
      expect(JSON.stringify(claim!.registration)).not.toContain(privateComputerLabel);
      expect(storage.sql.exec("SELECT name FROM computer WHERE fp = 'computer'").one().name).toBe(
        privateComputerLabel,
      );
    }));

  it("atomically rolls back the acceptance tombstone if deleting its job fails", () =>
    withStore(async (create, storage) => {
      const store = create();
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
      const [claim] = await store.claimSends(1000, 10);
      storage.sql.exec(
        "CREATE TRIGGER fail_acceptance BEFORE DELETE ON push_jobs BEGIN SELECT RAISE(ABORT, 'acceptance deletion failed'); END",
      );
      await expect(store.finishSend(claim!, { status: "accepted" }, 1001)).rejects.toThrow(
        "acceptance deletion failed",
      );
      expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_accepted").one().n).toBe(0);
      expect(await store.isCurrent(claim!, 1001)).toBe(true);
      storage.sql.exec("DROP TRIGGER fail_acceptance");
      await store.finishSend(claim!, { status: "accepted" }, 1001);
      expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_accepted").one().n).toBe(1);
      expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_jobs").one().n).toBe(0);
    }));
  it("upgrades native destinations idempotently without relabeling a legacy token", () =>
    withStore(async (create, storage) => {
      storage.sql.exec("ALTER TABLE pairings DROP COLUMN push_provider");
      storage.sql.exec("ALTER TABLE pairings DROP COLUMN push_environment");
      storage.sql.exec("UPDATE pairings SET push_token = 'ExponentPushToken[legacy]'");
      upgradePushContextSchema(storage.sql);
      upgradePushContextSchema(storage.sql);
      expect(
        storage.sql.exec("SELECT push_provider, push_environment FROM pairings").one(),
      ).toEqual({ push_provider: null, push_environment: null });
      await create().enqueue(notice(), 1000);
      expect(await create().claimSends(1000, 10)).toEqual([]);
      expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_attempts").one().n).toBe(0);
    }));
  it.each(["receipt", "checking"] as const)(
    "retires old %s work without resending or refunding its attempt",
    (phase) =>
      withStore(async (create, storage) => {
        await create().enqueue(notice(), 1000);
        await create().claimSends(1000, 10);
        storage.sql.exec("UPDATE push_jobs SET phase = ?, ticket_id = 'legacy-ticket'", phase);
        expect(await create().claimSends(1001, 10)).toEqual([]);
        expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_jobs").one().n).toBe(0);
        expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_attempts").one().n).toBe(1);
      }),
  );
  it.each(["count = 0.5", "count = 'invalid'", "window_start = 0.5", "window_start = 'invalid'"])(
    "rejects dynamically typed legacy budget corruption %s before cleanup",
    async (assignment) => {
      await withStore(async (create, storage) => {
        const store = create();
        await store.enqueue(notice(), 4_000_000);
        storage.sql.exec("INSERT INTO push_limits VALUES ('phone', 1000, 1)");
        storage.sql.exec(`UPDATE push_limits SET ${assignment}`);
        const before = storage.sql.exec("SELECT * FROM push_limits").toArray();
        await expect(store.claimSends(4_000_000, 10)).rejects.toThrow();
        expect(storage.sql.exec("SELECT * FROM push_limits").toArray()).toEqual(before);
        expect(storage.sql.exec("SELECT COUNT(*) AS n FROM push_attempts").one().n).toBe(0);
        expect(await store.nextDeadline()).toBe(4_000_000);
      });
    },
  );
  it.each(["context", "features"] as const)(
    "preserves the legacy generic-message fallback for malformed optional %s",
    (field) =>
      withStore(async (create, storage) => {
        const store = create();
        await store.enqueue(notice(), 1000);
        if (field === "context") storage.sql.exec("UPDATE push_jobs SET context_json = '{}' ");
        else storage.sql.exec("UPDATE push_registrations SET features = 'invalid'");
        const [claim] = await store.claimSends(1000, 10);
        expect(claim?.job.context).toBeNull();
        expect(claim?.registration.features).toEqual([]);
        await store.finishSend(claim!, { status: "accepted" }, 1000);
        expect(await store.nextDeadline()).toBeNull();
      }),
  );
  it("rolls back job cancellation and token changes when registration persistence fails", () =>
    withStore(async (create, storage) => {
      const store = create();
      await store.enqueue(notice(), 1000);
      const [claim] = await store.claimSends(1000, 10);
      storage.sql.exec(
        "CREATE TRIGGER fail_registration BEFORE UPDATE ON push_registrations BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END",
      );
      await expect(
        store.register(
          "phone",
          { ...tokenMessage, token: "ExponentPushToken[replacement]" },
          "replacement",
        ),
      ).rejects.toThrow("injected registration failure");
      expect(await store.isCurrent(claim!, 1001)).toBe(true);
      storage.sql.exec("DROP TRIGGER fail_registration");
      await store.finishSend(claim!, { status: "accepted" }, 1001);
      expect(await store.nextDeadline()).toBeNull();
    }));
  it.each(["send"] as const)(
    "revocation finishes independently of held %s provider I/O across reconstruction",
    (boundary) =>
      withStore(async (create) => {
        const now = 1000;
        const store = create();
        const started = deferred<void>();
        const send = deferred<readonly SendOutcome[]>();
        const provider: NotificationProvider = {
          async send() {
            if (boundary === "send") {
              started.resolve();
              return send.promise;
            }
            return [{ status: "accepted" }];
          },
        };
        const service = createNotificationService({
          store,
          provider,
          computerFp: "computer",
          now: () => now,
          randomId: () => crypto.randomUUID(),
          schedule: async () => {},
        });
        await service.enqueue(notice());

        const pending = service.pump();
        await started.promise;
        const restarted = create();
        // This await must finish while the provider remains unresolved.
        await restarted.cancelPhone("phone");
        await restarted.register("phone", tokenMessage, "replacement");
        await restarted.enqueue(notice("replacement"), now + 1);
        expect(await restarted.nextDeadline()).toBe(now + 1);
        send.resolve([{ status: "accepted" }]);
        await pending;
        expect(await restarted.nextDeadline()).toBe(now + 1);
        expect((await restarted.claimSends(now + 1, 10))[0]?.registration.generation).toBe(
          "replacement",
        );
      }),
  );
  it.each(["cancel", "renew", "expire"] as const)(
    "does not dispatch after %s while recovery scheduling is suspended",
    (action) =>
      withStore(async (create) => {
        let now = 1000;
        const started = deferred<void>();
        const release = deferred<void>();
        const calls: string[] = [];
        let first = true;
        const store = create();
        const service = createNotificationService({
          store,
          computerFp: "computer",
          now: () => now,
          randomId: () => crypto.randomUUID(),
          provider: {
            async send() {
              calls.push("send");
              return [];
            },
          },
          schedule: async () => {
            if (first) {
              first = false;
              started.resolve();
              await release.promise;
            }
          },
        });
        await service.enqueue(notice());
        const pending = service.pump();
        await started.promise;
        if (action === "cancel") await create().cancelPhone("phone");
        else if (action === "renew") await create().register("phone", tokenMessage, "replacement");
        else now = 121000;
        release.resolve();
        await pending;
        expect(calls).toEqual([]);
        expect(await store.nextDeadline()).toBeNull();
      }),
  );
  it("does not recreate journal tables when a late provider result follows deleteAll", () =>
    withStore(async (create, storage) => {
      const store = create();
      await store.enqueue(notice(), 1000);
      const [claim] = await store.claimSends(1000, 10);
      await storage.deleteAll();
      await store.finishSend(claim!, { status: "accepted" }, 1001);
      await store.recover(1001);
      expect(await store.nextDeadline()).toBeNull();
      expect(await store.isCurrent(claim!, 1001)).toBe(false);
      expect(
        storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'push_jobs'").toArray(),
      ).toEqual([]);
    }));
});

describe("Cloudflare notification repository contract", () => {
  const cases: readonly RecoveryCase[] = [...notificationStoreScenarios, ...recoveryCases];
  for (const scenario of cases) {
    it(scenario.name, async () => {
      const phone = recoveryCases.includes(scenario) ? recoveryPhoneFp : "phone";
      const namespace = (env as typeof env & Env).COMPUTER;
      const stub = namespace.get(namespace.newUniqueId());
      await runInDurableObject(stub, async (_instance, state) => {
        const sql = state.storage.sql;
        let attentive = false;
        const create = () =>
          createCloudflareNotificationStore(state.storage, {
            computerFp: notificationComputerFp,
            attentive: () => attentive,
            randomId: () => crypto.randomUUID(),
          });
        const store = create();
        const addPhone = async (phone: string) => {
          sql.exec(
            "INSERT INTO pairings (phone_fp, ed25519_pub, name, paired_at) VALUES (?, ?, 'Phone', 1000)",
            phone,
            new ArrayBuffer(32),
          );
          await store.register(phone, tokenMessage, `generation-${phone}`);
        };
        await addPhone(phone);
        const count = (table: string) =>
          sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
        await scenario.run(
          {
            store,
            corrupt(field) {
              const assignments = {
                dueAt: "due_at = -1",
                expiresAt: "expires_at = -1",
                sendCount: "send_count = -1",
              };
              sql.exec(`UPDATE push_jobs SET ${assignments[field]} WHERE session_id = 'one'`);
            },
            repair() {
              sql.exec(
                "UPDATE push_jobs SET due_at = 1000, expires_at = 3601000, send_count = 0 WHERE session_id = 'one'",
              );
            },
            revoke: async () => {
              await createCloudflareIdentityStore(state.storage, notificationComputerFp).revoke(
                phone,
                true,
                1001,
              );
            },
            restart: create,
            addPhone,
            attentive: (value) => {
              attentive = value;
            },
            attempts: () => count("push_attempts"),
            jobCount: () => count("push_jobs"),
            ringCount: () => count("ring_limits"),
            token: () =>
              sql
                .exec<{ push_token: string | null }>(
                  "SELECT push_token FROM pairings WHERE phone_fp = ?",
                  phone,
                )
                .toArray()[0]?.push_token ?? null,
            seedLegacyBudget: (count, at) => {
              sql.exec("INSERT INTO push_limits VALUES (?, ?, ?)", phone, at, count);
            },
            seedAttempt(at) {
              sql.exec(
                "INSERT INTO push_attempts (phone_fp, attempted_at) VALUES (?, ?)",
                phone,
                at,
              );
            },
            budgetSnapshot() {
              return [
                sql.exec("SELECT * FROM push_limits").toArray(),
                sql.exec("SELECT * FROM push_attempts ORDER BY id").toArray(),
              ];
            },
            failClaim: () => {
              sql.exec(
                "CREATE TRIGGER fail_claim BEFORE UPDATE ON push_jobs BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END",
              );
            },
            clearFailure: () => {
              sql.exec("DROP TRIGGER fail_claim");
            },
          },
          (actual, expected) => expect(actual).toEqual(expected),
        );
      });
    });
  }
});
