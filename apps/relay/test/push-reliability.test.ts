import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  encodeEnvelope,
  identityFromSeeds,
  NotificationBoxSchema,
  openNotification,
} from "@shellbell/protocol";
import type { NotificationProvider, PushIntent, SendOutcome } from "@shellbell/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import transportFixture from "../../../packages/protocol/test/notification-transport-vectors.json";
import fixture from "../../../packages/protocol/test/notification-vectors.json";
import { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

const relayEnv = env as typeof env & Env;
const registration = {
  type: "push-token",
  token: "native-device-token",
  provider: "fcm",
  platform: "android",
  enabled: true,
  features: ["notify-context-v1"],
};
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => {
    throw new Error("unexpected provider request");
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
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
async function setup(
  mac = new TestDevice("private-computer-name"),
  phone = new TestDevice("private-phone-name"),
) {
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl();
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp));
  const sent: PushIntent[] = [];
  let outcome: SendOutcome = { status: "accepted" };
  let handler: NotificationProvider["send"] = async (intents) => intents.map(() => outcome);
  const provider: NotificationProvider = {
    async send(intents) {
      sent.push(...intents);
      return handler(intents);
    },
  };
  const run = <T>(callback: (instance: ComputerDO, state: DurableObjectState) => Promise<T> | T) =>
    runInDurableObject(stub, (_original, state) =>
      callback(new ComputerDO(state, relayEnv, { notificationProvider: provider }), state),
    );
  const dispatch = (
    instance: ComputerDO,
    state: DurableObjectState,
    role: string,
    from: string,
    body: unknown,
  ) => {
    const socket = state.getWebSockets().find((s) => s.deserializeAttachment().state === role);
    if (!socket) throw new Error("missing socket");
    return instance.webSocketMessage(
      socket,
      new Uint8Array(encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body })).buffer,
    );
  };
  const send = (role: string, from: string, body: unknown) =>
    run((instance, state) => dispatch(instance, state, role, from, body));
  const box = { ...fixture.box, computerFp: mac.fp, phoneFp: phone.fp };
  const context = {
    type: "notify-context",
    sessionId: box.sessionId,
    eventId: box.eventId,
    kind: "blocked",
    boxes: [box],
  };
  await send("phone", phone.fp, registration);
  return {
    mac,
    phone,
    stub,
    sent,
    run,
    dispatch,
    send,
    context,
    box,
    reply: (value: SendOutcome) => {
      outcome = value;
    },
    handle: (value: NotificationProvider["send"]) => {
      handler = value;
    },
    close: () => {
      agent.ws.close();
      p.ws.close();
    },
  };
}

