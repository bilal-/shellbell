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
import { fixture } from "./helpers.js";

describe("Node notification repository contract", () => {
  it("excludes private computer names from notification registration snapshots", async () => {
    const h = fixture();
    const fp = notificationComputerFp;
    const privateComputerLabel = "private repository label";
    try {
      h.sql
        .prepare(
          "INSERT INTO computer (computer_fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, 1000, 1000)",
        )
        .run(fp, new Uint8Array(32), privateComputerLabel);
      h.sql
        .prepare(
          "INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, name, paired_at) VALUES (?, 'phone', ?, 'Phone', 1000)",
        )
        .run(fp, new Uint8Array(32));
      const store = h.database.notifications(fp);
      await store.register("phone", tokenMessage, "generation");
      await store.enqueue(notice(), 1000);
      const [claim] = await store.claimSends(1000, 10);
      expect(claim).toBeDefined();
      expect(claim!.registration).not.toHaveProperty("computerName");
      expect(JSON.stringify(claim!.registration)).not.toContain(privateComputerLabel);
      expect(h.sql.prepare("SELECT name FROM computer WHERE computer_fp = ?").get(fp)?.name).toBe(
        privateComputerLabel,
      );
    } finally {
      await h.close();
    }
  });

  it.each(["timestamp", "features", "context"] as const)(
    "rejects corrupt stored notification %s and leaves work unclaimed",
    async (kind) => {
      const h = fixture();
      const fp = notificationComputerFp;
      const store = h.database.notifications(fp);
      try {
        h.sql
          .prepare(
            "INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, name, paired_at) VALUES (?, 'phone', ?, 'Phone', 1000)",
          )
          .run(fp, new Uint8Array(32));
        await store.register("phone", tokenMessage, "generation");
        await store.enqueue(notice(), 1000);
        if (kind === "timestamp")
          h.sql.prepare("UPDATE push_jobs SET admitted_at = -1 WHERE computer_fp = ?").run(fp);
        if (kind === "context")
          h.sql.prepare("UPDATE push_jobs SET context_json = '{}' WHERE computer_fp = ?").run(fp);
        if (kind === "features")
          h.sql
            .prepare("UPDATE push_registrations SET features = 'invalid' WHERE computer_fp = ?")
            .run(fp);
        await expect(store.claimSends(1000, 10)).rejects.toThrow();
        expect(h.count("push_attempts", fp)).toBe(0);
        expect(h.count("push_jobs", fp)).toBe(1);
      } finally {
        await h.close();
      }
    },
  );
  const cases: readonly RecoveryCase[] = [...notificationStoreScenarios, ...recoveryCases];
  for (const scenario of cases) {
    it(scenario.name, async () => {
      const phone = recoveryCases.includes(scenario) ? recoveryPhoneFp : "phone";
      const h = fixture();
      const fp = notificationComputerFp;
      const create = () => h.database.notifications(fp);
      // Stable facade lets the contract retain a handle across actual database reopen.
      const store = new Proxy({} as ReturnType<typeof create>, {
        get(_target, key) {
          const current = create();
          return current[key as keyof typeof current].bind(current);
        },
      });
      const addPhone = async (phone: string) => {
        h.sql
          .prepare(
            "INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, name, paired_at) VALUES (?, ?, ?, 'Phone', 1000)",
          )
          .run(fp, phone, new Uint8Array(32));
        await store.register(phone, tokenMessage, `generation-${phone}`);
      };
      try {
        await addPhone(phone);
        await scenario.run(
          {
            store,
            corrupt(field) {
              const assignments = {
                dueAt: "due_at = -1",
                expiresAt: "expires_at = -1",
                sendCount: "send_count = -1",
              };
              h.sql
                .prepare(
                  `UPDATE push_jobs SET ${assignments[field]} WHERE computer_fp = ? AND session_id = 'one'`,
                )
                .run(fp);
            },
            repair() {
              h.sql
                .prepare(
                  "UPDATE push_jobs SET due_at = 1000, expires_at = 3601000, send_count = 0 WHERE computer_fp = ? AND session_id = 'one'",
                )
                .run(fp);
            },
            revoke: async () => {
              await h.database.identity(fp).revoke(phone, true, 1001);
            },
            restart() {
              h.restart();
              return store;
            },
            addPhone,
            attentive: h.attentive,
            attempts: () => h.count("push_attempts", fp),
            jobCount: () => h.count("push_jobs", fp),
            ringCount: () => h.count("ring_limits", fp),
            token: () =>
              (h.sql
                .prepare("SELECT push_token FROM pairings WHERE computer_fp = ? AND phone_fp = ?")
                .get(fp, phone)?.push_token as string | null) ?? null,
            seedLegacyBudget(count, at) {
              h.sql
                .prepare("INSERT INTO push_limits VALUES (?, ?, ?, ?)")
                .run(fp, phone, at, count);
            },
            seedAttempt(at) {
              h.sql
                .prepare(
                  "INSERT INTO push_attempts (computer_fp, phone_fp, attempted_at) VALUES (?, ?, ?)",
                )
                .run(fp, phone, at);
            },
            budgetSnapshot() {
              const budget = h.sql.prepare("SELECT * FROM push_limits WHERE computer_fp = ?");
              const attempts = h.sql.prepare(
                "SELECT * FROM push_attempts WHERE computer_fp = ? ORDER BY id",
              );
              budget.setReadBigInts(true);
              attempts.setReadBigInts(true);
              return [budget.all(fp), attempts.all(fp)];
            },
            failClaim() {
              h.sql.exec(
                "CREATE TRIGGER fail_claim BEFORE UPDATE ON push_jobs BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END",
              );
            },
            clearFailure() {
              h.sql.exec("DROP TRIGGER fail_claim");
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
