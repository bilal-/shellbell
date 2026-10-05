import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { encodeEnvelope } from "@shellbell/protocol";
import { formatDuration, type PushIntent, pushBody, type SendOutcome } from "@shellbell/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

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
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function pairedWithToken(
  test: (ctx: {
    sent: PushIntent[];
    mac: TestDevice;
    phone: TestDevice;
    send: (role: "agent" | "phone", body: unknown) => Promise<void>;
    sql: SqlStorage;
    state: DurableObjectState;
    reply: (value: SendOutcome) => void;
  }) => Promise<void>,
  enabled = true,
) {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl();
  const sent: PushIntent[] = [];
  let reply: SendOutcome = { status: "accepted" };
  try {
    await runInDurableObject(
      relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp)),
      async (_original, state) => {
        const instance = new ComputerDO(state, relayEnv, {
          notificationProvider: {
            async send(intents) {
              sent.push(...intents);
              return intents.map(() => reply);
            },
          },
        });
        const send = async (role: "agent" | "phone", body: unknown) => {
          const socket = state
            .getWebSockets()
            .find((s) => s.deserializeAttachment().state === role)!;
          await instance.webSocketMessage(
            socket,
            new Uint8Array(
              encodeEnvelope({
                v: 1,
                t: "ctrl",
                from: role === "agent" ? mac.fp : phone.fp,
                seq: 0,
                body,
              }),
            ).buffer,
          );
        };
        await send("phone", {
          type: "push-token",
          token: "a".repeat(64),
          provider: "apns",
          platform: "ios",
          environment: "development",
          enabled,
        });
        await test({
          mac,
          phone,
          sent,
          send,
          state,
          sql: state.storage.sql,
          reply: (value) => {
            reply = value;
          },
        });
      },
    );
  } finally {
    agent.ws.close();
    p.ws.close();
  }
}

describe("push text", () => {
  it("formats durations and generic bodies", () => {
    expect(formatDuration(43_000)).toBe("43s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(pushBody("prompt", 0, 43_000)).toBe("A command finished — exit 0 after 43s");
    expect(pushBody("idle")).toBe("A session went quiet — waiting for you?");
    expect(pushBody("blocked")).toBe("An agent is waiting for you");
    expect(pushBody("exit")).toBe("A session needs attention");
  });
});

describe("notify → push", () => {
  it("suppresses an attentive phone and sends after lease zero", async () =>
    pairedWithToken(async ({ send, sent, mac }) => {
      await send("phone", { type: "lease", ttlMs: 60000 });
      await send("agent", {
        type: "notify",
        sessionId: "s1",
        kind: "prompt",
        exitCode: 0,
        durationMs: 43000,
      });
      expect(sent).toEqual([]);
      await send("phone", { type: "lease", ttlMs: 0 });
      await send("agent", { type: "notify", sessionId: "s2", kind: "idle" });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        destination: { provider: "apns", token: "a".repeat(64), environment: "development" },
        genericTitle: "Shellbell",
        genericBody: "A session went quiet — waiting for you?",
        route: { computerFp: mac.fp, sessionId: "s2", kind: "idle" },
        group: expect.any(String),
        expiresAtSeconds: expect.any(Number),
      });
      expect(JSON.stringify(sent)).not.toContain("MBP");
      expect(JSON.stringify(sent)).not.toContain("iPhone");
    }));
  it("sends to a connected phone with an expired lease", async () =>
    pairedWithToken(async ({ send, sent, state }) => {
      const socket = state
        .getWebSockets()
        .find((s) => s.deserializeAttachment().state === "phone")!;
      socket.serializeAttachment({ ...socket.deserializeAttachment(), leaseUntil: Date.now() - 1 });
      await send("agent", { type: "notify", sessionId: "s", kind: "idle" });
      expect(sent).toHaveLength(1);
    }));
  it("never sends for a disabled pairing", async () =>
    pairedWithToken(async ({ send, sent }) => {
      await send("agent", { type: "notify", sessionId: "s", kind: "idle" });
      expect(sent).toEqual([]);
    }, false));
  it("rate-limits one ring per session per 60 seconds", async () =>
    pairedWithToken(async ({ send, sent }) => {
      for (const sessionId of ["s", "s", "t"])
        await send("agent", { type: "notify", sessionId, kind: "idle" });
      expect(sent).toHaveLength(2);
    }));
  it("clears the current token when the native provider reports unregistered", async () =>
    pairedWithToken(async ({ send, sent, reply, sql }) => {
      reply({ status: "unregistered" });
      await send("agent", { type: "notify", sessionId: "s1", kind: "idle" });
      expect(sql.exec("SELECT push_token FROM pairings").one().push_token).toBeNull();
      await send("agent", { type: "notify", sessionId: "s2", kind: "idle" });
      expect(sent).toHaveLength(1);
    }));
  it("caps pushes at twenty per phone per rolling hour", async () =>
    pairedWithToken(async ({ send, sent }) => {
      for (let i = 0; i <= 20; i++)
        await send("agent", { type: "notify", sessionId: `s${i}`, kind: "idle" });
      expect(sent).toHaveLength(20);
    }));
  it("reserves budget and leaves a bounded retry when the provider fails", async () =>
    pairedWithToken(async ({ send, sent, reply, sql }) => {
      reply({ status: "retryable", code: "network" });
      await send("agent", { type: "notify", sessionId: "failure", kind: "idle" });
      expect(sql.exec("SELECT COUNT(*) AS n FROM push_attempts").one().n).toBe(1);
      expect(sql.exec("SELECT phase, send_count FROM push_jobs").one()).toEqual({
        phase: "send",
        send_count: 1,
      });
      expect(sent).toHaveLength(1);
    }));
  it("sends the generic blocked body", async () =>
    pairedWithToken(async ({ send, sent }) => {
      await send("agent", { type: "notify", sessionId: "herdr:term_a", kind: "blocked" });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        genericBody: "An agent is waiting for you",
        route: { sessionId: "herdr:term_a", kind: "blocked" },
      });
    }));
});
