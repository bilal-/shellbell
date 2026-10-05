import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { authMessage, decodeEnvelope, encodeEnvelope, parseCtrl, sign } from "@shellbell/protocol";
import type { PushIntent } from "@shellbell/relay-core";
import { expect, it, vi } from "vitest";
import { createCloudflareScheduler } from "../src/adapters/scheduler.js";
import { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { agentOnline, authenticate, type Conn, connect, pairPhone, TestDevice } from "./helpers.js";

it("advertises the configured nondefault frame interval during runtime authentication", async () => {
  const mac = new TestDevice("configured-frame-host");
  const relayEnv = env as typeof env & Env;
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp));
  await runInDurableObject(stub, async (_instance, state) => {
    const configured = new ComputerDO(state, { ...relayEnv, MIN_FRAME_MS: "375" });
    const response = await configured.fetch(
      new Request("https://relay.test/", { headers: { Upgrade: "websocket" } }),
    );
    expect(response.status).toBe(101);
    const client = response.webSocket!;
    client.binaryType = "arraybuffer";
    const next = () =>
      new Promise<ReturnType<typeof parseCtrl>>((resolve) => {
        client.addEventListener(
          "message",
          (event) =>
            resolve(parseCtrl(decodeEnvelope(new Uint8Array(event.data as ArrayBuffer)).body)),
          { once: true },
        );
      });
    const challenge = next();
    client.accept();
    const ch = await challenge;
    if (ch.type !== "challenge") throw new Error("expected challenge");
    const server = state
      .getWebSockets()
      .find((ws) => ws.deserializeAttachment().connId === ch.connId)!;
    try {
      const result = next();
      await configured.webSocketMessage(
        server,
        encodeEnvelope({
          v: 1,
          t: "ctrl",
          from: mac.fp,
          seq: 0,
          body: {
            type: "auth",
            role: "agent",
            fp: mac.fp,
            ed25519Pub: mac.id.ed25519.pub,
            sig: sign(mac.id.ed25519.priv, authMessage(ch.connId, "agent", mac.fp, ch.nonce)),
            name: mac.name,
            appVersion: "test",
          },
        }).buffer as ArrayBuffer,
      );
      expect(await result).toMatchObject({ type: "auth-ok", minFrameMs: 375 });
    } finally {
      await configured.webSocketClose(server, 1000);
      client.close();
    }
  });
});

it.each([null, { version: 2 }])("closes an invalid restored attachment: %j", async (invalid) => {
  const mac = new TestDevice("attachment-host");
  const connection = await connect(mac.fp);
  await connection.nextCtrl();
  const relayEnv = env as typeof env & Env;
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp));
  await runInDurableObject(stub, (_instance, state) => {
    const ws = state.getWebSockets()[0]!;
    ws.serializeAttachment(invalid === null ? null : { ...ws.deserializeAttachment(), ...invalid });
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, () => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        connection.closed,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve("still open"), 2000);
        }),
      ]),
    ).resolves.toMatchObject({ code: 4400 });
  } finally {
    clearTimeout(timeout);
    connection.ws.close();
  }
});

it("recovers expired legacy push claims after eviction without refunding attempt reservations", async () => {
  const mac = new TestDevice("recovery-host");
  const phone = new TestDevice("recovery-phone");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const relayEnv = env as typeof env & Env;
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp));
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const delivered: PushIntent[] = [];
  const network = vi.fn(() => {
    throw new Error("unexpected external provider I/O");
  });
  vi.stubGlobal("fetch", network);
  try {
    await runInDurableObject(stub, (instance, state) => {
      Object.defineProperty(instance, "__beforeRecovery", { value: true });
      const sql = state.storage.sql;
      sql.exec(
        "UPDATE pairings SET push_token = 'native-recovery-token', push_provider = 'fcm', push_platform = 'android', push_environment = NULL, push_enabled = 1 WHERE phone_fp = ?",
        phone.fp,
      );
      sql.exec(
        "INSERT INTO push_registrations (phone_fp, generation) VALUES (?, 'legacy-generation')",
        phone.fp,
      );
      sql.exec(
        "INSERT INTO push_attempts (phone_fp, attempted_at) VALUES (?, ?)",
        phone.fp,
        now - 10000,
      );
      sql.exec(
        `INSERT INTO push_jobs (id, phone_fp, generation, phase, admitted_at, expires_at, due_at, send_count, claim_id, claim_until, session_id, kind)
        VALUES ('legacy-job', ?, 'legacy-generation', 'sending', ?, ?, ?, 1, 'expired-claim', ?, 'synthetic-session', 'idle')`,
        phone.fp,
        now - 10000,
        now + 3590000,
        now - 10000,
        now - 1,
      );
      return state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (restored, state) => {
      expect(Object.hasOwn(restored, "__beforeRecovery")).toBe(false);
      const instance = new ComputerDO(state, relayEnv, {
        notificationProvider: {
          async send(intents) {
            delivered.push(...intents);
            return intents.map(() => ({ status: "accepted" }));
          },
        },
      });
      expect(await state.storage.getAlarm()).toBe(now + 1000);
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT phase, send_count FROM push_jobs").one()).toMatchObject(
        { phase: "send", send_count: 1 },
      );
      expect(delivered).toHaveLength(0);
      now += 5000;
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT * FROM push_jobs").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM push_attempts").one().n).toBe(2);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        destination: { provider: "fcm", token: "native-recovery-token" },
        route: { sessionId: "synthetic-session", kind: "idle" },
      });
      await instance.alarm();
      expect(delivered).toHaveLength(1);
    });
  } finally {
    clock.mockRestore();
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    agent.ws.close();
    await agent.closed;
  }
});

