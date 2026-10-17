import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ITerm2Client } from "../src/backends/iterm2/client.js";
import {
  ClientOriginatedMessageSchema,
  GetPropertyRequestSchema,
  GetPropertyResponseSchema,
  ListSessionsRequestSchema,
  ListSessionsResponseSchema,
  NotificationSchema,
  ScreenUpdateNotificationSchema,
  ServerOriginatedMessageSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { createLogger } from "../src/log.js";

let server: Server;
let wss: WebSocketServer;
let url: string;
let headersSeen: Record<string, string | string[] | undefined> = {};

beforeEach(async () => {
  server = createServer();
  wss = new WebSocketServer({
    server,
    handleProtocols: (p) => (p.has("api.iterm2.com") ? "api.iterm2.com" : false),
  });
  wss.on("connection", (ws, req) => {
    headersSeen = req.headers;
    ws.on("message", (data) => {
      const msg = fromBinary(ClientOriginatedMessageSchema, new Uint8Array(data as Buffer));
      if (msg.submessage.case === "listSessionsRequest") {
        const resp = create(ServerOriginatedMessageSchema, {
          id: msg.id,
          submessage: {
            case: "listSessionsResponse",
            value: create(ListSessionsResponseSchema, { windows: [] }),
          },
        });
        ws.send(toBinary(ServerOriginatedMessageSchema, resp));
        const notif = create(ServerOriginatedMessageSchema, {
          submessage: {
            case: "notification",
            value: create(NotificationSchema, {
              screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }),
            }),
          },
        });
        ws.send(toBinary(ServerOriginatedMessageSchema, notif));
      }
      if (msg.submessage.case === "getPropertyRequest") {
        ws.send(
          toBinary(
            ServerOriginatedMessageSchema,
            create(ServerOriginatedMessageSchema, {
              id: msg.id,
              submessage: {
                case: "getPropertyResponse",
                value: create(GetPropertyResponseSchema, {
                  status: 0,
                  jsonValue: '{"history":3}',
                }),
              },
            }),
          ),
        );
      }
      // getBufferRequest is deliberately never answered → timeout test
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

const log = createLogger({ stdout: false });
const cookieProvider = async () => ({ cookie: "C", key: "K" });

describe("ITerm2Client", () => {
  it("fails only the closing socket's requests when it closes after a reconnect", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 5000 });
    const closes: number[] = [];
    c.on("close", () => closes.push(1));
    try {
      await c.connect();
      const old = Reflect.get(c, "ws") as import("ws").WebSocket;
      // Never answered, like a request in flight when iTerm2 restarted.
      const stranded = c.request({ case: "getBufferRequest", value: {} } as never);
      const strandedSettled = stranded.then(
        () => "resolved",
        () => "rejected",
      );
      // The old socket is closing but has not reported it; a new connection takes over.
      Object.defineProperty(old, "readyState", { configurable: true, value: 2 });
      await c.connect();
      const fresh = c.request({
        case: "listSessionsRequest",
        value: create(ListSessionsRequestSchema, {}),
      });
      old.emit("close");
      expect(await strandedSettled).toBe("rejected");
      expect((await fresh).submessage.case).toBe("listSessionsResponse");
      expect(closes).toHaveLength(1);
      expect(c.connected).toBe(true);
    } finally {
      c.close();
    }
  });

  it("shares one socket between connections started at the same time", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 500 });
    try {
      await Promise.all([c.connect(), c.connect()]);
      expect(wss.clients.size).toBe(1);
      // Every request still has a socket that answers it.
      const res = await c.request({
        case: "listSessionsRequest",
        value: create(ListSessionsRequestSchema, {}),
      });
      expect(res.submessage.case).toBe("listSessionsResponse");
    } finally {
      c.close();
    }
  });
  it("does not ask iTerm2 for a cookie while its Python API socket is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-iterm-socket-"));
    let asked = 0;
    const c = new ITerm2Client({
      log,
      socketPath: join(dir, "socket"),
      cookieProvider: async () => {
        asked++;
        return { cookie: "c", key: "k" };
      },
    });
    try {
      await expect(c.connect()).rejects.toThrow("iTerm2 Python API is off");
      writeFileSync(join(dir, "socket"), "");
      await expect(c.connect()).rejects.toThrow("iTerm2 Python API is off");
      expect(asked).toBe(0);
    } finally {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps socket failure content out of diagnostic logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-iterm-log-"));
    const file = join(dir, "agent.log");
    const c = new ITerm2Client({ log: createLogger({ file, stdout: false }), url, cookieProvider });
    try {
      await c.connect();
      Reflect.get(c, "ws").emit("error", new Error("PRIVATE_COOKIE_TERMINAL_SENTINEL"));
      const logged = readFileSync(file, "utf8");
      expect(logged).not.toContain("PRIVATE_COOKIE_TERMINAL_SENTINEL");
      expect(logged).toContain("iTerm2 socket error");
      expect(logged).toContain('"err":"Error"');
    } finally {
      c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("connects with the iTerm2 headers and correlates responses; notifications are emitted", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 500 });
    const notifs: string[] = [];
    c.on("notification", (n) => notifs.push(n.screenUpdateNotification?.session ?? ""));
    await c.connect();
    expect(headersSeen["x-iterm2-cookie"]).toBe("C");
    expect(headersSeen["x-iterm2-key"]).toBe("K");
    expect(headersSeen["x-iterm2-advisory-name"]).toBe("Shellbell");
    const res = await c.request({
      case: "listSessionsRequest",
      value: create(ListSessionsRequestSchema, {}),
    });
    expect(res.submessage.case).toBe("listSessionsResponse");
    await new Promise((r) => setTimeout(r, 50));
    expect(notifs).toEqual(["S1"]);
    c.close();
  });

  it("times out an unanswered request", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 100 });
    await c.connect();
    await expect(
      c.request({
        case: "getBufferRequest",
        value: { $typeName: "iterm2.GetBufferRequest", session: "x" } as never,
      }),
    ).rejects.toThrow(/timeout/);
    c.close();
  });

  it("correlates a property response from the local iTerm2 WebSocket", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 500 });
    await c.connect();

    const res = await c.request({
      case: "getPropertyRequest",
      value: create(GetPropertyRequestSchema, {
        identifier: { case: "sessionId", value: "S1" },
        name: "history",
      }),
    });

    expect(res.submessage).toMatchObject({
      case: "getPropertyResponse",
      value: { status: 0, jsonValue: '{"history":3}' },
    });
    c.close();
  });

  it("dials a Unix domain socket through createConnection when no url override is given", async () => {
    // Pins the fix from Local capture: never `socketPath`, never `ws+unix://`.
    const sock = join(mkdtempSync(join(tmpdir(), "sb-iterm-")), "socket");
    const unixServer = createServer();
    const unixWss = new WebSocketServer({
      server: unixServer,
      handleProtocols: (p) => (p.has("api.iterm2.com") ? "api.iterm2.com" : false),
    });
    await new Promise<void>((r) => unixServer.listen(sock, r));
    const c = new ITerm2Client({ log, socketPath: sock, cookieProvider, requestTimeoutMs: 500 });
    await c.connect();
    expect(c.connected).toBe(true);
    c.close();
    for (const s of unixWss.clients) s.terminate();
    await new Promise<void>((r) => unixWss.close(() => r()));
    await new Promise<void>((r) => unixServer.close(() => r()));
  });

  it("rejects pending requests when the socket closes and emits close", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 5000 });
    let closed = 0;
    c.on("close", () => closed++);
    await c.connect();
    const p = c.request({
      case: "getBufferRequest",
      value: { $typeName: "iterm2.GetBufferRequest", session: "x" } as never,
    });
    for (const s of wss.clients) s.terminate();
    await expect(p).rejects.toThrow(/closed/);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
  });

  it("settles connect() when close() is called while the connection is still in flight", async () => {
    // A raw TCP server that accepts the connection but never writes anything back, so the
    // WebSocket handshake never completes on its own — only close() can end it.
    const sockets: Socket[] = [];
    const stallServer = createNetServer((s) => sockets.push(s));
    await new Promise<void>((r) => stallServer.listen(0, "127.0.0.1", r));
    const stallUrl = `ws://127.0.0.1:${(stallServer.address() as AddressInfo).port}`;
    const c = new ITerm2Client({ log, url: stallUrl, cookieProvider, requestTimeoutMs: 5000 });
    const p = c.connect();
    await new Promise((r) => setTimeout(r, 20));
    c.close();
    await expect(p).rejects.toThrow(/closed/);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => stallServer.close(() => r()));
  }, 2000);

  it("gives up on a cookie request that never answers, so the next connect can retry", async () => {
    let asked = 0;
    const c = new ITerm2Client({
      log,
      url: "ws://127.0.0.1:9",
      cookieProvider: () => {
        asked += 1;
        return new Promise(() => {});
      },
      cookieTimeoutMs: 50,
    });
    // Both callers share the attempt, and both are released when the cookie request times out.
    const first = c.connect();
    const second = c.connect();
    await expect(first).rejects.toThrow(/cookie/);
    await expect(second).rejects.toThrow(/cookie/);
    await expect(c.connect()).rejects.toThrow(/cookie/);
    expect(asked).toBe(2);
  }, 2000);

  it("gives up on a handshake iTerm2 never finishes, so the next connect can retry", async () => {
    const sockets: Socket[] = [];
    const stallServer = createNetServer((s) => sockets.push(s));
    await new Promise<void>((r) => stallServer.listen(0, "127.0.0.1", r));
    const stallUrl = `ws://127.0.0.1:${(stallServer.address() as AddressInfo).port}`;
    const c = new ITerm2Client({
      log,
      url: stallUrl,
      cookieProvider,
      requestTimeoutMs: 5000,
      connectTimeoutMs: 100,
    });
    try {
      // Both callers share the attempt, and both are released when it times out.
      const first = c.connect();
      const second = c.connect();
      await expect(first).rejects.toThrow();
      await expect(second).rejects.toThrow();
      // A fresh attempt is made rather than joining the abandoned one.
      const retry = c.connect();
      expect(retry).not.toBe(first);
      await expect(retry).rejects.toThrow();
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    } finally {
      c.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => stallServer.close(() => r()));
    }
  }, 3000);

  it("frees the socket and rejects when the handshake gets a non-101 response", async () => {
    let liveConnections = 0;
    const authServer = createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    authServer.on("connection", (s) => {
      liveConnections++;
      s.on("close", () => liveConnections--);
    });
    await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", r));
    const authUrl = `ws://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
    const c = new ITerm2Client({ log, url: authUrl, cookieProvider, requestTimeoutMs: 500 });
    await expect(c.connect()).rejects.toThrow(/401/);
    await new Promise((r) => setTimeout(r, 50));
    expect(liveConnections).toBe(0);
    await new Promise<void>((r) => authServer.close(() => r()));
  }, 2000);
});
