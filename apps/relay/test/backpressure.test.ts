import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { encodeEnvelope } from "@shellbell/protocol";
import { QueueBudget, type RelayCore } from "@shellbell/relay-core";
import { expect, it, vi } from "vitest";
import { bounded } from "../../../packages/relay-core/test-support/scenarios.js";
import { createCloudflareTransport } from "../src/adapters/transport.js";
import { ComputerDO } from "../src/computer-do.js";
import type { Env } from "../src/env.js";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

it("does not restore a closing socket as an attentive authenticated phone", async () => {
  const relayEnv = env as typeof env & Env;
  await runInDurableObject(
    relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId()),
    (_instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[1]);
      pair[0].accept();
      pair[1].serializeAttachment({
        version: 1,
        state: "phone",
        connId: "closing-phone",
        nonce: "A".repeat(43),
        since: 0,
        fp: new TestDevice("phone").fp,
        name: "phone",
        leaseUntil: Date.now() + 30_000,
      });
      pair[1].close(1000, "already retired");
      expect(pair[1].readyState).toBe(WebSocket.CLOSING);
      expect(state.getWebSockets()).toContain(pair[1]);
      const transport = createCloudflareTransport(state);
      expect(transport.sessions()).toEqual([]);
      expect(transport.connectionId(pair[1])).toBeUndefined();
      pair[0].close();
    },
  );
});

it("retires a failed queued write and refunds every accepted frame without a close event", async () => {
  const relayEnv = env as typeof env & Env;
  await runInDurableObject(
    relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId()),
    (_instance, state) => {
      const budget = new QueueBudget(10, 10);
      const failed = vi.fn((id: string) => {
        expect(transport.sessions().some((session) => session.connId === id)).toBe(true);
      });
      const transport = createCloudflareTransport(state, budget, failed);
      const pair = new WebSocketPair();
      const id = transport.accept(pair[1]);
      pair[0].accept();
      transport.save({
        version: 1,
        connId: id,
        state: "unauth",
        nonce: "A".repeat(43),
        since: 0,
        fp: null,
        name: null,
        leaseUntil: 0,
      });
      const snapshot = transport.session(id)!;
      Object.assign(snapshot, { state: "phone", leaseUntil: 100 });
      expect(transport.session(id)).toMatchObject({ state: "unauth", leaseUntil: 0 });
      const send = vi.spyOn(pair[1], "send").mockImplementation(() => {
        throw new Error("injected write failure");
      });
      expect(transport.send(id, new Uint8Array(5))).toBe("sent");
      expect(transport.send(id, new Uint8Array(5))).toBe("sent");
      return Promise.resolve().then(() => {
        expect(transport.sessions()).toEqual([]);
        expect(transport.session(id)).toBeUndefined();
        expect(transport.connectionId(pair[1])).toBeUndefined();
        expect(send).toHaveBeenCalledTimes(1);
        expect(failed).toHaveBeenCalledExactlyOnceWith(id);
        expect(budget.reserve("replacement", 10)).toBe(true);
        send.mockRestore();
        pair[0].close();
      });
    },
  );
});

it("releases connection-ID state after churn and ignores callbacks from closed sockets", async () => {
  const relayEnv = env as typeof env & Env;
  await runInDurableObject(
    relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId()),
    (_instance, state) => {
      const retained: { set: Set<unknown>; id: unknown }[] = [];
      const original = Set.prototype.add;
      const spy = vi.spyOn(Set.prototype, "add").mockImplementation(function (
        this: Set<unknown>,
        id: unknown,
      ) {
        retained.push({ set: this, id });
        return original.call(this, id);
      });
      const transport = createCloudflareTransport(state);
      const closedIds: string[] = [];
      try {
        for (let i = 0; i < 1000; i++) {
          const pair = new WebSocketPair();
          const id = transport.accept(pair[1]);
          closedIds.push(id);
          pair[0].accept();
          transport.close(id, 1000, "done");
          pair[0].close();
          expect(transport.send(id, new Uint8Array(1))).toBe("closed");
        }
      } finally {
        spy.mockRestore();
      }
      expect(new Set(closedIds).size).toBe(1000);
      expect(transport.sessions()).toEqual([]);
      expect(
        retained.filter(({ set, id }) => closedIds.includes(String(id)) && set.has(id)),
      ).toEqual([]);
    },
  );
});