it("serializes alarm writes and recovers after a rejected storage read", async () => {
  let alarm: number | null = null;
  let fail = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const scheduler = createCloudflareScheduler(
    {
      getAlarm: async () => {
        reads++;
        if (fail) {
          fail = false;
          await held;
          throw new Error("temporary storage failure");
        }
        return alarm;
      },
      setAlarm: async (value) => {
        alarm = Number(value);
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    () => 0,
  );
  const first = scheduler.replace(5000);
  const rejection = expect(first).rejects.toThrow("temporary storage failure");
  const second = scheduler.replace(6000);
  await Promise.resolve();
  expect(reads).toBe(1);
  release();
  await rejection;
  await second;
  expect(alarm).toBe(6000);
});

it("late replaced-socket events cannot revoke or disconnect the replacement", async () => {
  const mac = new TestDevice("replacement-host");
  const phone = new TestDevice("replacement-phone");
  const { agent } = await agentOnline(mac);
  const connections: Conn[] = [agent];
  const relayEnv = env as typeof env & Env;
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp));
  let oldSocket!: WebSocket;
  let oldId: string | undefined;
  try {
    await pairPhone(mac, agent, phone);
    await runInDurableObject(stub, (_instance, state) => {
      oldSocket = state.getWebSockets().find((ws) => ws.deserializeAttachment().state === "agent")!;
      oldId = oldSocket.deserializeAttachment().connId;
    });
    const { agent: replacement } = await agentOnline(mac);
    connections.push(replacement);
    await agent.closed;
    await runInDurableObject(stub, async (instance: ComputerDO, state) => {
      const current = state
        .getWebSockets()
        .find((ws) => ws.deserializeAttachment().state === "agent")!;
      expect(current.deserializeAttachment().connId).not.toBe(oldId);
      await instance.webSocketClose(oldSocket, 1000);
      await instance.webSocketError(oldSocket, new Error("late old event"));
      await instance.webSocketMessage(
        oldSocket,
        encodeEnvelope({
          v: 1,
          t: "ctrl",
          from: mac.fp,
          seq: 0,
          body: { type: "unpair", phoneFp: phone.fp },
        }).buffer as ArrayBuffer,
      );
      expect(state.storage.sql.exec("SELECT phone_fp FROM pairings").one().phone_fp).toBe(phone.fp);
    });
    const p = await connect(mac.fp);
    connections.push(p);
    expect(await authenticate(p, phone, "phone")).toMatchObject({
      type: "auth-ok",
      agentOnline: true,
    });
    expect(await replacement.nextCtrl()).toMatchObject({
      type: "phone-connected",
      phoneFp: phone.fp,
    });
  } finally {
    for (const connection of connections) connection.ws.close();
    await Promise.all(connections.map((connection) => connection.closed));
  }
});

it("floors new alarms, retains imminent needed alarms, and removes obsolete alarms", async () => {
  let alarm: number | null = null;
  const scheduler = createCloudflareScheduler(
    {
      getAlarm: async () => alarm,
      setAlarm: async (value) => {
        alarm = Number(value);
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    () => 1000,
  );
  await scheduler.replace(500);
  expect(alarm).toBe(2000);
  alarm = 1500;
  await scheduler.replace(1200);
  expect(alarm).toBe(1500);
  await scheduler.replace(5000);
  expect(alarm).toBe(5000);
  await scheduler.replace(null);
  expect(alarm).toBeNull();
});
