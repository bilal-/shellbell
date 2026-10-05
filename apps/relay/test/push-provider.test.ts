import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { encodeEnvelope } from "@shellbell/protocol";
import type { NotificationProvider, PushIntent, SendOutcome } from "@shellbell/relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

const relayEnv = env as typeof env & Env;
let network: ReturnType<typeof vi.fn>;
let expectedNetworkCalls = 0;
beforeEach(() => {
  expectedNetworkCalls = 0;
  network = vi.fn(() => {
    throw new Error("unexpected external provider I/O");
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  expect(network).toHaveBeenCalledTimes(expectedNetworkCalls);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function runtime(
  provider: NotificationProvider | undefined,
  test: (context: {
    send: (role: "agent" | "phone", body: unknown) => Promise<void>;
    instance: ComputerDO;
    sql: SqlStorage;
    mac: TestDevice;
  }) => Promise<void>,
  privateConfig: Partial<Env> = {},
) {
  const mac = new TestDevice("private-computer-name");
  const phone = new TestDevice("private-phone-name");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const connection = await connect(mac.fp);
  await authenticate(connection, phone, "phone");
  await agent.nextCtrl();
  const frame = encodeEnvelope({
    v: 1,
    t: "e2e",
    from: mac.fp,
    to: phone.fp,
    seq: 1,
    body: { n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) },
  });
  try {
    await runInDurableObject(
      relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp)),
      async (_original, state) => {
        expect(state.id.name).toBe(mac.fp);
        const sockets = state.getWebSockets();
        const configuredEnv = { ...relayEnv, ...privateConfig };
        const instance = provider
          ? new ComputerDO(state, configuredEnv, { notificationProvider: provider })
          : new ComputerDO(state, configuredEnv);
        const send = async (role: "agent" | "phone", body: unknown) => {
          const socket = sockets.find((socket) => socket.deserializeAttachment().state === role)!;
          const encoded = encodeEnvelope({
            v: 1,
            t: "ctrl",
            from: role === "agent" ? mac.fp : phone.fp,
            seq: 0,
            body,
          });
          // CBOR may return a Buffer view into a larger pool; transmit only its bytes.
          await instance.webSocketMessage(socket, new Uint8Array(encoded).buffer);
        };
        await send("phone", {
          type: "push-token",
          provider: "fcm",
          token: "native-device-token",
          platform: "android",
          enabled: true,
        });
        await test({ send, instance, sql: state.storage.sql, mac });
        await send("phone", { type: "lease", ttlMs: 0 });
        expect(state.getWebSockets()).toHaveLength(2);
        await instance.webSocketMessage(
          sockets.find((socket) => socket.deserializeAttachment().state === "agent")!,
          new Uint8Array(frame).buffer,
        );
      },
    );
    expect(await connection.nextRaw()).toEqual(frame);
  } finally {
    agent.ws.close();
    connection.ws.close();
  }
}

it("uses private Worker FCM credentials for direct delivery", async () => {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const label = "PRIVATE KEY";
  const pem = `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer)))}\n-----END ${label}-----`;
  expectedNetworkCalls = 2;
  network.mockImplementation(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600 });
    expect(url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    return Response.json({ name: "projects/test-project/messages/one" });
  });
  await runtime(
    undefined,
    async ({ send, sql }) => {
      await send("agent", {
        type: "notify-context",
        sessionId: "session",
        eventId: "A".repeat(22),
        boxes: [],
        kind: "idle",
      });
      expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
      expect(sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
    },
    {
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
        type: "service_account",
        project_id: "test-project",
        client_email: "sender@example.test",
        private_key: pem,
      }),
    },
  );
});

it("keeps WebSocket forwarding available with malformed Worker private configuration", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  await runtime(
    undefined,
    async ({ send, sql }) => {
      await send("agent", { type: "notify", sessionId: "session", kind: "idle" });
      expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
      expect(sql.exec("SELECT push_token FROM pairings").one().push_token).toBe(
        "native-device-token",
      );
    },
    {
      FCM_SERVICE_ACCOUNT_JSON: "private-json-secret",
      APNS_PRIVATE_KEY: "private-key-secret",
      APNS_TOPIC: "wrong/topic",
    },
  );
  expect(diagnostic.mock.calls).toContainEqual([
    "relay push unavailable",
    "fcm",
    "invalid-credentials",
  ]);
  expect(diagnostic.mock.calls).toContainEqual([
    "relay push unavailable",
    "apns",
    "invalid-credentials",
  ]);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-");
});