describe("durable push integration", () => {
  it("routes exact native crypto/presenter fixtures without exposing labels or mixing sessions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const device = (seed: number) =>
      new TestDevice(
        "Public fixture",
        identityFromSeeds(
          new Uint8Array(32).fill(seed),
          new Uint8Array(32).fill(seed + 1),
          "2026-09-27T00:00:00.000Z",
        ),
      );
    const ctx = await setup(
      device(transportFixture.computerSeed),
      device(transportFixture.phoneSeed),
    );
    try {
      for (const { box, payload } of transportFixture.cases) {
        await ctx.send("agent", ctx.mac.fp, {
          type: "notify-context",
          sessionId: box.sessionId,
          eventId: box.eventId,
          kind: "blocked",
          boxes: [box],
        });
        const delivered = ctx.sent.at(-1)!;
        expect(delivered.box).toEqual(box);
        const key = Uint8Array.from(transportFixture.key.match(/../g)!, (hex) =>
          Number.parseInt(hex, 16),
        );
        expect(openNotification(key, NotificationBoxSchema.parse(delivered.box))).toEqual(payload);
        expect(JSON.stringify(delivered)).not.toContain(payload.context.repository);
        expect(JSON.stringify(delivered)).not.toContain(payload.context.branch);
      }
      expect(ctx.sent).toHaveLength(2);
      expect(ctx.sent[0]!.route.sessionId).not.toBe(ctx.sent[1]!.route.sessionId);
      await ctx.run((_instance, state) => {
        expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        const rows = state.storage.sql.exec("SELECT * FROM push_accepted").toArray();
        expect(rows).toHaveLength(2);
        expect(JSON.stringify(rows)).not.toContain("private-repository-qa");
        expect(JSON.stringify(rows)).not.toContain("private-branch-qa");
        expect(JSON.stringify(rows)).not.toContain(transportFixture.cases[0]!.box.ciphertext);
      });
    } finally {
      ctx.close();
    }
  });

  it("accepts encrypted context only from the authenticated agent and scrubs ciphertext after acceptance", async () => {
    const ctx = await setup();
    try {
      await ctx.send("phone", ctx.phone.fp, ctx.context);
      expect(ctx.sent).toEqual([]);
      const admittedAfter = Date.now();
      await ctx.send("agent", ctx.mac.fp, ctx.context);
      const admittedBefore = Date.now();
      expect(ctx.sent).toHaveLength(1);
      expect(ctx.sent[0]).toMatchObject({ route: { computerFp: ctx.mac.fp }, box: ctx.box });
      expect(JSON.stringify(ctx.sent)).not.toContain("private-computer-name");
      expect(JSON.stringify(ctx.sent)).not.toContain("private-phone-name");
      await ctx.run((_instance, state) => {
        expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        const row = state.storage.sql.exec("SELECT * FROM push_accepted").one();
        expect(Object.keys(row).sort()).toEqual(["expires_at", "id", "phone_fp"]);
        expect(row.expires_at).toBeGreaterThanOrEqual(admittedAfter + 3_600_000);
        expect(row.expires_at).toBeLessThanOrEqual(admittedBefore + 3_600_000);
        expect(JSON.stringify(row)).not.toContain(ctx.box.ciphertext);
      });
    } finally {
      ctx.close();
    }
  });

  it.each(["auth", "pairing"])(
    "preserves an imminent then overdue %s alarm across repeated scheduling",
    async (kind) => {
      const ctx = await setup();
      const base = Date.now() + 60000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(base - 9500);
      const unauth = kind === "auth" ? await connect(ctx.mac.fp) : undefined;
      clock.mockReturnValue(base);
      try {
        await ctx.run(async (instance, state) => {
          const deadline = base + 500;
          if (kind === "pairing")
            state.storage.sql.exec(
              "INSERT OR REPLACE INTO pairing_window (id, gate_hash, expires_at, admitted) VALUES (1, ?, ?, 0)",
              new ArrayBuffer(32),
              deadline,
            );
          await state.storage.setAlarm(deadline);
          for (const offset of [0, 800, 1500]) {
            clock.mockReturnValue(base + offset);
            await ctx.dispatch(instance, state, "phone", ctx.phone.fp, {
              type: "lease",
              ttlMs: 60000,
            });
            await ctx.dispatch(instance, state, "agent", ctx.mac.fp, {
              type: "notify",
              sessionId: `alarm-${offset}`,
              kind: "idle",
            });
            expect(await state.storage.getAlarm()).toBe(deadline);
          }
        });
      } finally {
        clock.mockRestore();
        unauth?.ws.close();
        ctx.close();
      }
    },
  );

  it("removes an empty queue alarm and does not revive cancelled work after lease zero", async () => {
    const ctx = await setup();
    ctx.reply({ status: "retryable", code: "network" });
    try {
      await ctx.send("agent", ctx.mac.fp, { type: "pairing-close" });
      await ctx.send("agent", ctx.mac.fp, ctx.context);
      await ctx.send("phone", ctx.phone.fp, { type: "lease", ttlMs: 60000 });
      await ctx.send("phone", ctx.phone.fp, { type: "lease", ttlMs: 0 });
      await ctx.run(async (instance, state) => {
        expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
        await instance.alarm();
      });
      expect(ctx.sent).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("repairs a missing alarm after reconstruction but preserves an earlier existing alarm", async () => {
    const ctx = await setup();
    ctx.reply({ status: "retryable", code: "http-rate-limit", retryAfterMs: 90000 });
    try {
      await ctx.send("agent", ctx.mac.fp, { type: "pairing-close" });
      await ctx.send("agent", ctx.mac.fp, ctx.context);
      const early = Date.now() + 60000;
      await ctx.run((_instance, state) => state.storage.setAlarm(early));
      await evictDurableObject(ctx.stub);
      expect(
        await runInDurableObject(ctx.stub, (_instance, state) => state.storage.getAlarm()),
      ).toBe(early);
      await runInDurableObject(ctx.stub, (_instance, state) => state.storage.deleteAlarm());
      await evictDurableObject(ctx.stub);
      const result = await runInDurableObject(ctx.stub, async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        due: state.storage.sql.exec("SELECT due_at FROM push_jobs").one().due_at,
      }));
      expect(result.alarm).toBe(result.due);
      expect(ctx.sent).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("keeps a pairing-window security deadline ahead of accepted tombstones on repeated early alarms", async () => {
    const ctx = await setup();
    try {
      const deadline = Date.now() + 60000;
      await ctx.run((_instance, state) => {
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO pairing_window (id, gate_hash, expires_at, admitted) VALUES (1, ?, ?, 0)",
          new ArrayBuffer(32),
          deadline,
        );
      });
      await ctx.send("agent", ctx.mac.fp, ctx.context);
      await ctx.run(async (instance, state) => {
        await instance.alarm();
        await instance.alarm();
        await instance.alarm();
        expect(await state.storage.getAlarm()).toBe(deadline);
        expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        expect(state.storage.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
      });
      expect(ctx.sent).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("coalesces concurrent notify and alarm without duplicate claims", async () => {
    const ctx = await setup();
    const started = deferred<void>();
    const release = deferred<void>();
    ctx.handle(async (intents) => {
      started.resolve();
      await release.promise;
      return intents.map(() => ({ status: "accepted" }));
    });
    try {
      await ctx.run(async (instance, state) => {
        const pending = ctx.dispatch(instance, state, "agent", ctx.mac.fp, ctx.context);
        let alarm: Promise<void> | undefined;
        try {
          await started.promise;
          alarm = instance.alarm();
          expect(state.storage.sql.exec("SELECT send_count FROM push_jobs").one().send_count).toBe(
            1,
          );
        } finally {
          release.resolve();
          // Both handlers must settle before leaving the Durable Object I/O scope.
          try {
            await pending;
          } finally {
            await alarm;
          }
        }
        expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        expect(state.storage.sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
      });
      expect(ctx.sent).toHaveLength(1);
    } finally {
      release.resolve();
      ctx.close();
    }
  });

  describe.each(["pending-send", "accepted-tombstone"])("%s cancellation", (boundary) => {
    it.each(["attention", "opt-out", "phone-unpair", "agent-unpair", "sync", "retention"])(
      "cancels work through the actual %s hook",
      async (action) => {
        const ctx = await setup();
        const started = deferred<void>();
        const release = deferred<void>();
        if (boundary === "pending-send")
          ctx.handle(async (intents) => {
            started.resolve();
            await release.promise;
            return intents.map(() => ({ status: "unregistered" }));
          });
        try {
          await ctx.run(async (instance, state) => {
            const sql = state.storage.sql;
            const send = (role: string, from: string, body: unknown) =>
              ctx.dispatch(instance, state, role, from, body);
            const pending = send("agent", ctx.mac.fp, ctx.context);
            try {
              if (boundary === "pending-send") await started.promise;
              else {
                await pending;
                expect(sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
              }
              if (action === "attention")
                await send("phone", ctx.phone.fp, { type: "lease", ttlMs: 60000 });
              if (action === "opt-out")
                await send("phone", ctx.phone.fp, { ...registration, enabled: false });
              if (action === "phone-unpair")
                await send("phone", ctx.phone.fp, { type: "unpair", phoneFp: ctx.phone.fp });
              if (action === "agent-unpair")
                await send("agent", ctx.mac.fp, { type: "unpair", phoneFp: ctx.phone.fp });
              if (action === "sync")
                await send("agent", ctx.mac.fp, { type: "pairings-sync", phones: [] });
              if (action === "retention") {
                for (const socket of state.getWebSockets())
                  await instance.webSocketClose(socket, 1000);
                sql.exec("UPDATE computer SET last_seen = 0");
                await instance.alarm();
              }
              expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
              expect(sql.exec("SELECT * FROM push_accepted").toArray()).toEqual([]);
            } finally {
              release.resolve();
              await pending;
            }
            expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
            expect(sql.exec("SELECT * FROM push_accepted").toArray()).toEqual([]);
            if (["attention", "opt-out"].includes(action))
              expect(sql.exec("SELECT push_token FROM pairings").one().push_token).toBe(
                registration.token,
              );
            else expect(sql.exec("SELECT * FROM push_registrations").toArray()).toEqual([]);
            await instance.alarm();
          });
          expect(ctx.sent).toHaveLength(1);
        } finally {
          release.resolve();
          ctx.close();
        }
      },
    );
  });

  it.each(["temporary", "accepted"])(
    "persists %s work and its alarm across restart without immediate resend",
    async (kind) => {
      const ctx = await setup();
      if (kind === "temporary")
        ctx.reply({ status: "retryable", code: "http-server", retryAfterMs: 60000 });
      try {
        await ctx.send("agent", ctx.mac.fp, { type: "pairing-close" });
        await ctx.send("agent", ctx.mac.fp, ctx.context);
        const snapshot = () =>
          runInDurableObject(ctx.stub, async (_instance, state) => ({
            token: state.storage.sql
              .exec("SELECT push_token FROM pairings WHERE phone_fp = ?", ctx.phone.fp)
              .one().push_token,
            jobs: state.storage.sql.exec("SELECT * FROM push_jobs").toArray(),
            accepted: state.storage.sql.exec("SELECT * FROM push_accepted").toArray(),
            alarm: await state.storage.getAlarm(),
          }));
        const before = await snapshot();
        expect(before.token).toBe(registration.token);
        expect(before.jobs).toHaveLength(kind === "temporary" ? 1 : 0);
        expect(before.accepted).toHaveLength(kind === "accepted" ? 1 : 0);
        expect(before.alarm).not.toBeNull();
        await evictDurableObject(ctx.stub);
        expect(await snapshot()).toEqual(before);
        await ctx.run((instance) => instance.alarm());
        await ctx.send("agent", ctx.mac.fp, ctx.context);
        expect(ctx.sent).toHaveLength(1);
        expect(await snapshot()).toEqual(before);
      } finally {
        ctx.close();
      }
    },
  );

  it.each([registration.token, "rotated-native-token"])(
    "ignores stale dead-token results after re-registration to %s",
    async (token) => {
      const ctx = await setup();
      const started = deferred<void>();
      const response = deferred<readonly SendOutcome[]>();
      ctx.handle(() => {
        started.resolve();
        return response.promise;
      });
      try {
        await ctx.run(async (instance, state) => {
          const pending = ctx.dispatch(instance, state, "agent", ctx.mac.fp, ctx.context);
          try {
            await started.promise;
            await ctx.dispatch(instance, state, "phone", ctx.phone.fp, { ...registration, token });
          } finally {
            response.resolve([{ status: "unregistered" }]);
            await pending;
          }
          expect(
            state.storage.sql
              .exec("SELECT push_token FROM pairings WHERE phone_fp = ?", ctx.phone.fp)
              .one().push_token,
          ).toBe(token);
          expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        });
      } finally {
        response.resolve([{ status: "unregistered" }]);
        ctx.close();
      }
    },
  );
});