it("retires ownership before a failed flush during local closure can reenter the core", async () => {
  const relayEnv = env as typeof env & Env;
  await runInDurableObject(
    relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId()),
    (_instance, state) => {
      const failed = vi.fn((id: string) => transport.session(id));
      const transport = createCloudflareTransport(state, new QueueBudget(), failed);
      const pair = new WebSocketPair();
      const id = transport.accept(pair[1]);
      pair[0].accept();
      transport.save({
        version: 1,
        connId: id,
        state: "unauth",
        nonce: "A".repeat(43),
        since: 0,
        fp: null,
        name: null,
        leaseUntil: 0,
      });
      const send = vi.spyOn(pair[1], "send").mockImplementation(() => {
        throw new Error("failed local flush");
      });
      try {
        expect(transport.send(id, new Uint8Array(1))).toBe("sent");
        transport.close(id, 1000, "local closure");
        expect(failed).toHaveBeenCalledExactlyOnceWith(id);
        expect(failed.mock.results[0]!.value).toBeUndefined();
      } finally {
        send.mockRestore();
        pair[0].close();
      }
    },
  );
});

it("notifies the core when a phone closes between queue acceptance and flushing", async () => {
  const host = new TestDevice("write-failure"),
    phone = new TestDevice("phone");
  const { agent } = await agentOnline(host);
  await pairPhone(host, agent, phone);
  const connected = await connect(host.fp);
  await authenticate(connected, phone, "phone");
  await agent.nextCtrl();
  const relayEnv = env as typeof env & Env;
  await runInDurableObject(
    relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(host.fp)),
    async (_original, state) => {
      const instance = new ComputerDO(state, relayEnv);
      const close = vi.spyOn((instance as unknown as { core: RelayCore }).core, "close");
      const p = state.getWebSockets().find((ws) => ws.deserializeAttachment().state === "phone")!;
      const a = state.getWebSockets().find((ws) => ws.deserializeAttachment().state === "agent")!;
      const transport = (
        instance as unknown as { transport: ReturnType<typeof createCloudflareTransport> }
      ).transport;
      const send = transport.send.bind(transport);
      vi.spyOn(transport, "send").mockImplementation((id, bytes) => {
        const result = send(id, bytes);
        if (id === p.deserializeAttachment().connId) p.close(1011, "injected close before flush");
        return result;
      });
      const raw = encodeEnvelope({
        v: 1,
        t: "e2e",
        from: host.fp,
        to: phone.fp,
        seq: 1,
        body: { n: new Uint8Array(24), c: new Uint8Array(32) },
      });
      await instance.webSocketMessage(a, new Uint8Array(raw).buffer);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(p.deserializeAttachment().connId);
      await close.mock.results[0]!.value;
      expect(a.readyState).toBe(WebSocket.OPEN);
      expect(transport.sessions().map((s) => s.state)).toEqual(["agent"]);
      // A repeated platform callback is harmless after synchronous retirement.
      await instance.webSocketClose(p, 1011);
    },
  );
  expect(await agent.nextCtrl()).toMatchObject({ type: "phone-disconnected", phoneFp: phone.fp });
  expect((await connected.closed).code).toBe(1011);
  agent.close();
  await agent.closed;
});

