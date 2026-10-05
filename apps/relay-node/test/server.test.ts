import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PushIntent } from "@shellbell/relay-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.js";
import * as apnsTransportModule from "../src/apns-transport.js";
import { type RunningRelay, startRelay } from "../src/server.js";
import { openRelayDatabase } from "../src/storage/database.js";
import { connect } from "./client.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
it.each(["database", "deadlines", "listener"])(
  "closes its APNs transport after %s startup failure",
  async (failure) => {
    const dataDir = temporaryDirectory();
    const owner = openRelayDatabase(dataDir, { attentive: () => false });
    if (failure !== "database") await owner.close();
    if (failure === "deadlines") {
      const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
      sql.prepare("INSERT INTO computer_deadlines VALUES ('invalid-fingerprint',1234)").run();
      sql.close();
    }
    const listener = failure === "listener" ? await start() : undefined;
    const transport = apnsTransportModule.createApnsHttp2Transport({
      connect: () => {
        throw new Error("Transport remained open");
      },
    });
    const factory = vi
      .spyOn(apnsTransportModule, "createApnsHttp2Transport")
      .mockReturnValue(transport);
    try {
      await expect(
        startRelay({ dataDir, port: listener ? Number(new URL(listener.url).port) : 0 }),
      ).rejects.toThrow();
      await expect(
        transport.fetch("https://api.push.apple.com/3/device/abcd", { method: "POST", body: "{}" }),
      ).rejects.toThrow(/closed/i);
    } finally {
      transport.close();
      factory.mockRestore();
      if (failure === "database") await owner.close();
      rmSync(dataDir, { recursive: true });
    }
  },
);

