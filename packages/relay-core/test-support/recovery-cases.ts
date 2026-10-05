import type { NotificationProvider, SendOutcome } from "../src/notifications/provider.js";
import { createNotificationService } from "../src/notifications/service.js";
import type { NotificationStore } from "../src/ports/notification-store.js";
import { notice, tokenMessage } from "./notification-store-contract.js";
import { deferred, type RecoveryCase } from "./repository-contracts.js";

export const recoveryPhoneFp = "b".repeat(26);

function service(store: NotificationStore, provider: NotificationProvider, now: () => number) {
  return createNotificationService({
    store,
    provider,
    computerFp: "computer",
    now,
    randomId: () => "rotated-generation",
    schedule: async () => {},
  });
}
function heldProvider() {
  const entered = deferred<void>();
  const result = deferred<readonly SendOutcome[]>();
  let calls = 0;
  const provider: NotificationProvider = {
    async send() {
      calls++;
      entered.resolve();
      return result.promise;
    },
  };
  return { provider, entered, result, calls: () => calls };
}

export const recoveryCases: readonly RecoveryCase[] = [
  {
    name: "process loss after provider acceptance retains a spent attempt and permits only bounded retries",
    async run(h, eq) {
      let now = 1000;
      const first = heldProvider();
      const old = service(h.store, first.provider, () => now);
      await old.enqueue(notice());
      const pending = old.pump();
      await first.entered.promise;
      // The external provider accepted, but its response never reaches durable commit.
      // Reject at the I/O boundary to abandon that process's pass before finishSend.
      const lost = pending.catch(() => "lost");
      first.result.reject(new Error("process lost after external acceptance"));
      eq(await lost, "lost");
      eq(h.attempts(), 1);
      const restarted = h.restart();
      eq(await restarted.nextDeadline(), 11000);
      const retry = heldProvider();
      retry.result.resolve([{ status: "retryable", code: "network" }]);
      const recovered = service(restarted, retry.provider, () => now);
      now = 11000;
      await recovered.pump();
      eq(retry.calls(), 0);
      eq(await restarted.nextDeadline(), 16000);
      now = 16000;
      await recovered.pump();
      now = 46000;
      await recovered.pump();
      eq(retry.calls(), 2);
      eq(h.attempts(), 3);
      eq(await restarted.nextDeadline(), null);
    },
  },
  {
    name: "duplicate wakeups at exact claim expiry fence a held result and reserve one replacement",
    async run(h, eq) {
      let now = 1000;
      const first = heldProvider();
      const old = service(h.store, first.provider, () => now);
      await old.enqueue(notice());
      const pending = old.pump();
      await first.entered.promise;
      const replacement = heldProvider();
      // Separate services model duplicate runtimes, not the service's in-memory coalescer.
      const a = service(h.store, replacement.provider, () => now);
      const b = service(h.store, replacement.provider, () => now);
      now = 11000;
      await Promise.all([a.pump(), b.pump()]);
      eq(replacement.calls(), 0);
      eq(await h.store.nextDeadline(), 16000);
      first.result.resolve([{ status: "unregistered" }]);
      await pending;
      eq(h.token(), tokenMessage.token);
      eq(await h.store.nextDeadline(), 16000);
      now = 16000;
      const pumps = [a.pump(), b.pump()];
      await replacement.entered.promise;
      replacement.result.resolve([{ status: "accepted" }]);
      await Promise.all(pumps);
      eq(replacement.calls(), 1);
      eq(h.attempts(), 2);
      eq(await h.store.nextDeadline(), null);
    },
  },
  ...(["accepted", "unregistered"] as const).map(
    (status): RecoveryCase => ({
      name: `rotation during held I/O fences stale ${status} results`,
      async run(h, eq) {
        const first = heldProvider();
        const old = service(h.store, first.provider, () => 1000);
        await old.enqueue(notice());
        const pending = old.pump();
        await first.entered.promise;
        await h.store.register(recoveryPhoneFp, tokenMessage, "rotated-generation");
        await h.store.enqueue(notice("replacement"), 1001);
        first.result.resolve([status === "accepted" ? { status } : { status }]);
        await pending;
        eq(h.token(), tokenMessage.token);
        eq(h.jobCount(), 1);
        eq(await h.store.nextDeadline(), 1001);
        const [claim] = await h.store.claimSends(1001, 10);
        eq(claim?.registration.generation, "rotated-generation");
        eq(claim?.job.sessionId, "replacement");
      },
    }),
  ),
  {
    name: "identity revocation completes during held provider I/O and late acceptance cannot resurrect work",
    async run(h, eq) {
      const first = heldProvider();
      const old = service(h.store, first.provider, () => 1000);
      await old.enqueue(notice());
      const pending = old.pump();
      await first.entered.promise;
      await h.revoke();
      eq(h.token(), null);
      eq(h.jobCount(), 0);
      first.result.resolve([{ status: "accepted" }]);
      await pending;
      eq(await h.store.nextDeadline(), null);
      eq((await h.store.claimSends(1001, 10)).length, 0);
    },
  },
  ...(["dueAt", "expiresAt", "sendCount"] as const).map(
    (field): RecoveryCase => ({
      name: `malformed persisted ${field} fails closed without spending the final budget slot`,
      async run(h, eq) {
        h.seedLegacyBudget(19, 1000);
        await h.store.enqueue(notice("one"), 1000);
        await h.store.enqueue(notice("two"), 1000);
        h.corrupt(field);
        const results = await Promise.allSettled([
          h.store.claimSends(1000, 1),
          h.store.claimSends(1000, 1),
        ]);
        eq(
          results.map((result) => result.status),
          ["rejected", "rejected"],
        );
        eq(h.attempts(), 0);
        eq(h.jobCount(), 2);
        // One invalid row blocks its valid neighbor, without consuming its budget.
        // Simulate an operator restoring only the known-good fixture fields.
        h.repair();
        eq((await h.store.claimSends(1000, 1)).length, 1);
        eq(h.attempts(), 1);
      },
    }),
  ),
  {
    name: "concurrent final-budget reservations roll back on claim failure then admit exactly one send",
    async run(h, eq) {
      h.seedLegacyBudget(19, 1000);
      await h.store.enqueue(notice("one"), 1000);
      await h.store.enqueue(notice("two"), 1000);
      h.failClaim();
      const failed = await Promise.allSettled([
        h.store.claimSends(1000, 1),
        h.store.claimSends(1000, 1),
      ]);
      h.clearFailure();
      eq(
        failed.map((result) => result.status),
        ["rejected", "rejected"],
      );
      eq(h.attempts(), 0);
      eq(h.jobCount(), 2);
      const batches = await Promise.all([h.store.claimSends(1000, 1), h.store.claimSends(1000, 1)]);
      eq(batches.map((claims) => claims.length).sort(), [0, 1]);
      eq(h.attempts(), 1);
      eq(h.jobCount(), 1);
    },
  },
];
