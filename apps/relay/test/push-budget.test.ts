import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FpSchema, fingerprint, sha256 } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { createCloudflareNotificationStore } from "../src/adapters/notification-store.js";
import type { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { agentOnline, pairPhone, TestDevice } from "./helpers.js";

const relayEnv = env as typeof env & Env;

function computer(name: string): DurableObjectStub<ComputerDO> {
  const fp = FpSchema.safeParse(name).success
    ? name
    : fingerprint(sha256(new TextEncoder().encode(name)));
  return relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(fp));
}

/** Drive real atomic send reservation with independent synthetic admissions. */
function budgetTaker(storage: DurableObjectStorage) {
  const sql = storage.sql;
  const store = createCloudflareNotificationStore(storage, {
    computerFp: "synthetic-computer",
    attentive: () => false,
    randomId: () => crypto.randomUUID(),
  });
  return async (phone: string, now: number) => {
    sql.exec(
      "INSERT OR IGNORE INTO pairings (phone_fp, ed25519_pub, name, paired_at) VALUES (?, ?, 'Synthetic phone', 0)",
      phone,
      new ArrayBuffer(32),
    );
    sql.exec("UPDATE pairings SET push_enabled = 0 WHERE phone_fp != ?", phone);
    sql.exec(
      "UPDATE pairings SET push_token = 'native-budget-token', push_provider = 'fcm', push_platform = 'android', push_environment = NULL, push_enabled = 1 WHERE phone_fp = ?",
      phone,
    );
    await store.enqueue({ type: "notify", sessionId: crypto.randomUUID(), kind: "idle" }, now);
    const claims = await store.claimSends(now, 1);
    await store.cancelPhone(phone);
    return claims.some((claim) => claim.job.phoneFp === phone);
  };
}

function inBudget<R>(
  stub: DurableObjectStub<ComputerDO>,
  callback: (sql: SqlStorage, take: ReturnType<typeof budgetTaker>) => R,
): Promise<R> {
  return runInDurableObject(stub, (_instance, state) =>
    callback(state.storage.sql, budgetTaker(state.storage)),
  );
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForAsync: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("push attempt budget", () => {
  it("expires an attempt at the exact one-hour boundary", async () => {
    const stub = computer("push-budget-exact-hour");

    await inBudget(stub, async (_sql, take) => {
      for (let i = 0; i < 20; i++) expect(await take("phone-a", 0)).toBe(true);
      expect(await take("phone-a", 3_600_000)).toBe(true);
    });
  });

  it("does not reset a late burst when the oldest attempt expires", async () => {
    const stub = computer("push-budget-rolling-boundary");

    await inBudget(stub, async (_sql, take) => {
      expect(await take("phone-a", 0)).toBe(true);
      for (let i = 0; i < 19; i++) expect(await take("phone-a", 3_599_999)).toBe(true);
      expect(await take("phone-a", 3_600_000)).toBe(true);
      expect(await take("phone-a", 3_600_001)).toBe(false);
    });
  });

  it("allows exactly 20 attempts in the same millisecond and refuses the 21st", async () => {
    await inBudget(computer("push-budget-same-millisecond"), async (_sql, take) => {
      for (let i = 0; i < 20; i++) expect(await take("phone-a", 12_345)).toBe(true);
      expect(await take("phone-a", 12_345)).toBe(false);
    });
  });

  it("keeps budgets independent between phones and Durable Objects", async () => {
    const firstComputer = computer("push-budget-independent-a");
    const secondComputer = computer("push-budget-independent-b");

    await inBudget(firstComputer, async (_sql, take) => {
      for (let i = 0; i < 20; i++) expect(await take("phone-a", 0)).toBe(true);
      expect(await take("phone-a", 0)).toBe(false);
      expect(await take("phone-b", 0)).toBe(true);
    });
    await inBudget(secondComputer, async (_sql, take) => {
      expect(await take("phone-a", 0)).toBe(true);
    });
  });

  it("persists exhausted budget across Durable Object eviction", async () => {
    const stub = computer("push-budget-eviction");
    await inBudget(stub, async (_sql, take) => {
      for (let i = 0; i < 20; i++) expect(await take("phone-a", 0)).toBe(true);
    });

    await evictDurableObject(stub);

    await inBudget(stub, async (_sql, take) => {
      expect(await take("phone-a", 1)).toBe(false);
    });
  });

  it("honors a full legacy reservation until its exact expiry", async () => {
    await inBudget(computer("push-budget-legacy-full"), async (sql, take) => {
      sql.exec(
        "INSERT INTO push_limits (phone_fp, window_start, count) VALUES (?, ?, ?)",
        "phone-a",
        0,
        20,
      );

      expect(await take("phone-a", 3_599_999)).toBe(false);
      expect(await take("phone-a", 3_600_000)).toBe(true);
      expect(
        sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM push_limits WHERE phone_fp = ?",
            "phone-a",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("allows only the remainder of a partial legacy reservation", async () => {
    await inBudget(computer("push-budget-legacy-partial"), async (sql, take) => {
      sql.exec(
        "INSERT INTO push_limits (phone_fp, window_start, count) VALUES (?, ?, ?)",
        "phone-a",
        0,
        7,
      );

      for (let i = 0; i < 13; i++) {
        expect(await take("phone-a", 3_599_999)).toBe(true);
      }
      expect(await take("phone-a", 3_599_999)).toBe(false);
    });
  });

  it("keeps at most 20 timestamp rows per phone", async () => {
    await inBudget(computer("push-budget-bounded-rows"), async (sql, take) => {
      for (let i = 0; i < 100; i++) await take("phone-a", 0);
      for (let i = 0; i < 100; i++) await take("phone-b", 1);

      expect(
        sql
          .exec<{ phone_fp: string; count: number }>(
            "SELECT phone_fp, COUNT(*) AS count FROM push_attempts GROUP BY phone_fp ORDER BY phone_fp",
          )
          .toArray(),
      ).toEqual([
        { phone_fp: "phone-a", count: 20 },
        { phone_fp: "phone-b", count: 20 },
      ]);

      expect(await take("phone-a", 3_600_000)).toBe(true);
      expect(
        sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM push_attempts WHERE phone_fp = ?",
            "phone-a",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("removes attempt rows when a phone is unpaired", async () => {
    const mac = new TestDevice("Budget cleanup Mac");
    const phone = new TestDevice("Budget cleanup phone");
    const stub = computer(mac.fp);
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    await inBudget(stub, async (_sql, take) => {
      expect(await take(phone.fp, 0)).toBe(true);
    });

    agent.sendCtrl(mac.fp, { type: "unpair", phoneFp: phone.fp });

    await waitForAsync(async () =>
      inBudget(stub, (sql) => {
        const attempts = sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM push_attempts WHERE phone_fp = ?",
            phone.fp,
          )
          .one().count;
        const pairings = sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM pairings WHERE phone_fp = ?",
            phone.fp,
          )
          .one().count;
        return attempts === 0 && pairings === 0;
      }),
    );
    agent.ws.close();
  });

  it("removes attempt rows during retention cleanup", async () => {
    const name = "push-budget-retention";
    const stub = computer(name);

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
        state.id.name!,
        sha256(new TextEncoder().encode(name)).buffer as ArrayBuffer,
        "old computer",
        0,
        Date.now() - 90 * 24 * 3_600_000 - 1,
      );
      expect(await budgetTaker(state.storage)("phone-a", 0)).toBe(true);

      await instance.alarm();

      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM push_attempts")
          .one().count,
      ).toBe(0);
    });
  });
});
