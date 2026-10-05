import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { toBase64Url } from "@shellbell/protocol";
import type { NotificationProvider, PushIntent, SendOutcome } from "@shellbell/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import transportFixture from "../../../packages/protocol/test/notification-transport-vectors.json";
import fixture from "../../../packages/protocol/test/notification-vectors.json";
import type { Env } from "../src/env.js";
import { upgradePushContextSchema } from "../src/schema.js";
import { createPushJobsHarness, type PushJobs } from "./push-jobs-harness.js";

const relayEnv = env as typeof env & Env;
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network request");
    }),
  ),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Row = {
  id: string;
  phase: string;
  due_at: number;
  expires_at: number;
  admitted_at: number;
  claim_until: number | null;
  claim_id: string | null;
  send_count: number;
  check_count: number;
  session_id: string | null;
  kind: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  ticket_id: string | null;
  generation: string;
};
async function harness(
  test: (h: {
    jobs: PushJobs;
    sql: SqlStorage;
    storage: DurableObjectStorage;
    rows: () => Row[];
    attempts: () => number;
    enqueue: (session?: string) => Promise<void>;
    enqueueRich: (session?: string) => Promise<void>;
    addPhone: (phone: string) => void;
    now: () => number;
    advance: (ms: number) => void;
    sends: PushIntent[][];
    reply: (send: SendOutcome) => void;
    hold: (kind: "send") => { started: Promise<void>; release: () => void };
    schedule: (fn: () => Promise<void>) => void;
    attentive: (yes: boolean) => void;
    reconstruct: (computerFp?: string) => PushJobs;
  }) => Promise<void>,
) {
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    let time = Date.now();
    let attention = false;
    let schedule = async () => {};
    let sendReply: SendOutcome | undefined;
    let barrier:
      | {
          kind: string;
          started: ReturnType<typeof deferred<void>>;
          released: ReturnType<typeof deferred<void>>;
        }
      | undefined;
    const sends: PushIntent[][] = [];
    const provider: NotificationProvider = {
      async send(intents) {
        sends.push([...intents]);
        if (barrier) {
          const b = barrier;
          barrier = undefined;
          b.started.resolve();
          await b.released.promise;
        }
        const outcome: SendOutcome = sendReply ?? { status: "accepted" };
        return intents.map(() => outcome);
      },
    };
    const reconstruct = (computerFp = "computer") =>
      createPushJobsHarness(state.storage, {
        computerFp,
        now: () => time,
        attentive: () => attention,
        schedule: () => schedule(),
        provider,
      });
    const jobs = reconstruct();
    const addPhone = (phone: string) =>
      sql.exec(
        "INSERT INTO pairings (phone_fp, ed25519_pub, name, push_token, push_provider, push_platform, push_enabled, paired_at) VALUES (?, ?, 'private-phone-name', ?, 'fcm', 'android', 1, ?)",
        phone,
        new ArrayBuffer(32),
        `native-private-${phone}]`,
        time,
      );
    sql.exec(
      "INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES ('computer', ?, 'private-computer-name', ?, ?)",
      new ArrayBuffer(32),
      time,
      time,
    );
    addPhone("phone");
    await test({
      jobs,
      sql,
      storage: state.storage,
      reconstruct,
      addPhone,
      sends,
      rows: () => sql.exec<Row>("SELECT * FROM push_jobs ORDER BY admitted_at, id").toArray(),
      attempts: () => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM push_attempts").one().n,
      enqueue: async (session = "session") =>
        jobs.enqueue({
          type: "notify",
          sessionId: session,
          kind: "prompt",
          exitCode: 0,
          durationMs: 1234,
        }),
      enqueueRich: async (session = "session") =>
        jobs.enqueue({
          type: "notify-context",
          sessionId: session,
          kind: "prompt",
          eventId: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
          boxes: [],
        }),
      now: () => time,
      advance: (ms) => {
        time += ms;
      },
      attentive: (yes) => {
        attention = yes;
      },
      reply: (send) => {
        sendReply = send;
      },
      schedule: (fn) => {
        schedule = fn;
      },
      hold: (kind) => {
        const b = { kind, started: deferred<void>(), released: deferred<void>() };
        barrier = b;
        return { started: b.started.promise, release: () => b.released.resolve() };
      },
    });
  });
}

