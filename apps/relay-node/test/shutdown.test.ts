import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createSecureServer,
  connect as http2Connect,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { clearTimeout as realClearTimeout, setTimeout as realTimeout } from "node:timers";
import type { SendOutcome } from "@shellbell/relay-core";
import { expect, it, vi } from "vitest";
import {
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.js";
import {
  notice,
  tokenMessage,
} from "../../../packages/relay-core/test-support/notification-store-contract.js";
import * as apnsTransportModule from "../src/apns-transport.js";
import { startRelay } from "../src/server.js";
import { openRelayDatabase } from "../src/storage/database.js";
import { connect } from "./client.js";
import { temporaryDirectory } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function childRelay(args: string[]) {
  const child = spawn(process.execPath, args, {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<string>((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.event === "ready") resolve(value.url);
      } catch {}
    });
    child.once("exit", () => reject(new Error(`child exited before ready: ${stderr}`)));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    return { child, url: await ready, exited, stderr: () => stderr };
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

it.each([false, true])(
  "returns bounded 400 for malformed request targets (upgrade=%s) and keeps the CLI alive",
  async (upgrade) => {
    execFileSync("pnpm", ["build"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
    const dataDir = temporaryDirectory();
    const child = await childRelay([
      "dist/cli.js",
      "--data-dir",
      dataDir,
      "--port",
      "0",
      "--shutdown-ms",
      "40",
    ]);
    try {
      const address = new URL(child.url);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: address.hostname, port: Number(address.port) });
        let received = "";
        socket.on("connect", () =>
          socket.write(
            `GET //[ HTTP/1.1\r\nHost: localhost\r\n${upgrade ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" : "Connection: close"}\r\n\r\n`,
          ),
        );
        socket.on("data", (data) => {
          received += data.toString();
          if (received.length > 4096) {
            socket.destroy();
            reject(new Error("unbounded HTTP error"));
          }
        });
        socket.on("end", () => resolve(received));
        socket.on("error", reject);
      });
      expect(response).toMatch(/^HTTP\/1\.1 400 /);
      expect((await fetch(`${child.url}/healthz`)).status).toBe(200);
      expect((await fetch(`${child.url}/readyz`)).status).toBe(200);
      const connection = await connect(child.url, new TestDevice("still-live").fp);
      expect((await connection.nextCtrl()).type).toBe("challenge");
      connection.close();
      await connection.closed;
    } finally {
      child.child.kill("SIGTERM");
      await child.exited;
      rmSync(dataDir, { recursive: true });
    }
  },
);

async function seeded(claimed = true) {
  const dataDir = temporaryDirectory();
  const host = new TestDevice("recovery-host"),
    phone = new TestDevice("recovery-phone");
  const database = openRelayDatabase(dataDir, { attentive: () => false });
  const now = Date.now();
  await database.identity(host.fp).registerComputer({
    fingerprint: host.fp,
    publicKey: host.id.ed25519.pub,
    name: host.name,
    firstSeen: now,
    lastSeen: now,
  });
  await database.identity(host.fp).addPairing(
    {
      phoneFp: phone.fp,
      publicKey: phone.id.ed25519.pub,
      name: phone.name,
      pushEnabled: true,
      pushToken: null,
      pushPlatform: null,
      pairedAt: now,
      lastSeenAt: null,
    },
    now,
  );
  await database.notifications(host.fp).register(phone.fp, tokenMessage, "seed-generation");
  await database.notifications(host.fp).enqueue(notice(), now - 20_000);
  if (claimed) await database.notifications(host.fp).claimSends(now - 20_000, 10);
  // Deliberately no deadline row: crash after durable claim but before scheduler write.
  await database.close();
  return { dataDir, host, phone };
}

