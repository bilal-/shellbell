import { describe, expect, it } from "vitest";
import type { Claim, Job, Registration } from "../src/notifications/models.js";
import {
  claimJob,
  dispatchable,
  newJob,
  notificationDeadline,
  ownsClaim,
  recoverJob,
  sendCompleted,
} from "../src/notifications/policy.js";
import type { NotificationProvider, SendOutcome } from "../src/notifications/provider.js";
import { createNotificationService } from "../src/notifications/service.js";
import type { NotificationStore } from "../src/ports/notification-store.js";
import { notice, tokenMessage } from "../test-support/notification-store-contract.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const registration: Registration = {
  generation: "generation",
  token: tokenMessage.token,
  enabled: true,
  platform: "ios",
  provider: "apns",
  environment: "production",
  features: [],
};
// Local persistence double for orchestration tests. Real atomic SQL/budget/cap contracts
// run separately against Durable Objects; this double does not claim to model them.
function harness() {
  let job: Job | undefined;
  let reg = registration;
  let now = 1000;
  let serial = 0;
  let providerCalls = 0;
  const store: NotificationStore = {
    async register(_phone, message, generation) {
      reg = { ...reg, generation, token: message.token, enabled: message.enabled };
      job = undefined;
    },
    async enqueue(message, at) {
      job = newJob(`job-${++serial}`, "phone", reg.generation, message, at, undefined);
    },
    async cancelPhone() {
      job = undefined;
    },
    async recover(at) {
      job = job ? (recoverJob(job, reg, false, at) ?? undefined) : undefined;
    },
    async claimSends(at) {
      await store.recover(at);
      if (job?.state !== "pending-send" || job.dueAt > at) return [];
      job = claimJob(job, `claim-${++serial}`, at) ?? undefined;
      return job ? [{ job: structuredClone(job), token: reg.token!, registration: reg }] : [];
    },
    async isCurrent(claim, at) {
      return dispatchable(claim, job, reg, false, at);
    },
    async finishSend(claim, outcome, at) {
      if (ownsClaim(claim, job, reg, false, at))
        job = sendCompleted(job!, outcome, at).job ?? undefined;
    },
    async nextDeadline() {
      return notificationDeadline(job ? [job] : []);
    },
  };
  const provider: NotificationProvider = {
    async send(messages) {
      providerCalls++;
      return messages.map(() => ({ status: "accepted" }));
    },
  };
  const create = (schedule = async () => {}) =>
    createNotificationService({
      store,
      provider,
      computerFp: "computer",
      schedule,
      now: () => now,
      randomId: () => `generation-${++serial}`,
    });
  return {
    store,
    provider,
    create,
    advance: (at: number) => {
      now = at;
    },
    calls: () => providerCalls,
  };
}

describe("notification orchestration and recovery", () => {
  it("keeps all persistence entry points independent of provider I/O", async () => {
    const h = harness();
    const service = h.create();
    await service.register("phone", tokenMessage);
    await service.enqueue(notice());
    expect(await service.nextDeadline()).toBe(1000);
    await service.cancelPhone("phone");
    expect(await service.nextDeadline()).toBeNull();
    expect(h.calls()).toBe(0);
  });
  it("persists claim deadlines before dispatch and scrubs accepted content", async () => {
    const h = harness();
    const deadlines: (number | null)[] = [];
    const service = h.create(async () => {
      deadlines.push(await h.store.nextDeadline());
    });
    await service.enqueue(notice());
    await service.pump();
    expect(deadlines).toEqual([11000, null]);
    h.advance(901000);
    await service.pump();
    expect(await service.nextDeadline()).toBeNull();
    expect(h.calls()).toBe(1);
  });
  it.each(["cancel", "renew"] as const)(
    "fences dispatch after %s during awaited scheduling",
    async (action) => {
      const h = harness();
      const started = deferred<void>();
      const release = deferred<void>();
      let first = true;
      const service = h.create(async () => {
        if (first) {
          first = false;
          started.resolve();
          await release.promise;
        }
      });
      await service.enqueue(notice());
      const pending = service.pump();
      await started.promise;
      if (action === "cancel") await service.cancelPhone("phone");
      else await service.register("phone", tokenMessage);
      release.resolve();
      await pending;
      expect(h.calls()).toBe(0);
      expect(await service.nextDeadline()).toBeNull();
    },
  );
  it("cancels while provider is unresolved, then fences completion after a restart", async () => {
    const h = harness();
    const started = deferred<void>();
    const response = deferred<readonly SendOutcome[]>();
    h.provider.send = async () => {
      started.resolve();
      return response.promise;
    };
    const service = h.create();
    await service.enqueue(notice());
    const pending = service.pump();
    await started.promise;
    const restarted = h.create();
    await restarted.cancelPhone("phone");
    expect(await restarted.nextDeadline()).toBeNull();
    response.resolve([{ status: "accepted" }]);
    await pending;
    expect(await restarted.nextDeadline()).toBeNull();
  });
  it("coalesces simultaneous pump calls and leaves crashed provider work recoverable", async () => {
    const h = harness();
    const started = deferred<void>();
    const response = deferred<readonly SendOutcome[]>();
    h.provider.send = async () => {
      started.resolve();
      return response.promise;
    };
    const service = h.create();
    await service.enqueue(notice());
    const first = service.pump();
    await started.promise;
    const second = service.pump();
    expect(second).toBe(first);
    response.resolve([{ status: "retryable", code: "network" }]);
    await first;
    expect(await service.nextDeadline()).toBe(6000);
    h.advance(6000);
    h.provider.send = async () => {
      throw new Error("provider crashed");
    };
    await expect(service.pump()).rejects.toThrow("provider crashed");
    expect(await service.nextDeadline()).toBe(16000);
    h.advance(16000);
    await h.create().pump();
    expect(await service.nextDeadline()).toBe(46000);
  });
});

describe("pure durable job policy", () => {
  it("does not mutate snapshots when claiming, recovering or completing", () => {
    const initial = Object.freeze(newJob("job", "phone", "generation", notice(), 1000, undefined));
    const claimed = Object.freeze(claimJob(initial, "claim", 1000)!);
    expect(initial.sendCount).toBe(0);
    expect(claimed.sendCount).toBe(1);
    expect(recoverJob(claimed, registration, false, 11000)?.dueAt).toBe(16000);
    expect(sendCompleted(claimed, { status: "accepted" }, 1001).job).toBeNull();
    expect(claimed.sessionId).toBe("session");
  });
  it("checks both generation and claim lease at exact expiry", () => {
    const job = claimJob(
      newJob("job", "phone", "generation", notice(), 1000, undefined),
      "claim",
      1000,
    )!;
    const claim: Claim = { job, token: tokenMessage.token, registration };
    expect(ownsClaim(claim, job, registration, false, 10999)).toBe(true);
    expect(ownsClaim(claim, job, registration, false, 11000)).toBe(false);
    expect(ownsClaim(claim, job, { ...registration, generation: "renewed" }, false, 1000)).toBe(
      false,
    );
    expect(ownsClaim(claim, { ...job, claimId: "replacement" }, registration, false, 1000)).toBe(
      false,
    );
  });
});