describe("bounded durable notification jobs", () => {
  it.each([
    { priorAttempts: 0, expectedSends: 2 },
    { priorAttempts: 19, expectedSends: 1 },
  ])(
    "dispatches $expectedSends of two rich sessions after $priorAttempts attempts",
    async ({ priorAttempts, expectedSends }) => {
      await harness(async (h) => {
        h.advance(1000 - h.now());
        h.sql.exec("UPDATE pairings SET push_enabled = 0 WHERE phone_fp = 'phone'");
        const first = transportFixture.cases[0]!.box;
        h.addPhone(first.phoneFp);
        const jobs = h.reconstruct(first.computerFp);
        await jobs.register(first.phoneFp, {
          type: "push-token",
          token: "native-private-rich-budget]",
          platform: "android",
          provider: "fcm",
          enabled: true,
          features: ["notify-context-v1"],
        });
        for (let i = 0; i < priorAttempts; i++) {
          h.sql.exec(
            "INSERT INTO push_attempts (phone_fp, attempted_at) VALUES (?, ?)",
            first.phoneFp,
            h.now() - 1,
          );
        }
        for (const { box } of transportFixture.cases) {
          await jobs.enqueue({
            type: "notify-context",
            sessionId: box.sessionId,
            eventId: box.eventId,
            kind: "idle",
            boxes: [box],
          });
        }
        expect(h.rows()).toHaveLength(2);
        await jobs.pump();
        const sent = h.sends.flat();
        expect(sent).toHaveLength(expectedSends);
        expect(new Set(sent.map((message) => message.group)).size).toBe(expectedSends);
        for (const message of sent) {
          const expected = transportFixture.cases.find(
            ({ box }) => box.sessionId === message.route.sessionId,
          )!;
          expect(message.box).toEqual(expected.box);
          expect(message.genericTitle).toBeTruthy();
          expect(message.genericBody).toBeTruthy();
        }
        expect(h.attempts()).toBe(priorAttempts + expectedSends);
        expect(h.rows()).toHaveLength(0);
        expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(expectedSends);
      });
    },
  );
  it("upgrades an existing journal additively and idempotently without losing pending sends", async () => {
    await harness(async (h) => {
      await h.enqueue();
      const id = h.rows()[0]!.id;
      h.sql.exec(
        "ALTER TABLE push_jobs DROP COLUMN context_json; ALTER TABLE push_registrations DROP COLUMN features;",
      );
      upgradePushContextSchema(h.sql);
      upgradePushContextSchema(h.sql);
      expect(h.rows()[0]!.id).toBe(id);
      await h.reconstruct().pump();
      expect(h.sends.flat()).toHaveLength(1);
      expect(h.sends[0]![0]!).not.toHaveProperty("box");
    });
  });
  it("persists recipient-isolated ciphertext across reconstruction and dedupes the logical event", async () => {
    await harness(async (h) => {
      const first = fixture.box;
      const second = {
        ...first,
        phoneFp: "c".repeat(26),
        ciphertext: toBase64Url(new Uint8Array(17).fill(3)),
      };
      const unpaired = { ...first, phoneFp: "d".repeat(26) };
      h.addPhone(first.phoneFp);
      h.addPhone(second.phoneFp);
      const jobs = h.reconstruct(first.computerFp);
      for (const [box, platform] of [
        [first, "ios"],
        [second, "android"],
      ] as const)
        await jobs.register(box.phoneFp, {
          type: "push-token",
          token: `native-private-${box.phoneFp}]`,
          ...(platform === "ios"
            ? { platform, provider: "apns" as const, environment: "production" as const }
            : { platform, provider: "fcm" as const }),
          enabled: true,
          features: ["notify-context-v1"],
        });
      const message = {
        type: "notify-context" as const,
        sessionId: first.sessionId,
        eventId: first.eventId,
        kind: "blocked" as const,
        boxes: [first, second, unpaired],
      };
      await jobs.enqueue(message);
      await h.reconstruct(first.computerFp).pump();
      const sends = h.sends.flat();
      expect(sends).toHaveLength(3);
      expect(sends.find((m) => m.destination.token.includes(first.phoneFp))?.box).toEqual(first);
      expect(sends.find((m) => m.destination.token.includes(second.phoneFp))?.box).toEqual(second);
      expect(sends.find((m) => m.destination.token === "native-private-phone]")).not.toHaveProperty(
        "box",
      );
      expect(
        JSON.stringify(sends.find((m) => m.destination.token.includes(first.phoneFp))),
      ).not.toContain(second.ciphertext);
      expect(JSON.stringify(sends)).not.toContain(unpaired.phoneFp);
      h.advance(60_000);
      await jobs.enqueue(message);
      await jobs.pump();
      expect(h.sends.flat()).toHaveLength(3);
    });
  });
  it("cancels ciphertext jobs on capability downgrade during provider I/O", async () => {
    await harness(async (h) => {
      h.sql.exec("UPDATE pairings SET push_enabled = 0");
      h.addPhone(fixture.box.phoneFp);
      const jobs = h.reconstruct(fixture.box.computerFp);
      const token = `native-private-${fixture.box.phoneFp}]`;
      await jobs.register(fixture.box.phoneFp, {
        type: "push-token",
        platform: "android",
        provider: "fcm",
        enabled: true,
        token,
        features: ["notify-context-v1"],
      });
      await jobs.enqueue({
        type: "notify-context",
        sessionId: fixture.box.sessionId,
        eventId: fixture.box.eventId,
        kind: "blocked",
        boxes: [fixture.box],
      });
      const barrier = h.hold("send");
      const pending = jobs.pump();
      await barrier.started;
      await jobs.register(fixture.box.phoneFp, {
        type: "push-token",
        platform: "android",
        provider: "fcm",
        enabled: true,
        token,
        features: [],
      });
      barrier.release();
      await pending;
      expect(h.rows()).toHaveLength(0);
      expect(await jobs.nextDeadline()).toBeNull();
    });
  });
  it("replaces separate events for one session across reconstruction without retaining accepted jobs", async () =>
    harness(async (h) => {
      await h.enqueue("tmux:session");
      await h.jobs.pump();
      const first = h.sends[0]![0]!;
      h.advance(60_000);
      await h.jobs.enqueue({ type: "notify", sessionId: "tmux:session", kind: "blocked" });
      await h.reconstruct().pump();
      const second = h.sends[1]![0]!;
      expect(second.group).toBe(first.group);
      expect(second.route.kind).toBe("blocked");
      expect(first.group).toMatch(/^sb1_[A-Za-z0-9_-]{43}$/);
      expect(h.rows()).toEqual([]);
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(0);
      expect(h.attempts()).toBe(2);
    }));

  it("does not replace another session or the same session on another computer", async () =>
    harness(async (h) => {
      await h.enqueue("tmux:one");
      await h.jobs.pump();
      await h.enqueue("tmux:two");
      await h.jobs.pump();
      h.advance(60_000);
      await h.enqueue("tmux:one");
      await h.reconstruct("another-computer").pump();
      const messages = h.sends.flat();
      expect(new Set(messages.map((message) => message.group)).size).toBe(3);
      for (const message of messages) {
        expect(message).toMatchObject({
          group: message.group,
        });
      }
    }));

  it("keeps grouping identifiers bounded for maximum-length Unicode sessions", async () =>
    harness(async (h) => {
      await h.enqueue("終".repeat(128));
      await h.jobs.pump();
      const message = h.sends[0]![0]!;
      expect(message.group).toMatch(/^sb1_[A-Za-z0-9_-]{43}$/);
      expect(new TextEncoder().encode(message.group).length).toBeLessThanOrEqual(64);
      expect(message).toMatchObject({
        group: message.group,

        route: { sessionId: "終".repeat(128) },
      });
    }));

  it("does not confuse computer/session tuple boundaries", async () =>
    harness(async (h) => {
      await h.enqueue("b:c");
      await h.reconstruct("a").pump();
      await h.enqueue("c");
      await h.reconstruct("a:b").pump();
      expect(h.sends[0]![0]!.group).not.toBe(h.sends[1]![0]!.group);
      for (const message of h.sends.flat()) {
        expect(message.group).toMatch(/^sb1_[A-Za-z0-9_-]{43}$/);
      }
    }));

  it.each(["send"] as const)(
    "settles held %s work before propagating an injected test failure",
    async (boundary) =>
      harness(async (h) => {
        await h.enqueue();
        const barrier = h.hold(boundary);
        const pending = h.jobs.pump();
        const failure = new Error("injected held-provider assertion failure");
        const check = async () => {
          try {
            await barrier.started;
            throw failure;
          } finally {
            barrier.release();
            await pending;
          }
        };
        await expect(check()).rejects.toBe(failure);
        // The provider outcome was applied before the error escaped; no claim remains in flight.
        expect(h.rows().map((row) => row.phase)).toEqual([]);
      }),
  );
  it("does not query or recreate dropped journal tables when an in-flight send returns after deleteAll", async () =>
    harness(async (h) => {
      await h.enqueue();
      const barrier = h.hold("send");
      const pending = h.jobs.pump();
      try {
        await barrier.started;
        await h.storage.deleteAll();
      } finally {
        barrier.release();
        await pending;
      }
      expect(
        h.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'push_%'").toArray(),
      ).toEqual([]);
      expect(await h.jobs.nextDeadline()).toBeNull();
    }));
  it("reserves every retry, uses fixed backoff and stable collapse/expiration, then deletes at three sends", async () =>
    harness(async (h) => {
      h.reply({ status: "retryable", code: "network" });
      await h.enqueue();
      const admitted = h.now();
      await h.jobs.pump();
      expect(h.rows()[0]).toMatchObject({ phase: "send", send_count: 1, due_at: admitted + 5000 });
      h.advance(4999);
      await h.jobs.pump();
      expect(h.sends).toHaveLength(1);
      h.advance(1);
      await h.jobs.pump();
      expect(h.rows()[0]).toMatchObject({ send_count: 2, due_at: admitted + 35000 });
      h.advance(30000);
      await h.jobs.pump();
      expect(h.rows()).toEqual([]);
      expect(h.attempts()).toBe(3);
      expect(h.sends).toHaveLength(3);
      expect(new Set(h.sends.flat().map((m) => m.group)).size).toBe(1);
      for (const message of h.sends.flat())
        expect(message).toMatchObject({
          group: message.group,
          expiresAtSeconds: Math.floor((admitted + 3600000) / 1000),
        });
      expect(await h.jobs.nextDeadline()).toBeNull();
    }));

  it("acceptance deletes content and retains only bounded opaque dedupe metadata without resending", async () =>
    harness(async (h) => {
      await h.enqueueRich();
      await h.jobs.pump();
      expect(h.rows()).toEqual([]);
      const accepted = h.sql.exec("SELECT * FROM push_accepted").toArray();
      expect(accepted).toHaveLength(1);
      expect(Object.keys(accepted[0]!).sort()).toEqual(["expires_at", "id", "phone_fp"]);
      for (let i = 0; i < 3; i++) {
        h.advance(900000);
        await h.reconstruct().pump();
      }
      expect(h.sends).toHaveLength(1);
      expect(h.attempts()).toBe(1);
      h.advance(900000);
      await h.jobs.pump();
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toEqual([]);
    }));

  it.each<SendOutcome>([
    { status: "accepted" },
    { status: "unregistered" },
    { status: "rejected", code: "invalid-device-token" },
    { status: "retryable", code: "network" },
  ])("handles native outcome $status with bounded retention", async (outcome) =>
    harness(async (h) => {
      h.reply(outcome);
      await h.enqueue();
      await h.jobs.pump();
      expect(h.rows()).toHaveLength(outcome.status === "retryable" ? 1 : 0);
      expect(h.sql.exec("SELECT push_token FROM pairings").one().push_token === null).toBe(
        outcome.status === "unregistered",
      );
      if (outcome.status === "retryable") {
        h.advance(5000);
        await h.jobs.pump();
        h.advance(30000);
        await h.jobs.pump();
        expect(h.rows()).toEqual([]);
        expect(h.sends).toHaveLength(3);
      }
    }),
  );

  it("bounds send freshness and metadata lifetime at the exact boundaries", async () =>
    harness(async (h) => {
      await h.enqueue();
      h.advance(120000);
      await h.jobs.pump();
      expect(h.rows()).toEqual([]);
      expect(h.sends).toEqual([]);
      await h.enqueue();
      await h.jobs.pump();
      h.advance(3600000);
      await h.jobs.pump();
      expect(h.rows()).toEqual([]);
      expect(h.sends).toHaveLength(1);
    }));

  it("counts accepted tombstones toward each admission cap and removes expired rows first", async () =>
    harness(async (h) => {
      for (let i = 0; i < 20; i++) await h.enqueueRich(`session-${i}`);
      await h.jobs.pump();
      await h.jobs.pump();
      expect(h.rows()).toHaveLength(0);
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(20);
      await h.enqueueRich("over-cap");
      expect(h.rows()).toHaveLength(0);
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(20);
      h.advance(3600000);
      await h.enqueueRich("fresh");
      expect(h.rows()).toHaveLength(1);
    }));

  it("caps the computer at 200, including accepted tombstones, and sends only one ten-message batch", async () =>
    harness(async (h) => {
      for (let i = 1; i <= 10; i++) h.addPhone(`phone-${i}`);
      for (let i = 0; i < 30; i++) await h.enqueueRich(`session-${i}`);
      expect(h.rows()).toHaveLength(200);
      await h.jobs.pump();
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]).toHaveLength(10);
      expect(await h.jobs.nextDeadline()).toBeLessThanOrEqual(h.now());
      await h.enqueueRich("over-cap");
      expect(h.rows()).toHaveLength(190);
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(10);
    }));

  it("ends a retry on budget denial and preserves legacy budget migration", async () =>
    harness(async (h) => {
      h.sql.exec(
        "INSERT INTO push_limits (phone_fp, window_start, count) VALUES ('phone', ?, 19)",
        h.now(),
      );
      h.reply({ status: "retryable", code: "network" });
      await h.enqueueRich();
      await h.jobs.pump();
      h.advance(5000);
      await h.jobs.pump();
      expect(h.sends).toHaveLength(1);
      expect(h.attempts()).toBe(1);
      expect(h.rows()).toEqual([]);
    }));

  it("only supersedes pending sends, retaining accepted event tombstones", async () =>
    harness(async (h) => {
      await h.enqueueRich();
      const old = h.rows()[0]!.id;
      h.advance(60_000);
      await h.enqueueRich();
      expect(h.rows()).toHaveLength(1);
      expect(h.rows()[0]!.id).not.toBe(old);
      await h.jobs.pump();
      h.advance(60_000);
      await h.enqueueRich();
      expect(
        h
          .rows()
          .map((r) => r.phase)
          .sort(),
      ).toEqual(["send"]);
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
    }));

  it("recovers persisted claims without refunding attempts or duplicating unexpired work", async () =>
    harness(async (h) => {
      h.reply({ status: "retryable", code: "network" });
      await h.enqueueRich();
      const barrier = h.hold("send");
      const rebuilt = h.reconstruct();
      const pending = h.jobs.pump();
      try {
        await barrier.started;
        await rebuilt.pump();
        expect(h.sends).toHaveLength(1);
        h.advance(10000);
        await rebuilt.pump();
        expect(h.rows()[0]).toMatchObject({ phase: "send", send_count: 1, due_at: h.now() + 5000 });
      } finally {
        barrier.release();
        await pending;
      }
      h.advance(5000);
      await rebuilt.pump();
      expect(h.attempts()).toBe(2);
      expect(h.rows()[0]!.send_count).toBe(2);
    }));

  it("coalesces overlapping pumps while persisted claims remain authoritative", async () =>
    harness(async (h) => {
      await h.enqueueRich();
      const barrier = h.hold("send");
      const pending = h.jobs.pump();
      try {
        await barrier.started;
        expect(h.jobs.pump()).toBe(pending);
        expect(h.rows()[0]!.claim_until).toBe(h.now() + 10000);
      } finally {
        barrier.release();
        await pending;
      }
      expect(h.sends).toHaveLength(1);
    }));

  it("reconstruction retains 120 accepted tombstones without scheduling provider work", async () =>
    harness(async (h) => {
      for (let i = 1; i < 6; i++) h.addPhone(`phone-${i}`);
      for (let i = 0; i < 20; i++) await h.enqueueRich(`session-${i}`);
      for (let i = 0; i < 12; i++) await h.jobs.pump();
      expect(h.rows()).toEqual([]);
      expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(120);
      expect(h.sends).toHaveLength(12);
      h.advance(900000);
      await h.reconstruct().pump();
      expect(h.sends).toHaveLength(12);
      expect(await h.jobs.nextDeadline()).toBe(h.now() + 2700000);
    }));

  it.each(["receipt", "checking"])(
    "retires legacy %s jobs on reconstruction without another dispatch",
    async (phase) =>
      harness(async (h) => {
        await h.enqueueRich();
        h.sql.exec(
          "UPDATE push_jobs SET phase = ?, ticket_id = 'legacy-ticket', send_count = 1",
          phase,
        );
        await h.reconstruct().pump();
        expect(h.rows()).toEqual([]);
        expect(h.sends).toEqual([]);
      }),
  );

  it("rejects stale results after a pending event is superseded", async () =>
    harness(async (h) => {
      h.reply({ status: "unregistered" });
      await h.enqueueRich();
      const barrier = h.hold("send");
      let replacement: string | undefined;
      h.advance(60_000);
      const pending = h.jobs.pump();
      try {
        await barrier.started;
        const claim = h.rows()[0]!;
        expect(claim.claim_until).toBeGreaterThan(h.now());
        await h.enqueueRich();
        replacement = h.rows()[0]!.id;
        expect(replacement).not.toBe(claim.id);
        expect(claim.claim_until).toBeGreaterThan(h.now());
      } finally {
        barrier.release();
        await pending;
      }
      expect(h.rows()[0]).toMatchObject({ id: replacement, phase: "send", send_count: 0 });
      expect(h.sql.exec("SELECT push_token FROM pairings").one().push_token).not.toBeNull();
      expect(h.attempts()).toBe(1);
    }));

  it("does not dispatch a claimed send that became stale during scheduling", async () =>
    harness(async (h) => {
      await h.enqueueRich();
      let first = true;
      h.schedule(async () => {
        if (first) {
          first = false;
          h.advance(120000);
        }
      });
      await h.jobs.pump();
      expect(h.sends).toEqual([]);
      expect(h.rows()).toEqual([]);
      expect(h.attempts()).toBe(1);
    }));

  it("rechecks cancellation after scheduling, before dispatch, without refunding the reservation", async () =>
    harness(async (h) => {
      await h.enqueueRich();
      h.schedule(async () => {
        await h.jobs.cancelPhone("phone");
      });
      await h.jobs.pump();
      expect(h.sends).toEqual([]);
      expect(h.rows()).toEqual([]);
      expect(h.attempts()).toBe(1);
    }));

  for (const boundary of ["send"] as const) {
    it.each(["same-token", "replacement", "opt-out", "unpair", "attention", "wipe"])(
      `ignores stale ${boundary} results after %s`,
      async (action) =>
        harness(async (h) => {
          await h.enqueueRich();
          h.reply({ status: "unregistered" });
          const barrier = h.hold(boundary);
          const pending = h.jobs.pump();
          try {
            await barrier.started;
            if (["same-token", "replacement", "opt-out"].includes(action))
              await h.jobs.register("phone", {
                type: "push-token",
                token: action === "replacement" ? "native-new" : "native-private-phone]",
                platform: "android",
                provider: "fcm",
                enabled: action !== "opt-out",
              });
            if (action === "unpair") {
              await h.jobs.forgetPhone("phone");
              h.sql.exec("DELETE FROM pairings");
            }
            if (action === "attention") {
              h.attentive(true);
              await h.jobs.cancelPhone("phone");
            }
            if (action === "wipe") {
              h.sql.exec(
                "DELETE FROM push_jobs; DELETE FROM push_registrations; DELETE FROM pairings;",
              );
            }
          } finally {
            barrier.release();
            await pending;
          }
          expect(h.rows()).toEqual([]);
          if (!["unpair", "wipe"].includes(action))
            expect(
              h.sql.exec<{ push_token: string | null }>("SELECT push_token FROM pairings").one()
                .push_token,
            ).not.toBeNull();
        }),
    );
  }

  it.each(["same-token", "replacement", "opt-out", "unpair", "attention", "wipe"])(
    "cancels accepted dedupe metadata after %s without another send",
    async (action) =>
      harness(async (h) => {
        await h.enqueueRich();
        await h.jobs.pump();
        expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
        if (["same-token", "replacement", "opt-out"].includes(action)) {
          await h.jobs.register("phone", {
            type: "push-token",
            token: action === "replacement" ? "native-new" : "native-private-phone]",
            provider: "fcm",
            platform: "android",
            enabled: action !== "opt-out",
          });
        } else if (action === "wipe") {
          await h.storage.deleteAll();
          expect(await h.jobs.nextDeadline()).toBeNull();
          expect(h.sends).toHaveLength(1);
          return;
        } else {
          if (action === "unpair") {
            await h.jobs.forgetPhone("phone");
            h.sql.exec("DELETE FROM pairings");
          } else {
            h.attentive(true);
            await h.jobs.cancelPhone("phone");
          }
        }
        await h.reconstruct().pump();
        expect(h.sql.exec("SELECT * FROM push_accepted").toArray()).toEqual([]);
        expect(h.rows()).toEqual([]);
        expect(h.sends).toHaveLength(1);
      }),
  );

  it("keeps only allowlisted metadata and lazily creates one generation per paired phone", async () =>
    harness(async (h) => {
      await h.jobs.register("absent", {
        type: "push-token",
        token: "private-token",
        platform: "android",
        provider: "fcm",
        enabled: true,
      });
      await h.enqueueRich();
      const pending = JSON.stringify(h.rows());
      for (const forbidden of [
        "private-phone-name",
        "private-computer-name",
        "ExponentPushToken",
        "body",
        "title",
        "private provider",
      ])
        expect(pending).not.toContain(forbidden);
      expect(h.sql.exec("SELECT * FROM push_registrations").toArray()).toHaveLength(1);
      await h.jobs.pump();
      const accepted = JSON.stringify(h.rows());
      expect(accepted).not.toContain('"session"');
      await h.jobs.forgetPhone("phone");
      expect(h.sql.exec("SELECT * FROM push_registrations").toArray()).toEqual([]);
    }));
});