it("closes an in-flight APNs session at shutdown and fences its durable claim", async () => {
  const f = await seeded(false);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(f.dataDir, "key.pem"),
      "-out",
      join(f.dataDir, "cert.pem"),
      "-subj",
      "/CN=api.push.apple.com",
      "-addext",
      "subjectAltName=DNS:api.push.apple.com",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(f.dataDir, "cert.pem"));
  const server = createSecureServer({ key: readFileSync(join(f.dataDir, "key.pem")), cert });
  const sessions: ServerHttp2Session[] = [];
  server.on("session", (session) => {
    sessions.push(session);
    session.on("error", () => {});
  });
  const entered = deferred();
  let stream!: ServerHttp2Stream;
  server.on("stream", (value: ServerHttp2Stream) => {
    stream = value;
    entered.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const create = apnsTransportModule.createApnsHttp2Transport;
  const transport = create({
    deadlineMs: 1000,
    connect: (_authority, settings) =>
      http2Connect(`https://127.0.0.1:${(server.address() as AddressInfo).port}`, {
        ...settings,
        ca: cert,
      }),
  });
  // Inject only the local TLS endpoint; exercise built-in credentials/provider and ownership.
  const factory = vi
    .spyOn(apnsTransportModule, "createApnsHttp2Transport")
    .mockReturnValue(transport);
  writeFileSync(
    join(f.dataDir, "apns.p8"),
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
  );
  const relay = await startRelay({
    dataDir: f.dataDir,
    port: 0,
    shutdownMs: 30,
    apnsPrivateKeyFile: join(f.dataDir, "apns.p8"),
    apnsTeamId: "TEAM123456",
    apnsKeyId: "KEY1234567",
    apnsTopic: "dev.example.app",
  });
  try {
    await entered.promise;
    const sessionClosed = once(sessions[0]!, "close");
    await relay.close();
    // A transport closed by its owner must reject even a well-formed later request immediately.
    await expect(
      transport.fetch("https://api.push.apple.com/3/device/abcd", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/closed/i);
    await sessionClosed;
    expect(stream.destroyed).toBe(true);
    const check = new DatabaseSync(join(f.dataDir, "relay.sqlite"));
    expect(check.prepare("SELECT phase FROM push_jobs").get()!.phase).toBe("sending");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(check.prepare("SELECT phase FROM push_jobs").get()!.phase).toBe("sending");
    check.close();
  } finally {
    await relay.close();
    transport.close();
    factory.mockRestore();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(f.dataDir, { recursive: true });
  }
});

it("runs successive authentication deadlines while timer-started provider work is held", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await seeded(false);
  const sql = new DatabaseSync(join(f.dataDir, "relay.sqlite"));
  sql.prepare("UPDATE push_jobs SET due_at = ?").run(now + 1000);
  sql.close();
  const entered = deferred(),
    held = deferred();
  let sends = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const relay = await startRelay(
    { dataDir: f.dataDir, port: 0, shutdownMs: 30 },
    {
      provider: {
        send: async () => {
          sends++;
          entered.resolve();
          await held.promise;
          return [{ status: "accepted" }];
        },
      },
    },
  );
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    now += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await entered.promise;
    for (let index = 0; index < 3; index++) {
      const conn = await connect(relay.url, f.host.fp);
      connections.push(conn);
      await conn.nextCtrl();
      now += 11_000;
      await vi.advanceTimersByTimeAsync(11_000);
      let watchdog: ReturnType<typeof realTimeout> | undefined;
      try {
        const closed = await Promise.race([
          conn.closed,
          new Promise<never>((_, reject) => {
            watchdog = realTimeout(
              () => reject(new Error("authentication deadline stalled behind provider")),
              500,
            );
          }),
        ]);
        expect(closed.code).toBe(4408);
      } finally {
        realClearTimeout(watchdog);
      }
    }
    expect(sends).toBe(1);
  } finally {
    held.resolve();
    vi.useRealTimers();
    clock.mockRestore();
    for (const conn of connections) conn.close();
    await relay.close();
    await Promise.all(connections.map((conn) => conn.closed));
    rmSync(f.dataDir, { recursive: true });
  }
});

