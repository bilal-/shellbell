import { rmSync } from "node:fs";
import { toBase64Url } from "@shellbell/protocol";
import { QueueBudget, type SessionRecord } from "@shellbell/relay-core";
import { expect, it } from "vitest";
import {
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.js";
import { startRelay } from "../src/server.js";
import { createNodeTransport, type NodeSocket } from "../src/transport.js";
import { connect } from "./client.js";
import { temporaryDirectory } from "./helpers.js";

function heldSocket() {
  const writes: { bytes: Uint8Array; done: (error?: Error) => void }[] = [];
  const closes: number[] = [];
  const socket: NodeSocket = {
    readyState: 1,
    bufferedAmount: 0,
    send(bytes, done) {
      writes.push({
        bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes),
        done,
      });
    },
    close(code) {
      closes.push(code);
    },
  };
  return { socket, writes, closes };
}
function save(transport: ReturnType<typeof createNodeTransport>, id: string) {
  const session: SessionRecord = {
    version: 1,
    connId: id,
    nonce: toBase64Url(new Uint8Array(32)),
    since: 1,
    state: "unauth",
    fp: null,
    name: null,
    leaseUntil: 0,
  };
  transport.save(session);
}
it("reserves pending writes until callbacks, rejects overflow, and releases exactly once on close", () => {
  const budget = new QueueBudget(10, 15);
  const a = createNodeTransport(budget, 10),
    b = createNodeTransport(budget, 10);
  const sa = heldSocket(),
    sb = heldSocket();
  const aid = a.accept(sa.socket),
    bid = b.accept(sb.socket);
  save(a, aid);
  save(b, bid);
  expect(a.send(aid, new Uint8Array(10))).toBe("sent");
  expect(a.send(aid, new Uint8Array(1))).toBe("overloaded");
  expect(b.send(bid, new Uint8Array(6))).toBe("overloaded");
  expect(b.send(bid, new Uint8Array(5))).toBe("sent");
  a.close(aid, 1013, "overloaded");
  expect(a.sessions()).toEqual([]);
  expect(sa.closes).toEqual([1013]);
  sa.writes[0]!.done();
  sa.writes[0]!.done();
  expect(b.send(bid, new Uint8Array(6))).toBe("overloaded");
  sb.writes[0]!.done();
  expect(b.send(bid, new Uint8Array(10))).toBe("sent");
  expect(a.send(aid, new Uint8Array(1))).toBe("closed");
});

it("closes a real paused recipient with 1013, keeps other recipients live, and never replays queued ciphertext after reconnect", async () => {
  const dataDir = temporaryDirectory();
  const relay = await startRelay({
    dataDir,
    port: 0,
    connectionQueueBytes: 256 * 1024,
    shutdownMs: 100,
  });
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  const api = createScenarioClient(async (fp) => {
    const conn = await connect(relay.url, fp);
    clients.push(conn);
    return conn;
  });
  try {
    const host = new TestDevice("sender"),
      slowPhone = new TestDevice("slow"),
      fastPhone = new TestDevice("fast");
    const { agent } = await api.agentOnline(host);
    await api.pair(agent, host, slowPhone);
    await api.pair(agent, host, fastPhone);
    const slow = await api.connect(host.fp);
    await api.authenticate(slow, slowPhone, "phone");
    await agent.nextCtrl();
    const fast = await api.connect(host.fp);
    await api.authenticate(fast, fastPhone, "phone");
    await agent.nextCtrl();
    slow.ws.pause();
    let dropped = false;
    const disconnected = agent.nextCtrl(5000).then((value) => {
      expect(value.type).toBe("phone-disconnected");
      dropped = true;
    });
    for (let seq = 0; seq < 256 && !dropped; seq++) {
      agent.sendEnvelope({
        v: 1,
        t: "e2e",
        from: host.fp,
        to: slowPhone.fp,
        seq,
        body: { n: new Uint8Array(24), c: new Uint8Array(64 * 1024) },
      });
      // This healthy recipient's round trip proves the preceding frame was
      // processed, avoiding sleeps and unbounded producer-side flooding.
      agent.sendEnvelope({
        v: 1,
        t: "e2e",
        from: host.fp,
        to: fastPhone.fp,
        seq,
        body: { n: new Uint8Array(24), c: new Uint8Array([seq % 256]) },
      });
      expect((await fast.next()).seq).toBe(seq);
    }
    await disconnected;
    slow.ws.resume();
    expect((await slow.closed).code).toBe(1013);
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    const replacement = await api.connect(host.fp);
    await api.authenticate(replacement, slowPhone, "phone");
    await agent.nextCtrl();
    agent.sendEnvelope({
      v: 1,
      t: "e2e",
      from: host.fp,
      to: slowPhone.fp,
      seq: 999,
      body: { n: new Uint8Array(24), c: new Uint8Array([99]) },
    });
    expect((await replacement.next()).seq).toBe(999);
    const other = await api.agentOnline(new TestDevice("another-computer"));
    expect(other.agent.ws.readyState).toBe(1);
  } finally {
    for (const conn of clients) {
      conn.ws.resume();
      conn.close();
    }
    await relay.close();
    await Promise.all(clients.map((conn) => conn.closed));
    rmSync(dataDir, { recursive: true });
  }
}, 10_000);
it("contains send throws and asynchronous write errors without retaining closed records", () => {
  const budget = new QueueBudget(10, 10);
  const transport = createNodeTransport(budget, 10);
  const bad = heldSocket();
  const id = transport.accept(bad.socket);
  save(transport, id);
  const snapshot = transport.session(id)!;
  Object.assign(snapshot, { state: "phone", leaseUntil: 100 });
  expect(transport.session(id)).toMatchObject({ state: "unauth", leaseUntil: 0 });
  expect(transport.send(id, new Uint8Array(10))).toBe("sent");
  bad.writes[0]!.done(new Error("socket write"));
  expect(transport.send(id, new Uint8Array(1))).toBe("closed");
  expect(transport.session(id)).toBeUndefined();
  expect(budget.reserve("another", 10)).toBe(true);
});