it("starts an injected provider without constructing a built-in APNs transport", async () => {
  const dataDir = temporaryDirectory();
  const factory = vi
    .spyOn(apnsTransportModule, "createApnsHttp2Transport")
    .mockImplementation(() => {
      throw new Error("Unexpected built-in transport");
    });
  try {
    const relay = await startRelay({ dataDir, port: 0 }, { provider: { send: async () => [] } });
    try {
      expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    } finally {
      await relay.close();
    }
  } finally {
    factory.mockRestore();
    rmSync(dataDir, { recursive: true });
  }
});
it("rejects unknown heartbeat text as malformed", async () => {
  const relay = await start();
  const conn = await connect(relay.url, new TestDevice("unknown-text").fp);
  await conn.nextCtrl();
  conn.ws.send("application text");
  expect((await conn.closed).code).toBe(4400);
});
it("releases exclusive ownership when corrupt persisted deadlines prevent startup", async () => {
  const dataDir = temporaryDirectory();
  const database = openRelayDatabase(dataDir, { attentive: () => false });
  await database.close();
  const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
  sql.prepare("INSERT INTO computer_deadlines VALUES ('invalid-fingerprint',1234)").run();
  sql.close();
  try {
    await expect(startRelay({ dataDir, port: 0 })).rejects.toThrow();
    const reopened = openRelayDatabase(dataDir, { attentive: () => false });
    await reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true });
  }
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function start() {
  const dataDir = temporaryDirectory();
  const relay = await startRelay({ dataDir, port: 0, shutdownMs: 100 });
  cleanup.push(async () => {
    await relay.close();
    rmSync(dataDir, { recursive: true });
  });
  return relay;
}
it("serves distinct liveness/readiness, validates routes and websocket upgrades", async () => {
  const relay = await start();
  expect(new URL(relay.url).hostname).toBe("127.0.0.1");
  expect((await fetch(`${relay.url}/`)).status).toBe(200);
  expect(await (await fetch(`${relay.url}/healthz`)).text()).toBe("ok");
  expect(await (await fetch(`${relay.url}/readyz`)).text()).toBe("ready");
  expect((await fetch(`${relay.url}/ws/nope`)).status).toBe(400);
  expect((await fetch(`${relay.url}/ws/${new TestDevice("host").fp}`)).status).toBe(426);
  expect((await fetch(`${relay.url}/missing`)).status).toBe(404);
});
it("keeps terminal authentication and readiness available with unreadable push credentials", async () => {
  const dataDir = temporaryDirectory();
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = await startRelay({
    dataDir,
    port: 0,
    fcmServiceAccountFile: join(dataDir, "private-secret.json"),
    apnsTopic: "invalid/topic",
  });
  const host = new TestDevice("push-config-failure");
  const conn = await connect(relay.url, host.fp);
  try {
    const api = createScenarioClient((fp) => connect(relay.url, fp));
    expect((await api.authenticate(conn, host, "agent")).type).toBe("auth-ok");
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    expect(diagnostic.mock.calls).toEqual([
      ["relay push unavailable", "fcm", "invalid-credentials"],
      ["relay push unavailable", "apns", "invalid-credentials"],
    ]);
  } finally {
    conn.close();
    await conn.closed;
    await relay.close();
    diagnostic.mockRestore();
    rmSync(dataDir, { recursive: true });
  }
});
it("requires explicit private storage and excludes concurrent owners", async () => {
  await expect(startRelay({ dataDir: "", port: 0 })).rejects.toThrow(/data/i);
  const dataDir = temporaryDirectory();
  let relay: RunningRelay | undefined;
  try {
    relay = await startRelay({ dataDir, port: 0 });
    await expect(startRelay({ dataDir, port: 0 })).rejects.toThrow(/owner|lock/i);
  } finally {
    await relay?.close();
    rmSync(dataDir, { recursive: true });
  }
});
it("does not negotiate compression and rejects absolute payload overflow", async () => {
  const relay = await start();
  const conn = await connect(relay.url, new TestDevice("host").fp);
  expect(conn.ws.extensions).toBe("");
  await conn.nextCtrl();
  conn.sendRaw(new Uint8Array(4097));
  expect((await conn.closed).code).toBe(4413);
});
it("answers the phone's text ping without consuming its authenticated session", async () => {
  const relay = await start();
  const host = new TestDevice("heartbeat");
  const conn = await connect(relay.url, host.fp);
  const api = createScenarioClient((fp) => connect(relay.url, fp));
  expect((await api.authenticate(conn, host, "agent")).type).toBe("auth-ok");
  const pong = new Promise<string>((resolve, reject) => {
    conn.ws.on("message", (data, binary) => {
      if (!binary) resolve(data.toString());
    });
    conn.ws.once("close", () => reject(new Error("ping closed authenticated socket")));
  });
  conn.ws.send("ping");
  expect(await pong).toBe("pong");
  conn.close();
  await conn.closed;
});
it("closes unauthenticated sockets when the persisted authentication deadline expires", async () => {
  const relay = await start();
  const conn = await connect(relay.url, new TestDevice("idle").fp);
  await conn.nextCtrl();
  expect((await conn.closed).code).toBe(4408);
}, 15_000);
it("replacement ownership survives late close callbacks and another computer stays usable", async () => {
  const relay = await start();
  const api = createScenarioClient((fp) => connect(relay.url, fp));
  const host = new TestDevice("host");
  const first = await api.agentOnline(host);
  const replacement = await api.agentOnline(host);
  expect((await first.agent.closed).code).toBe(4005);
  const other = await api.agentOnline(new TestDevice("other"));
  await api.pair(replacement.agent, host, new TestDevice("phone"));
  replacement.agent.close();
  other.agent.close();
});
it("uses the matching computer's live attention lease for a phone paired to two computers", async () => {
  const dataDir = temporaryDirectory();
  const sent: PushIntent[] = [];
  const relay = await startRelay(
    {
      dataDir,
      port: 0,
      shutdownMs: 100,
      fcmServiceAccountFile: join(dataDir, "missing-secret.json"),
      apnsPrivateKeyFile: join(dataDir, "missing-secret.p8"),
    },
    {
      provider: {
        send: async (messages) => {
          sent.push(...messages);
          return messages.map(() => ({
            status: "accepted" as const,
          }));
        },
      },
    },
  );
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    const api = createScenarioClient(async (fp) => {
      const conn = await connect(relay.url, fp);
      clients.push(conn);
      return conn;
    });
    const phone = new TestDevice("shared-phone"),
      hosts = [new TestDevice("viewed"), new TestDevice("background")];
    for (const [index, host] of hosts.entries()) {
      const { agent } = await api.agentOnline(host);
      await api.pair(agent, host, phone);
      const connected = await api.connect(host.fp);
      await api.authenticate(connected, phone, "phone");
      await agent.nextCtrl();
      connected.sendCtrl(phone.fp, {
        type: "push-token",
        token: "a".repeat(64),
        provider: "apns",
        environment: "production",
        platform: "ios",
        enabled: true,
      });
      if (index === 0) connected.sendCtrl(phone.fp, { type: "lease", ttlMs: 60_000 });
      connected.sendEnvelope({
        v: 1,
        t: "e2e",
        from: phone.fp,
        to: host.fp,
        seq: 1,
        body: { n: new Uint8Array(24), c: new Uint8Array([1]) },
      });
      await agent.next();
      agent.sendCtrl(host.fp, { type: "notify", sessionId: "attention", kind: "idle" });
      agent.sendEnvelope({
        v: 1,
        t: "e2e",
        from: host.fp,
        to: phone.fp,
        seq: 2,
        body: { n: new Uint8Array(24), c: new Uint8Array([2]) },
      });
      await connected.next();
    }
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.route.computerFp).toBe(hosts[1]!.fp);
  } finally {
    for (const conn of clients) conn.close();
    await relay.close();
    await Promise.all(clients.map((conn) => conn.closed));
    rmSync(dataDir, { recursive: true });
  }
});
