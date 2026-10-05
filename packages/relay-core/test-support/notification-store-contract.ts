import type { CtrlMessageOf } from "@shellbell/protocol";
import fixture from "../../protocol/test/notification-vectors.json";
import type { NotificationStore } from "../src/ports/notification-store.js";

export const tokenMessage: CtrlMessageOf<"push-token"> = {
  type: "push-token",
  token: "a".repeat(64),
  provider: "apns",
  environment: "production",
  platform: "ios",
  enabled: true,
};
export const notificationComputerFp = fixture.box.computerFp;
export const notice = (sessionId = "session"): CtrlMessageOf<"notify"> => ({
  type: "notify",
  sessionId,
  kind: "idle",
});
export interface NotificationHarness {
  store: NotificationStore;
  restart(): NotificationStore;
  addPhone(phone: string): Promise<void>;
  attentive(value: boolean): void;
  attempts(): number;
  token(): string | null;
  jobCount(): number;
  ringCount(): number;
  failClaim(): void;
  clearFailure(): void;
  seedLegacyBudget(count: number | string, at: number | string): void;
  seedAttempt(at: number | string): void;
  budgetSnapshot(): unknown;
}
type Equal = (actual: unknown, expected: unknown) => void;
type Scenario = { name: string; run(h: NotificationHarness, equal: Equal): Promise<void> };
export const notificationStoreScenarios: readonly Scenario[] = [
  {
    name: "rejects invalid native registration before cancelling current work",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      let rejected = false;
      try {
        await h.store.register(
          "phone",
          { ...tokenMessage, environment: undefined } as unknown as CtrlMessageOf<"push-token">,
          "invalid",
        );
      } catch {
        rejected = true;
      }
      eq(rejected, true);
      eq(await h.store.isCurrent(claim!, 1001), true);
      eq(h.token(), tokenMessage.token);
    },
  },
  {
    name: "bounds acceptance tombstones with pending jobs and expires dedupe at one hour",
    async run(h, eq) {
      for (let index = 0; index < 21; index++) {
        await h.store.enqueue(
          {
            type: "notify-context",
            sessionId: `session-${index}`,
            eventId: `${String.fromCharCode(65 + index)}${fixture.box.eventId.slice(1)}`,
            kind: "idle",
            boxes: [],
          },
          1000,
        );
        eq(h.jobCount(), index < 20 ? 1 : 0);
        const [claim] = await h.store.claimSends(1000, 10);
        if (claim) await h.store.finishSend(claim, { status: "accepted" }, 1000);
      }
      eq(h.attempts(), 20);
      eq(h.jobCount(), 0);
      eq(await h.restart().nextDeadline(), 3601000);
      await h.store.recover(3601000);
      eq(await h.store.nextDeadline(), null);
      await h.store.enqueue(notice("new-after-expiry"), 3601000);
      eq((await h.store.claimSends(3601000, 10)).length, 1);
    },
  },
  {
    name: "accepted sends remove jobs and retain spent attempts across restart",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      await h.store.finishSend(claim!, { status: "accepted" }, 1001);
      eq(h.jobCount(), 0);
      eq(await h.restart().nextDeadline(), null);
      eq((await h.store.claimSends(901000, 10)).length, 0);
      eq(h.attempts(), 1);
    },
  },
  {
    name: "APNs retry hints expire stale rings without refunding budget",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      await h.store.finishSend(
        claim!,
        { status: "retryable", code: "http-server", retryAfterMs: 900000 },
        1001,
      );
      eq(h.jobCount(), 0);
      eq(h.attempts(), 1);
      eq(h.token(), tokenMessage.token);
    },
  },
  {
    name: "rotated token survives a stale unregistered result across restart",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      await h.store.register("phone", { ...tokenMessage, token: "b".repeat(64) }, "rotated");
      await h.restart().finishSend(claim!, { status: "unregistered" }, 1001);
      eq(h.token(), "b".repeat(64));
      eq(h.attempts(), 1);
    },
  },
  ...[
    { count: -20, at: 4_000_000, attempt: 1000 },
    { count: 9007199254740992, at: 1000, attempt: 1000 },
    { count: -1, at: 0, attempt: 1000 },
    { count: 1, at: -1, attempt: 1000 },
    { count: 1, at: 9007199254740992, attempt: 1000 },
    { count: 1, at: 1000, attempt: -1 },
    { count: 1, at: 1000, attempt: 9007199254740992 },
  ].map(({ count, at, attempt }) => ({
    name: `rejects corrupt budget ${count}/${at}/${attempt} without cleanup or reservation`,
    async run(h: NotificationHarness, eq: Equal) {
      await h.store.enqueue(notice("expires-during-claim"), 3_880_001);
      await h.store.claimSends(3_880_001, 1);
      // Recovery mutates this interrupted claim in the failing transaction;
      // both that cleanup and all budget changes must roll back.
      await h.store.enqueue(notice("due"), 3_880_002);
      h.seedLegacyBudget(count, at);
      h.seedAttempt(1000);
      h.seedAttempt(attempt);
      const before = h.budgetSnapshot();
      const jobs = h.jobCount();
      const deadline = await h.store.nextDeadline();
      let rejected = false;
      try {
        await h.store.claimSends(4_000_000, 10);
      } catch {
        rejected = true;
      }
      eq(rejected, true);
      eq(h.budgetSnapshot(), before);
      eq(h.jobCount(), jobs);
      eq(await h.store.nextDeadline(), deadline);
    },
  })),
  {
    name: "persists recipient-isolated context and dedupes encrypted events across restart",
    async run(h, eq) {
      const first = fixture.box;
      const second = { ...first, phoneFp: "c".repeat(26), ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBE" };
      for (const box of [first, second]) {
        await h.addPhone(box.phoneFp);
        await h.store.register(
          box.phoneFp,
          { ...tokenMessage, features: ["notify-context-v1"] },
          box.phoneFp,
        );
      }
      const message: CtrlMessageOf<"notify-context"> = {
        type: "notify-context",
        sessionId: first.sessionId,
        eventId: first.eventId,
        kind: "blocked",
        boxes: [first, second],
      };
      await h.store.enqueue(message, 1000);
      const restarted = h.restart();
      const claims = await restarted.claimSends(1000, 10);
      eq(claims.length, 3);
      eq(claims.find((c) => c.job.phoneFp === first.phoneFp)?.job.context, first);
      eq(claims.find((c) => c.job.phoneFp === second.phoneFp)?.job.context, second);
      eq(claims.find((c) => c.job.phoneFp === "phone")?.job.context, null);
      for (const claim of claims) await restarted.finishSend(claim, { status: "accepted" }, 1000);
      await restarted.enqueue(message, 61000);
      eq((await restarted.claimSends(61000, 10)).length, 0);
      eq(h.jobCount(), 0);
      eq(await restarted.nextDeadline(), 3601000);
      await restarted.recover(3601000);
      eq(await restarted.nextDeadline(), null);
    },
  },
  {
    name: "detaches snapshots from durable rows and retains unexpired claims after restart",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      eq(await h.restart().isCurrent(claim!, 10999), true);
      eq((await h.restart().claimSends(10999, 10)).length, 0);
      Object.assign(claim!.job, { dueAt: 99, sessionId: "mutated" });
      eq(await h.store.nextDeadline(), 11000);
      eq(await h.restart().isCurrent(claim!, 11000), false);
    },
  },
  {
    name: "bounds all computer jobs and preserves due work beyond each claim batch",
    async run(h, eq) {
      for (let p = 1; p < 10; p++) await h.addPhone(`phone-${p}`);
      for (let s = 0; s < 30; s++) await h.store.enqueue(notice(`session-${s}`), 1000);
      eq(h.jobCount(), 200);
      const sends = await h.store.claimSends(1000, 10);
      eq(sends.length, 10);
      eq(await h.store.nextDeadline(), 1000);
      for (const claim of sends) await h.store.finishSend(claim, { status: "accepted" }, 1000);
      for (let index = 0; index < 10; index++)
        await h.store.enqueue(notice(`over-cap-${index}`), 1001);
      eq(h.jobCount(), 200);
    },
  },
  {
    name: "counts partial legacy and late burst attempts without resetting the whole budget",
    async run(h, eq) {
      h.seedLegacyBudget(18, 1000);
      for (const [i, now] of [1000, 3500000, 3500001, 3601000, 3601001].entries()) {
        await h.store.enqueue(notice(`budget-${i}`), now);
        const claims = await h.store.claimSends(now, 10);
        eq(claims.length, i === 2 ? 0 : 1);
        if (claims[0])
          await h.store.finishSend(claims[0], { status: "rejected", code: "http-permanent" }, now);
      }
      eq(h.attempts(), 3);
    },
  },
  {
    name: "current dead-token result cancels all phone jobs without refunding attempts",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      await h.store.enqueue(notice("other"), 1000);
      const [claim] = await h.store.claimSends(1000, 1);
      await h.store.finishSend(claim!, { status: "unregistered" }, 1001);
      eq(h.token(), null);
      eq(await h.store.nextDeadline(), null);
      eq(h.attempts(), 1);
    },
  },
  {
    name: "fences accepted completion after cancellation and restart",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      eq(!!claim, true);
      await h.store.cancelPhone("phone");
      const restarted = h.restart();
      await restarted.finishSend(claim!, { status: "accepted" }, 1001);
      eq(await restarted.nextDeadline(), null);
      eq(h.attempts(), 1);
    },
  },
  {
    name: "same-token renewal fences old accepted and dead-token results",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(1000, 10);
      await h.store.register("phone", tokenMessage, "new-generation");
      await h.store.enqueue(notice("new"), 1001);
      await h.store.finishSend(claim!, { status: "unregistered" }, 1002);
      await h.store.finishSend(claim!, { status: "accepted" }, 1002);
      eq(h.token(), tokenMessage.token);
      eq(await h.store.nextDeadline(), 1001);
      eq(h.jobCount(), 1);
    },
  },
  {
    name: "reserves one attempt atomically across competing store instances",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const batches = await Promise.all([
        h.store.claimSends(1000, 10),
        h.restart().claimSends(1000, 10),
      ]);
      eq(batches.map((b) => b.length).sort(), [0, 1]);
      eq(h.attempts(), 1);
      eq(await h.store.nextDeadline(), 11000);
    },
  },
  {
    name: "rolls back attempt reservation if persisting the claim fails",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      h.failClaim();
      let failed = false;
      try {
        await h.store.claimSends(1000, 10);
      } catch {
        failed = true;
      }
      h.clearFailure();
      eq(failed, true);
      eq(h.attempts(), 0);
      eq(await h.store.nextDeadline(), 1000);
      eq((await h.store.claimSends(1000, 10)).length, 1);
    },
  },
  {
    name: "recovery retains spent attempts and fences expired claims",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [old] = await h.store.claimSends(1000, 10);
      const restarted = h.restart();
      await restarted.recover(11000);
      eq(await restarted.nextDeadline(), 16000);
      await restarted.finishSend(old!, { status: "accepted" }, 11000);
      eq(await restarted.nextDeadline(), 16000);
      const [second] = await restarted.claimSends(16000, 10);
      eq(second!.job.sendCount, 2);
      await restarted.finishSend(old!, { status: "unregistered" }, 16001);
      eq(h.token(), tokenMessage.token);
      await restarted.recover(26000);
      eq(await restarted.nextDeadline(), 56000);
      eq((await restarted.claimSends(56000, 10))[0]!.job.sendCount, 3);
      await restarted.recover(66000);
      eq(await restarted.nextDeadline(), null);
      eq(h.attempts(), 3);
    },
  },
  {
    name: "retryable failures stop at three sends without refunding the budget",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      for (const now of [1000, 6000, 36000]) {
        const [claim] = await h.store.claimSends(now, 10);
        eq(!!claim, true);
        await h.store.finishSend(claim!, { status: "retryable", code: "network" }, now);
      }
      eq(await h.store.nextDeadline(), null);
      eq(h.attempts(), 3);
    },
  },
  {
    name: "freshness expires at exactly two minutes and rejects late retry scheduling",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [claim] = await h.store.claimSends(117000, 10);
      await h.store.finishSend(claim!, { status: "retryable", code: "network" }, 117000);
      eq(await h.store.nextDeadline(), null);
      await h.store.enqueue(notice("next"), 200000);
      eq((await h.store.claimSends(320000, 10)).length, 0);
      eq(await h.store.nextDeadline(), null);
    },
  },
  {
    name: "rolling hourly budget admits twenty attempts and expires at the boundary",
    async run(h, eq) {
      for (let i = 0; i < 21; i++) {
        await h.store.enqueue(notice(`s${i}`), 1000 + i);
        const claims = await h.store.claimSends(1000 + i, 10);
        eq(claims.length, i < 20 ? 1 : 0);
        if (claims[0])
          await h.store.finishSend(
            claims[0],
            { status: "rejected", code: "invalid-payload" },
            1000 + i,
          );
      }
      eq(h.attempts(), 20);
      await h.store.enqueue(notice("boundary"), 3601000);
      eq((await h.store.claimSends(3601000, 10)).length, 1);
      eq(h.attempts(), 20);
    },
  },
  {
    name: "counts legacy budget until its window expires",
    async run(h, eq) {
      h.seedLegacyBudget(20, 1000);
      await h.store.enqueue(notice(), 3600999);
      eq((await h.store.claimSends(3600999, 10)).length, 0);
      eq(h.attempts(), 0);
      await h.store.enqueue(notice("boundary"), 3601000);
      eq((await h.store.claimSends(3601000, 10)).length, 1);
      eq(h.attempts(), 1);
    },
  },
  {
    name: "attention cancels both pending and in-flight work",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      const [send] = await h.store.claimSends(1000, 10);
      h.attentive(true);
      await h.store.enqueue(notice("attentive"), 1001);
      await h.store.finishSend(send!, { status: "accepted" }, 1001);
      eq(await h.store.nextDeadline(), null);
      h.attentive(false);
      eq((await h.store.claimSends(1002, 10)).length, 0);
    },
  },
  {
    name: "ring gate rejects bursts then supersedes only at sixty seconds",
    async run(h, eq) {
      await h.store.enqueue(notice(), 1000);
      await h.store.enqueue(notice(), 60999);
      eq(await h.store.nextDeadline(), 1000);
      await h.store.enqueue(notice(), 61000);
      eq(await h.store.nextDeadline(), 61000);
      eq(h.jobCount(), 1);
      eq(h.ringCount(), 1);
    },
  },
  {
    name: "bounds ring and per-phone job rows",
    async run(h, eq) {
      for (let i = 0; i < 205; i++) await h.store.enqueue(notice(`s${i}`), 1000 + i);
      eq(h.ringCount(), 200);
      eq(h.jobCount(), 20);
    },
  },
];