it("uses Worker fetch for APNs with the private app topic and explicit environment", async () => {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const label = "PRIVATE KEY";
  const pem = `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer)))}\n-----END ${label}-----`;
  expectedNetworkCalls = 1;
  network.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.sandbox.push.apple.com/3/device/abcdef");
    expect(new Headers(init.headers).get("apns-topic")).toBe("dev.example.app");
    return new Response(null, { status: 200 });
  });
  await runtime(
    undefined,
    async ({ send, sql }) => {
      await send("phone", {
        type: "push-token",
        token: "abcdef",
        provider: "apns",
        environment: "development",
        platform: "ios",
        enabled: true,
      });
      await send("agent", {
        type: "notify-context",
        sessionId: "session",
        eventId: "A".repeat(22),
        boxes: [],
        kind: "idle",
      });
      expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
      expect(sql.exec("SELECT * FROM push_accepted").toArray()).toHaveLength(1);
    },
    {
      APNS_PRIVATE_KEY: pem,
      APNS_TEAM_ID: "TEAM123456",
      APNS_KEY_ID: "KEY1234567",
      APNS_TOPIC: "dev.example.app",
    },
  );
});

describe("Cloudflare native provider composition", () => {
  it("removes accepted jobs immediately and never resends on a later alarm", async () => {
    const sent: PushIntent[] = [];
    await runtime(
      {
        async send(intents) {
          sent.push(...intents);
          return intents.map(() => ({ status: "accepted" }));
        },
      },
      async ({ send, instance, sql, mac }) => {
        await send("agent", { type: "notify", sessionId: "session", kind: "idle" });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          destination: { provider: "fcm", token: "native-device-token" },
          route: { computerFp: mac.fp, sessionId: "session", kind: "idle" },
          genericTitle: "Shellbell",
        });
        expect(JSON.stringify(sent)).not.toContain("private-computer-name");
        expect(JSON.stringify(sent)).not.toContain("private-phone-name");
        expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
        await instance.alarm();
        expect(sent).toHaveLength(1);
      },
    );
  });

  it("persists provider backoff without immediately resending", async () => {
    await runtime(
      {
        async send(intents) {
          return intents.map(() => ({
            status: "retryable",
            code: "http-rate-limit",
            retryAfterMs: 60_000,
          }));
        },
      },
      async ({ send, instance, sql }) => {
        const before = Date.now();
        await send("agent", { type: "notify", sessionId: "session", kind: "blocked" });
        const row = sql
          .exec<{ phase: string; send_count: number; due_at: number }>(
            "SELECT phase, send_count, due_at FROM push_jobs",
          )
          .one();
        expect(row.phase).toBe("send");
        expect(row.send_count).toBe(1);
        expect(row.due_at).toBeGreaterThanOrEqual(before + 60_000);
        await instance.alarm();
        expect(sql.exec("SELECT send_count FROM push_jobs").one().send_count).toBe(1);
      },
    );
  });

  it.each([
    [{ status: "unregistered" }, null],
    [{ status: "rejected", code: "invalid-credentials" }, "native-device-token"],
  ] satisfies [SendOutcome, string | null][])(
    "applies terminal outcome %j with exact registration semantics",
    async (outcome, token) => {
      await runtime(
        {
          async send(intents) {
            return intents.map(() => outcome);
          },
        },
        async ({ send, sql }) => {
          await send("agent", { type: "notify", sessionId: "session", kind: "idle" });
          expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
          expect(sql.exec("SELECT push_token FROM pairings").one().push_token).toBe(token);
        },
      );
    },
  );

  it("fails closed without credentials while preserving terminal connectivity", async () => {
    await runtime(undefined, async ({ send, instance, sql }) => {
      await send("agent", { type: "notify", sessionId: "session", kind: "idle" });
      expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
      expect(sql.exec("SELECT push_token FROM pairings").one().push_token).toBe(
        "native-device-token",
      );
      await instance.alarm();
      await send("agent", { type: "notify", sessionId: "another", kind: "blocked" });
      expect(sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
    });
  });
});