it("rejects every member of three duplicate restored IDs and fences old callback identity", async () => {
  const relayEnv = env as typeof env & Env;
  await runInDurableObject(
    relayEnv.COMPUTER.get(relayEnv.COMPUTER.newUniqueId()),
    (_instance, state) => {
      const pairs = Array.from({ length: 3 }, () => new WebSocketPair());
      for (const pair of pairs) {
        state.acceptWebSocket(pair[1]);
        pair[0].accept();
        pair[1].serializeAttachment({
          state: "unauth",
          connId: "duplicate",
          nonce: "A".repeat(43),
          since: 0,
          fp: null,
          name: null,
          leaseUntil: 0,
        });
      }
      const transport = createCloudflareTransport(state);
      expect(transport.sessions()).toEqual([]);
      for (const pair of pairs) {
        expect(transport.connectionId(pair[1])).toBeUndefined();
        pair[0].close();
      }
      const replacement = new WebSocketPair();
      const id = transport.accept(replacement[1]);
      replacement[0].accept();
      transport.close("duplicate", 1000, "late callback");
      expect(transport.send(id, new Uint8Array(1))).toBe("sent");
      transport.close(id, 1000, "done");
      expect(transport.connectionId(replacement[1])).toBeUndefined();
      replacement[0].close();
    },
  );
});

it("bounds application-queued Cloudflare frames per recipient and per object", async () => {
  const relayEnv = env as typeof env & Env;
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(new TestDevice("queue").fp));
  await runInDurableObject(stub, async (_instance, state) => {
    const transport = createCloudflareTransport(state, new QueueBudget(10, 15));
    const a = new WebSocketPair(),
      b = new WebSocketPair();
    const aid = transport.accept(a[1]),
      bid = transport.accept(b[1]);
    a[0].accept();
    b[0].accept();
    expect(transport.send(aid, new Uint8Array(10))).toBe("sent");
    expect(transport.send(aid, new Uint8Array(1))).toBe("overloaded");
    expect(transport.send(bid, new Uint8Array(6))).toBe("overloaded");
    expect(transport.send(bid, new Uint8Array(5))).toBe("sent");
    transport.close(aid, 1013, "overloaded");
    expect(transport.send(aid, new Uint8Array(1))).toBe("closed");
    await Promise.resolve();
    expect(transport.send(bid, new Uint8Array(10))).toBe("sent");
    transport.close(bid, 1000, "done");
    a[0].close();
    b[0].close();
  });
});

it("bounds held-provider handler promises without blocking another computer", async () => {
  const host = new TestDevice("held-cf"),
    phone = new TestDevice("phone");
  const { agent } = await agentOnline(host);
  await pairPhone(host, agent, phone);
  const connected = await connect(host.fp);
  await authenticate(connected, phone, "phone");
  await agent.nextCtrl();
  const relayEnv = env as typeof env & Env;
  const stub = relayEnv.COMPUTER.get(relayEnv.COMPUTER.idFromName(host.fp));
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const network = vi.fn(() => {
    throw new Error("unexpected external provider I/O");
  });
  vi.stubGlobal("fetch", network);
  try {
    await runInDurableObject(stub, async (_original, state) => {
      const instance = new ComputerDO(state, relayEnv, {
        notificationProvider: {
          async send(intents) {
            entered();
            await held;
            return intents.map(() => ({ status: "accepted" }));
          },
        },
      });
      const p = state
        .getWebSockets()
        .find((socket) => socket.deserializeAttachment().state === "phone")!;
      const a = state
        .getWebSockets()
        .find((socket) => socket.deserializeAttachment().state === "agent")!;
      const raw = (from: string, body: unknown) =>
        new Uint8Array(encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body })).buffer;
      await instance.webSocketMessage(
        p,
        raw(phone.fp, {
          type: "push-token",
          token: "native-held-token",
          provider: "fcm",
          platform: "android",
          enabled: true,
        }),
      );
      const tasks = [
        instance.webSocketMessage(
          a,
          raw(host.fp, { type: "notify", sessionId: "first", kind: "idle" }),
        ),
      ];
      try {
        await bounded(started, "provider entered");
        for (let i = 0; i < 150; i++)
          tasks.push(
            instance.webSocketMessage(
              a,
              raw(host.fp, { type: "notify", sessionId: `held-${i}`, kind: "idle" }),
            ),
          );
        expect((await bounded(agent.closed, "inbound overload")).code).toBe(1013);
        const other = await agentOnline(new TestDevice("unblocked-cf"));
        other.agent.close();
        await other.agent.closed;
      } finally {
        release();
        await Promise.all(tasks);
      }
    });
  } finally {
    release();
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    agent.close();
    connected.close();
    await Promise.all([agent.closed, connected.closed]);
  }
});
