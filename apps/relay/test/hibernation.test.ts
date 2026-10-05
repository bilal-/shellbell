import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Envelope, encodeEnvelope, sha256 } from "@shellbell/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { authenticate, box, type Conn, connect, TestDevice } from "./helpers.js";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("external fetch forbidden");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = (from: string, to: string, seq: number): Envelope => ({
  v: 1,
  t: "e2e",
  from,
  to,
  seq,
  body: { n: new Uint8Array(24), c: new Uint8Array([11, 22, 33]) },
});

async function awaitClosed(conn: Conn): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      conn.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("socket cleanup timed out")), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeConnections(connections: Conn[]): Promise<void> {
  for (const conn of connections) {
    try {
      conn.ws.close();
    } catch {
      // The socket may already have closed during a failed handshake.
    }
  }
  const results = await Promise.allSettled(connections.map(awaitClosed));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "socket cleanup did not complete",
    );
  }
}

it("restores legacy authenticated attachments, routes and revokes after local Durable Object eviction", async () => {
  const mac = new TestDevice("synthetic-host");
  const phone = new TestDevice("synthetic-phone");
  let agent: Conn | undefined;
  let pairing: Conn | undefined;
  let phoneConnection: Conn | undefined;

  try {
    agent = await connect(mac.fp);
    expect((await authenticate(agent, mac, "agent")).type).toBe("auth-ok");
    expect((await agent.nextCtrl()).type).toBe("unpaired");
    expect((await agent.nextCtrl()).type).toBe("phones");

    const gate = new Uint8Array(16).fill(7);
    agent.sendCtrl(mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    pairing = await connect(mac.fp);
    expect((await authenticate(pairing, phone, "pairing", { gate })).type).toBe("auth-ok");
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    expect((await agent.nextCtrl()).type).toBe("pairing-request");
    agent.sendCtrl(mac.fp, {
      type: "pairing-add",
      phoneFp: phone.fp,
      ed25519Pub: phone.id.ed25519.pub,
      name: phone.name,
    });
    agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: box() });
    agent.sendCtrl(mac.fp, { type: "pairing-close" });
    expect((await pairing.nextCtrl()).type).toBe("pairing-response");
    pairing.ws.close();
    await awaitClosed(pairing);

    phoneConnection = await connect(mac.fp);
    expect((await authenticate(phoneConnection, phone, "phone")).type).toBe("auth-ok");
    expect((await agent.nextCtrl()).type).toBe("phone-connected");

    const relayEnv = env as typeof env & Env;
    const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(mac.fp));
    const before = await runInDurableObject(stub, async (instance: ComputerDO, state) => {
      Object.defineProperty(instance, "__preEvictionInstance", { value: true });
      const socket = state
        .getWebSockets()
        .find((ws) => ws.deserializeAttachment().state === "phone");
      expect(socket).toBeDefined();
      await instance.webSocketMessage(
        socket!,
        encodeEnvelope({
          v: 1,
          t: "ctrl",
          from: phone.fp,
          seq: 0,
          body: { type: "lease", ttlMs: 60_000 },
        }).buffer as ArrayBuffer,
      );
      for (const ws of state.getWebSockets()) {
        const { version: _version, ...legacy } = ws.deserializeAttachment();
        ws.serializeAttachment(legacy);
      }
      return state
        .getWebSockets()
        .map((ws) => ws.deserializeAttachment())
        .filter((attachment) => attachment.state === "agent" || attachment.state === "phone")
        .sort((a, b) => a.state.localeCompare(b.state));
    });
    expect(before).toHaveLength(2);
    expect(before.find((attachment) => attachment.state === "phone")?.leaseUntil).toBeGreaterThan(
      Date.now(),
    );

    await evictDurableObject(stub);

    const after = await runInDurableObject(stub, (instance: ComputerDO, state) => ({
      oldInstance: Object.hasOwn(instance, "__preEvictionInstance"),
      name: state.id.name,
      attachments: state
        .getWebSockets()
        .map((ws) => ws.deserializeAttachment())
        .filter((attachment) => attachment.state === "agent" || attachment.state === "phone")
        .sort((a, b) => a.state.localeCompare(b.state)),
    }));
    expect(after.oldInstance).toBe(false);
    expect(after.name).toBe(mac.fp);
    expect(after.attachments).toEqual(before);
    expect(
      after.attachments.find((attachment) => attachment.state === "phone")?.leaseUntil,
    ).toBeGreaterThan(Date.now());

    const outbound = frame(phone.fp, mac.fp, 1);
    phoneConnection.sendEnvelope(outbound);
    expect(await agent.next()).toEqual(outbound);
    const inbound = frame(mac.fp, phone.fp, 2);
    agent.sendEnvelope(inbound);
    expect(await phoneConnection.next()).toEqual(inbound);
    agent.sendCtrl(mac.fp, { type: "unpair", phoneFp: phone.fp });
    expect(await phoneConnection.closed).toMatchObject({ code: 4004 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT phone_fp FROM pairings").toArray()).toEqual([]);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    await closeConnections(
      [phoneConnection, pairing, agent].filter((conn): conn is Conn => conn !== undefined),
    );
  }
});