it("recovers missing-deadline claims before readiness without waiting for held provider I/O", async () => {
  const f = await seeded();
  let release!: (value: readonly SendOutcome[]) => void;
  const entered = deferred();
  const relay = await startRelay(
    { dataDir: f.dataDir, port: 0, shutdownMs: 30 },
    {
      provider: {
        send: () => {
          entered.resolve();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    },
  );
  try {
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    const recovered = new DatabaseSync(join(f.dataDir, "relay.sqlite"));
    expect(recovered.prepare("SELECT phase, claim_id FROM push_jobs").get()).toEqual({
      phase: "send",
      claim_id: null,
    });
    recovered.close();
    await entered.promise;
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    const sql = new DatabaseSync(join(f.dataDir, "relay.sqlite"));
    expect(sql.prepare("SELECT count(*) AS n FROM computer_deadlines").get()!.n).toBe(1);
    expect(sql.prepare("SELECT phase FROM push_jobs").get()!.phase).toBe("sending");
    expect(sql.prepare("SELECT count(*) AS n FROM push_attempts").get()!.n).toBe(2);
    sql.close();
    const api = createScenarioClient((fp) => connect(relay.url, fp));
    const other = await api.agentOnline(new TestDevice("independent"));
    other.agent.close();
    await other.agent.closed;
    const began = performance.now();
    await relay.close();
    expect(performance.now() - began).toBeLessThan(1000);
    const reopened = openRelayDatabase(f.dataDir, { attentive: () => false });
    const check = new DatabaseSync(join(f.dataDir, "relay.sqlite"));
    expect(check.prepare("SELECT phase FROM push_jobs").get()!.phase).toBe("sending");
    release([{ status: "accepted" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(check.prepare("SELECT phase FROM push_jobs").get()!.phase).toBe("sending");
    check.close();
    await reopened.close();
  } finally {
    await relay.close();
    rmSync(f.dataDir, { recursive: true });
  }
}, 10_000);

it("bounds pending inbound handlers while provider work is held and keeps another computer responsive", async () => {
  const f = await seeded(false);
  const entered = deferred();
  const relay = await startRelay(
    { dataDir: f.dataDir, port: 0, shutdownMs: 30, connectionQueueBytes: 16_384 },
    {
      provider: {
        send: () => {
          entered.resolve();
          return new Promise(() => {});
        },
      },
    },
  );
  try {
    await entered.promise;
    const api = createScenarioClient((fp) => connect(relay.url, fp));
    const { agent } = await api.agentOnline(f.host);
    // Every notify joins the held provider pass after its local transition. The
    // handler credit must close this sender before promises accumulate unboundedly.
    for (let i = 0; i < 100; i++)
      agent.sendCtrl(f.host.fp, { type: "notify", sessionId: `held-${i}`, kind: "idle" });
    expect((await agent.closed).code).toBe(1013);
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    const other = await api.agentOnline(new TestDevice("unblocked"));
    other.agent.close();
    await other.agent.closed;
  } finally {
    await relay.close();
    rmSync(f.dataDir, { recursive: true });
  }
});

it("SIGTERM finishes bounded shutdown during held provider I/O and releases ownership after preserving its claim", async () => {
  const f = await seeded(false);
  const child = await childRelay([
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
    import {startRelay} from './src/server.ts';
    const relay=await startRelay({dataDir:process.argv[1],port:0,shutdownMs:40},{provider:{send:()=>new Promise(()=>{})}});
    process.once('SIGTERM',()=>void relay.close().then(()=>process.exit(0)));
    console.log(JSON.stringify({event:'ready',url:relay.url}));
  `,
    f.dataDir,
  ]);
  try {
    expect((await fetch(`${child.url}/readyz`)).status).toBe(200);
    expect(() => openRelayDatabase(f.dataDir, { attentive: () => false })).toThrow(/owner|lock/i);
    child.child.kill("SIGTERM");
    const timer = setTimeout(() => child.child.kill("SIGKILL"), 2000);
    const [code, signal] = await child.exited;
    clearTimeout(timer);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    const database = openRelayDatabase(f.dataDir, { attentive: () => false });
    const sql = new DatabaseSync(join(f.dataDir, "relay.sqlite"));
    expect(sql.prepare("SELECT phase,send_count FROM push_jobs").get()).toEqual({
      phase: "sending",
      send_count: 1,
    });
    expect(sql.prepare("SELECT count(*) AS n FROM computer_deadlines").get()!.n).toBe(1);
    sql.close();
    await database.close();
    expect(child.stderr()).not.toMatch(/unhandled|closed|runtime-failure/i);
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null)
      child.child.kill("SIGKILL");
    await child.exited;
    rmSync(f.dataDir, { recursive: true });
  }
});

it("runs the bundled CLI on an ephemeral loopback port and closes its sockets on SIGTERM", async () => {
  execFileSync("pnpm", ["build"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const dataDir = temporaryDirectory();
  const child = await childRelay([
    "dist/cli.js",
    "--data-dir",
    dataDir,
    "--port",
    "0",
    "--shutdown-ms",
    "40",
  ]);
  try {
    const conn = await connect(child.url, new TestDevice("cli-client").fp);
    await conn.nextCtrl();
    child.child.kill("SIGTERM");
    const timer = setTimeout(() => child.child.kill("SIGKILL"), 2000);
    const [code, signal] = await child.exited;
    clearTimeout(timer);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    await conn.closed;
    const database = openRelayDatabase(dataDir, { attentive: () => false });
    await database.close();
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null)
      child.child.kill("SIGKILL");
    await child.exited;
    rmSync(dataDir, { recursive: true });
  }
});
