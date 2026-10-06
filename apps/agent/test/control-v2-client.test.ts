import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  derivePskKey,
  encodeCbor,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  pairingAd,
  parseQr,
  seal,
} from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { BACKEND_ORDER, BackendRegistry } from "../src/backends/registry.js";
import { chooseConfirm } from "../src/cli.js";
import { loadConfig, loadPairings, paths } from "../src/config.js";
import * as control from "../src/control.js";
import type { ControlRuntime, ControlV2Request } from "../src/control-v2-protocol.js";
import type { LocalStatus } from "../src/local-status.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const runtime: ControlRuntime = {
  pid: 123,
  agentVersion: "1.2.3",
  computerFp: "a".repeat(26),
  stateDir: "/synthetic/state",
  serviceInstance: null,
};
const status: LocalStatus = {
  controlVersion: 1,
  process: runtime,
  backends: BACKEND_ORDER.map((name) => ({ name, connected: false })),
  terminalReady: false,
  relayOnline: false,
  sessions: 0,
  phones: [],
  connected: [],
};
const hello = { version: 2, runtime, capabilities: ["status", "devices", "pairing", "revoke"] };
const flowId = "f".repeat(22);
const phoneFp = "b".repeat(26);
const requestEvent = {
  v: 2,
  event: "pairing.request",
  flowId,
  challengeId: "c".repeat(22),
  phoneFp,
  name: "Private phone",
};
const opened = { flowId, qrText: "private-qr", expiresAt: 123456789 };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const success = (id: number, data: unknown) => ({ v: 2, id, ok: true, data });

async function peer(handle: (req: ControlV2Request, socket: Socket) => void) {
  const dir = mkdtempSync(join(tmpdir(), "sb-client-"));
  const path = join(dir, "test.sock");
  const requests: ControlV2Request[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    const decoder = new control.ControlLineDecoder({
      onLine: (line) => {
        const req = control.ControlV2RequestSchema.parse(JSON.parse(line));
        requests.push(req);
        handle(req, socket);
      },
      onError: () => socket.destroy(),
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("end", () => decoder.finish());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, requests, sockets };
}

async function connected(
  handle: (req: ControlV2Request, socket: Socket) => void = (req, socket) =>
    socket.write(frame(success(req.id, status))),
  options = {},
) {
  const fixture = await peer((req, socket) => {
    if (req.cmd === "hello") socket.write(frame(success(req.id, hello)));
    else handle(req, socket);
  });
  const client = await control.connectControlV2(fixture.path, options);
  cleanup.push(() => client.close());
  return { ...fixture, client };
}

describe("native control client", () => {
  it("queries applied configuration without ownership or mutation fields", async () => {
    const f = await connected((req, socket) =>
      socket.write(frame(success(req.id, { revision: "a".repeat(64) }))),
    );
    expect(f.client.configurationRevision).toBeTypeOf("function");
    expect(await f.client.configurationRevision()).toBe("a".repeat(64));
    expect(f.requests).toEqual([
      { v: 2, id: 1, cmd: "hello" },
      { v: 2, id: 2, cmd: "status.config" },
    ]);
  });
  it("maps only an older service's typed bad-request to unknown and keeps the connection usable", async () => {
    const f = await connected((req, socket) =>
      socket.write(
        frame(
          req.cmd === "status.config"
            ? { v: 2, id: req.id, ok: false, error: { code: "bad-request" } }
            : success(req.id, status),
        ),
      ),
    );
    expect(await f.client.configurationRevision()).toBeNull();
    expect(await f.client.status()).toEqual(status);
    expect(f.requests.map((r) => r.cmd)).toEqual(["hello", "status.config", "status"]);
  });
  it.each(["operation-failed", "runtime-mismatch"] as const)(
    "propagates %s on the config query without retry",
    async (code) => {
      const f = await connected((req, socket) =>
        socket.write(frame({ v: 2, id: req.id, ok: false, error: { code } })),
      );
      await expect(f.client.configurationRevision()).rejects.toMatchObject({
        code: "server-error",
        serverCode: code,
      });
      expect(f.requests.map((r) => r.cmd)).toEqual(["hello", "status.config"]);
    },
  );
  it.each([{ revision: "A".repeat(64) }, { revision: "bad" }])(
    "rejects malformed configuration results",
    async (data) => {
      const f = await connected((req, socket) => socket.write(frame(success(req.id, data))));
      await expect(f.client.configurationRevision()).rejects.toMatchObject({
        code: "protocol-error",
      });
      expect(f.requests).toHaveLength(2);
    },
  );
  it("preserves readonly delivery failure and rejects malformed bad-request envelopes", async () => {
    const f = await connected((_req, socket) => socket.destroy());
    await expect(f.client.configurationRevision()).rejects.toMatchObject({ code: "unavailable" });
    const malformed = await connected((req, socket) =>
      socket.write(
        frame({ v: 2, id: req.id, ok: false, error: { code: "bad-request", extra: true } }),
      ),
    );
    await expect(malformed.client.configurationRevision()).rejects.toMatchObject({
      code: "protocol-error",
    });
    expect(f.requests).toHaveLength(2);
    expect(malformed.requests).toHaveLength(2);
  });
  it("exports the typed connector and performs hello then a real status exchange", async () => {
    expect(control.connectControlV2).toBeTypeOf("function");
    const f = await connected();
    expect(f.client.runtime).toEqual(runtime);
    expect(await f.client.status()).toEqual(status);
    expect(f.requests).toEqual([
      { v: 2, id: 1, cmd: "hello" },
      { v: 2, id: 2, cmd: "status" },
    ]);
  });

  it("keeps private hello observation independent of public runtime and increments mutation IDs", async () => {
    const f = await connected((req, socket) =>
      socket.write(frame(success(req.id, req.cmd === "devices" ? [] : { removed: true }))),
    );
    f.client.runtime.pid = 999;
    f.client.runtime.stateDir = "/changed";
    expect(await f.client.devices()).toEqual([]);
    expect(await f.client.revoke(phoneFp)).toEqual({ removed: true });
    expect(f.requests[2]).toEqual({
      v: 2,
      id: 3,
      cmd: "devices.revoke",
      args: { phoneFp },
      expect: runtime,
    });
  });

  it("rejects concurrent calls busy without queueing a second request", async () => {
    const f = await connected(() => {});
    const pending = f.client.status();
    await expect(f.client.devices()).rejects.toMatchObject({ code: "busy" });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.sockets[0]!.write(frame(success(2, status)));
    await expect(pending).resolves.toEqual(status);
    expect(f.requests).toHaveLength(2);
  });

  it.each([
    ["missing capability", { ...hello, capabilities: ["status", "devices", "pairing"] }],
    ["invalid runtime", { ...hello, runtime: { ...runtime, pid: 0 } }],
    ["extra capability", { ...hello, capabilities: [...hello.capabilities, "settings"] }],
  ])("rejects invalid hello: %s", async (_name, data) => {
    const f = await peer((req, socket) => socket.write(frame(success(req.id, data))));
    await expect(control.connectControlV2(f.path)).rejects.toMatchObject({
      code: "protocol-error",
    });
    expect(f.requests).toHaveLength(1);
  });

  it("reports old-server upgrade-required without sending legacy commands", async () => {
    const f = await peer((_req, socket) =>
      socket.write(frame({ ok: false, error: "unknown command" })),
    );
    await expect(control.connectControlV2(f.path)).rejects.toMatchObject({
      code: "upgrade-required",
    });
    expect(f.requests.map((req) => req.cmd)).toEqual(["hello"]);
  });

  it.each([
    ["wrong ID", frame(success(99, { removed: true }))],
    ["invalid result", frame(success(2, { removed: "private text" }))],
    ["malformed JSON", "{private-secret\n"],
    ["invalid UTF-8", Buffer.from([0xff, 10])],
    ["oversized frame", `${"x".repeat(control.CONTROL_LIMITS.lineBytes + 1)}\n`],
    ["incomplete frame", "{private-secret"],
  ])(
    "reports unknown mutation delivery for %s and the separate protocol cause",
    async (_name, reply) => {
      const errors: Error[] = [];
      const f = await connected((_req, socket) => socket.end(reply), {
        onDisconnect: (error: Error) => errors.push(error),
      });
      const pending = f.client.revoke(phoneFp);
      await expect(pending).rejects.toMatchObject({ code: "delivery-unknown" });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toMatchObject({ code: "protocol-error" });
      expect(errors[0]!.message).not.toContain("private");
      expect(f.requests.map((req) => req.cmd)).toEqual(["hello", "devices.revoke"]);
    },
  );

  it("reports lost post-send mutation response once without retry", async () => {
    const errors: Error[] = [];
    const f = await connected((_req, socket) => socket.destroy(), {
      onDisconnect: (error: Error) => errors.push(error),
    });
    await expect(f.client.revoke(phoneFp)).rejects.toMatchObject({ code: "delivery-unknown" });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    f.client.close();
    expect(errors).toHaveLength(1);
    expect(f.requests.filter((req) => req.cmd === "devices.revoke")).toHaveLength(1);
  });

  it("preserves a valid typed server error and allows the next request", async () => {
    const f = await connected((req, socket) =>
      socket.write(
        frame(
          req.cmd === "devices.revoke"
            ? { v: 2, id: req.id, ok: false, error: { code: "runtime-mismatch" } }
            : success(req.id, []),
        ),
      ),
    );
    await expect(f.client.revoke(phoneFp)).rejects.toMatchObject({
      code: "server-error",
      serverCode: "runtime-mismatch",
    });
    expect(await f.client.devices()).toEqual([]);
  });

  it("installs flow ownership before coalesced open response/request event and accepts closed before confirm acknowledgement", async () => {
    const socket = new ConnectorSocket();
    const events: unknown[] = [];
    const client = await injected(socket, {
      onPairingRequest: (event: unknown) => events.push(event),
      onPairingClosed: (event: unknown) => events.push(event),
    });
    socket.behavior = "silent";
    const opening = client.openPairing();
    // Exactly one client data event, independent of OS socket fragmentation.
    socket.emit("data", Buffer.from(frame(success(2, opened)) + frame(requestEvent)));
    expect(events).toEqual([requestEvent]);
    expect(await opening).toEqual(opened);
    const confirming = client.confirm(flowId, requestEvent.challengeId, phoneFp, true);
    socket.emit(
      "data",
      Buffer.from(frame({ v: 2, event: "pairing.closed", flowId }) + frame(success(3, {}))),
    );
    await confirming;
    expect(events).toEqual([requestEvent, { v: 2, event: "pairing.closed", flowId }]);
    expect(socket.writes[2]).toMatchObject({
      cmd: "pairing.confirm",
      expect: runtime,
      args: { flowId, challengeId: requestEvent.challengeId, phoneFp, accept: true },
    });
  });

  it("accepts a split close response followed by the owned closed event", async () => {
    const events: unknown[] = [];
    let releaseClosed!: () => void;
    const f = await connected(
      (req, socket) => {
        if (req.cmd === "pairing.open") socket.write(frame(success(req.id, opened)));
        else if (req.cmd === "pairing.close") {
          socket.write(frame(success(req.id, {})));
          releaseClosed = () => socket.write(frame({ v: 2, event: "pairing.closed", flowId }));
        } else socket.write(frame(success(req.id, status)));
      },
      { onPairingClosed: (event: unknown) => events.push(event) },
    );
    await f.client.openPairing();
    await expect(f.client.closePairing(flowId)).resolves.toBeUndefined();
    expect(events).toEqual([]);
    releaseClosed();
    await vi.waitFor(() => expect(events).toEqual([{ v: 2, event: "pairing.closed", flowId }]));
    await expect(f.client.status()).resolves.toEqual(status);
  });

  it("accepts closed before close response and attaches the observation", async () => {
    const f = await connected((req, socket) =>
      socket.write(
        req.cmd === "pairing.open"
          ? frame(success(req.id, opened))
          : frame({ v: 2, event: "pairing.closed", flowId }) + frame(success(req.id, {})),
      ),
    );
    await f.client.openPairing();
    await expect(f.client.closePairing(flowId)).resolves.toBeUndefined();
    expect(f.requests[2]).toMatchObject({
      cmd: "pairing.close",
      expect: runtime,
      args: { flowId },
    });
  });

  it("rejects request events for an unowned flow", async () => {
    const errors: Error[] = [];
    const f = await connected(
      (req, socket) => socket.write(frame(requestEvent) + frame(success(req.id, status))),
      { onDisconnect: (error: Error) => errors.push(error) },
    );
    await expect(f.client.status()).rejects.toMatchObject({ code: "protocol-error" });
    expect(errors).toHaveLength(1);
  });

  it("rejects malformed and wrong-flow events without exposing callback data", async () => {
    const events: unknown[] = [];
    const errors: Error[] = [];
    let releaseEvent!: () => void;
    const f = await connected(
      (req, socket) => {
        socket.write(frame(success(req.id, opened)));
        releaseEvent = () => socket.write(frame({ ...requestEvent, flowId: "x".repeat(22) }));
      },
      {
        onPairingRequest: (event: unknown) => events.push(event),
        onDisconnect: (error: Error) => errors.push(error),
      },
    );
    await f.client.openPairing();
    releaseEvent();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: "protocol-error" });
    await expect(f.client.status()).rejects.toMatchObject({ code: "closed" });
    expect(events).toEqual([]);
  });

  it("rejects invalid method arguments before sending and can still make a valid request", async () => {
    const f = await connected();
    await expect(f.client.revoke("bad-private-fp")).rejects.toMatchObject({
      code: "protocol-error",
    });
    expect(await f.client.status()).toEqual(status);
    expect(f.requests.map((req) => req.cmd)).toEqual(["hello", "status"]);
  });

  it("handles late duplicate responses as a terminal protocol error", async () => {
    const errors: Error[] = [];
    const f = await connected(
      (req, socket) =>
        socket.write(frame(success(req.id, status)) + frame(success(req.id, status))),
      { onDisconnect: (error: Error) => errors.push(error) },
    );
    expect(await f.client.status()).toEqual(status);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: "protocol-error" });
    await expect(f.client.devices()).rejects.toMatchObject({ code: "closed" });
  });
});

// A connector-controlled socket isolates pre-write refusal from attempted delivery.
class ConnectorSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  connecting = true;
  writes: ControlV2Request[] = [];
  behavior: "respond" | "silent" | "throw" | "buffered" = "respond";
  write(bytes: Uint8Array) {
    const request = JSON.parse(Buffer.from(bytes).toString()) as ControlV2Request;
    this.writes.push(request);
    if (this.behavior === "throw") throw new Error("private exception");
    if (this.behavior === "silent") return true;
    queueMicrotask(() =>
      this.emit(
        "data",
        Buffer.from(
          frame(success(request.id, request.cmd === "hello" ? hello : { removed: true })),
        ),
      ),
    );
    return this.behavior !== "buffered";
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  }
  connect() {
    this.connecting = false;
    this.emit("connect");
  }
}
async function injected(socket: ConnectorSocket, options = {}) {
  const promise = control.connectControlV2("/synthetic/socket", {
    ...options,
    connector: () => socket as unknown as Socket,
  });
  socket.connect();
  const client = await promise;
  cleanup.push(() => client.close());
  return client;
}
describe("connector boundaries", () => {
  it.each(["between frames", "inside event"])(
    "handles deterministic split delivery %s",
    async (split) => {
      const socket = new ConnectorSocket();
      const events: unknown[] = [];
      const client = await injected(socket, {
        onPairingRequest: (event: unknown) => events.push(event),
      });
      socket.behavior = "silent";
      const opening = client.openPairing();
      const eventBytes = Buffer.from(frame(requestEvent));
      const offset = split === "between frames" ? 0 : Math.floor(eventBytes.length / 2);
      socket.emit(
        "data",
        Buffer.concat([Buffer.from(frame(success(2, opened))), eventBytes.subarray(0, offset)]),
      );
      expect(await opening).toEqual(opened);
      // Open is complete, but the consent frame is deliberately not complete yet.
      expect(events).toEqual([]);
      socket.emit("data", eventBytes.subarray(offset));
      await vi.waitFor(() => expect(events).toEqual([requestEvent]));
    },
  );

  it("reports protocol-error for an in-flight read when a delayed wrong-flow event arrives", async () => {
    const socket = new ConnectorSocket();
    const errors: Error[] = [];
    const client = await injected(socket, { onDisconnect: (error: Error) => errors.push(error) });
    socket.behavior = "silent";
    const opening = client.openPairing();
    socket.emit("data", Buffer.from(frame(success(2, opened))));
    await opening;
    const reading = client.status();
    const rejected = expect(reading).rejects.toMatchObject({ code: "protocol-error" });
    socket.emit("data", Buffer.from(frame({ ...requestEvent, flowId: "x".repeat(22) })));
    await rejected;
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await expect(client.status()).rejects.toMatchObject({ code: "closed" });
  });

  it("does not create state when a read-only socket connection is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-client-missing-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(
      control.connectControlV2(join(dir, "missing", "agent.sock")),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("validates event schema even when a closed event names an unowned flow", async () => {
    const socket = new ConnectorSocket();
    const errors: Error[] = [];
    const client = await injected(socket, { onDisconnect: (error: Error) => errors.push(error) });
    socket.emit(
      "data",
      Buffer.from(
        frame({ v: 2, event: "pairing.closed", flowId, privateField: "private content" }),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "protocol-error" });
    await expect(client.devices()).rejects.toMatchObject({ code: "closed" });
  });

  it("ignores an unrelated closed flow while preserving owned flow callbacks", async () => {
    const events: unknown[] = [];
    let releaseEvents!: () => void;
    const f = await connected(
      (req, socket) => {
        socket.write(frame(success(req.id, opened)));
        releaseEvents = () =>
          socket.write(
            frame({ v: 2, event: "pairing.closed", flowId: "x".repeat(22) }) + frame(requestEvent),
          );
      },
      {
        onPairingClosed: (event: unknown) => events.push(event),
        onPairingRequest: (event: unknown) => events.push(event),
      },
    );
    await f.client.openPairing();
    releaseEvents();
    await vi.waitFor(() => expect(events).toEqual([requestEvent]));
  });

  it("settles intentional close during a submitted mutation as unknown delivery", async () => {
    const socket = new ConnectorSocket();
    const client = await injected(socket);
    socket.behavior = "silent";
    const pending = client.revoke(phoneFp);
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "delivery-unknown" });
    expect(socket.writes).toHaveLength(2);
  });

  it("enforces the queued-output cap including the encoded request and LF", async () => {
    const socket = new ConnectorSocket();
    const client = await injected(socket);
    const bytes = control.encodeControlLine({
      v: 2,
      id: 2,
      cmd: "devices.revoke",
      expect: runtime,
      args: { phoneFp },
    })!;
    socket.writableLength = control.CONTROL_LIMITS.queuedBytes - bytes.byteLength + 1;
    await expect(client.revoke(phoneFp)).rejects.toMatchObject({ code: "unavailable" });
    expect(socket.writes).toHaveLength(1);
  });

  it("accepts exactly capped queued-output without adding a retry queue", async () => {
    const socket = new ConnectorSocket();
    const client = await injected(socket);
    const bytes = control.encodeControlLine({
      v: 2,
      id: 2,
      cmd: "devices.revoke",
      expect: runtime,
      args: { phoneFp },
    })!;
    socket.writableLength = control.CONTROL_LIMITS.queuedBytes - bytes.byteLength;
    socket.behavior = "buffered";
    await expect(client.revoke(phoneFp)).resolves.toEqual({ removed: true });
    expect(socket.writes).toHaveLength(2);
  });

  it("rejects unavailable connection with content-free errors", async () => {
    await expect(
      control.connectControlV2("/private/path", {
        connector: () => {
          throw new Error("private exception");
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable", message: "Local control unavailable" });
  });
  it("enforces a five-second connect deadline", async () => {
    vi.useFakeTimers();
    const socket = new ConnectorSocket();
    const pending = control.connectControlV2("/synthetic/socket", {
      connector: () => socket as unknown as Socket,
    });
    const checked = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(4999);
    expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(socket.writes).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });
  it.each(["hello", "status", "mutation"] as const)(
    "enforces a five-second %s response deadline",
    async (kind) => {
      vi.useFakeTimers();
      const socket = new ConnectorSocket();
      if (kind === "hello") socket.behavior = "silent";
      let pending: Promise<unknown>;
      if (kind === "hello") {
        pending = control.connectControlV2("/synthetic/socket", {
          connector: () => socket as unknown as Socket,
        });
        socket.connect();
      } else {
        const client = await injected(socket);
        socket.behavior = "silent";
        pending = kind === "status" ? client.status() : client.revoke(phoneFp);
      }
      const checked = expect(pending).rejects.toMatchObject({
        code: kind === "mutation" ? "delivery-unknown" : "timeout",
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(socket.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await checked;
      expect(socket.destroyed).toBe(true);
    },
  );
  it.each(["destroyed", "full", "invalid-length"])(
    "reports known pre-send refusal for %s transport",
    async (kind) => {
      const socket = new ConnectorSocket();
      const client = await injected(socket);
      if (kind === "destroyed") socket.destroyed = true;
      else
        socket.writableLength = kind === "full" ? control.CONTROL_LIMITS.queuedBytes : Number.NaN;
      await expect(client.revoke(phoneFp)).rejects.toMatchObject({ code: "unavailable" });
      expect(socket.writes).toHaveLength(1);
    },
  );
  it("treats thrown socket.write after attempt as unknown delivery", async () => {
    const socket = new ConnectorSocket();
    const client = await injected(socket);
    socket.behavior = "throw";
    await expect(client.revoke(phoneFp)).rejects.toMatchObject({ code: "delivery-unknown" });
    expect(socket.writes).toHaveLength(2);
  });
  it("accepts Node false write return as buffering without retry", async () => {
    const socket = new ConnectorSocket();
    const client = await injected(socket);
    socket.behavior = "buffered";
    await expect(client.revoke(phoneFp)).resolves.toEqual({ removed: true });
    expect(socket.writes).toHaveLength(2);
  });
  it("handles close/error duplication and ignores data after closure", async () => {
    const socket = new ConnectorSocket();
    const errors: Error[] = [];
    const client = await injected(socket, { onDisconnect: (error: Error) => errors.push(error) });
    socket.emit("error", new Error("private data"));
    socket.emit("error", new Error("more private data"));
    socket.emit("close");
    socket.emit("data", Buffer.from("not json\n"));
    client.close();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "unavailable" });
    await expect(client.revoke(phoneFp)).rejects.toMatchObject({ code: "closed" });
  });
});

async function realServer() {
  const dir = mkdtempSync(join(tmpdir(), "sb-client-real-"));
  const p = paths(dir);
  const identity = generateIdentity();
  const log = createLogger({ stdout: false });
  const registry = new BackendRegistry(log);
  registry.add(new FakeBackend());
  let server!: control.ControlServer;
  const routing: { server: control.ControlServer | null } = { server: null };
  const agent = new Agent({
    paths: p,
    config: { ...loadConfig(p), computerName: "Test Mac" },
    identity,
    fp: fingerprint(identity.ed25519.pub),
    registry,
    log,
    appVersion: "0.0.1-test",
    confirm: chooseConfirm(routing, false, async () => {
      throw new Error("consent needs control owner");
    }),
    onPairingClosed: () => server.notifyClosed(),
  });
  const path = join(dir, "agent.sock");
  server = new control.ControlServer(path, agent, log);
  routing.server = server;
  await server.start();
  cleanup.push(async () => {
    await server.stop();
    agent.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { p, path, agent, server };
}
function encryptedRequest(qrText: string) {
  const identity = generateIdentity();
  const qr = parseQr(qrText);
  const phoneFp = fingerprint(identity.ed25519.pub);
  return {
    type: "pairing-request" as const,
    phoneFp,
    box: seal(
      derivePskKey(fromBase64Url(qr.p), qr.c),
      encodeCbor({
        ed25519Pub: identity.ed25519.pub,
        x25519Pub: identity.x25519.pub,
        name: "Fixture phone",
        platform: "ios",
      }),
      pairingAd("request", qr.c, phoneFp),
    ),
  };
}
describe("reviewed Agent and ControlServer compatibility", () => {
  it("opens, routes encrypted consent, confirms, closes and refreshes persisted devices without Agent.start", async () => {
    const f = await realServer();
    const events: control.ControlV2Event[] = [];
    const client = await control.connectControlV2(f.path, {
      onPairingRequest: (event) => events.push(event),
      onPairingClosed: (event) => events.push(event),
    });
    cleanup.push(() => client.close());
    expect(await client.status()).toEqual({
      ...f.agent.localStatus,
      relayOnline: false,
      sessions: 0,
      phones: [],
      connected: [],
    });
    const opened = await client.openPairing();
    const request = encryptedRequest(opened.qrText);
    const paired = f.agent.pairing.handleRequest(request);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const event = events[0]!;
    if (event.event !== "pairing.request") throw new Error("expected consent event");
    await client.confirm(event.flowId, event.challengeId, event.phoneFp, true);
    await paired;
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual({ v: 2, event: "pairing.closed", flowId: opened.flowId });
    expect((await client.devices()).map((phone) => phone.phoneFp)).toEqual([request.phoneFp]);
    expect(loadPairings(f.p).map((phone) => phone.phoneFp)).toEqual([request.phoneFp]);
    expect(await client.revoke(request.phoneFp)).toEqual({ removed: true });
    expect(await client.devices()).toEqual([]);
  });

  it("closing a status client preserves another client's pairing, while owner disconnect resolves pending consent", async () => {
    const f = await realServer();
    const events: control.ControlV2Event[] = [];
    const owner = await control.connectControlV2(f.path, {
      onPairingRequest: (event) => events.push(event),
    });
    cleanup.push(() => owner.close());
    const observer = await control.connectControlV2(f.path);
    cleanup.push(() => observer.close());
    const opened = await owner.openPairing();
    await observer.status();
    observer.close();
    expect((await owner.status()).phones).toEqual([]);
    expect(f.agent.pairingOpen).toBe(true);
    const request = f.agent.pairing.handleRequest(encryptedRequest(opened.qrText));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    owner.close();
    await request;
    await vi.waitFor(() => expect(f.agent.pairingOpen).toBe(false));
    expect(loadPairings(f.p)).toEqual([]);
  });

  it("ignores a closed event from an opening flow that failed before ownership", async () => {
    const f = await realServer();
    const events: control.ControlV2Event[] = [];
    const client = await control.connectControlV2(f.path, {
      onPairingClosed: (event) => events.push(event),
    });
    cleanup.push(() => client.close());
    const open = f.agent.openPairing.bind(f.agent);
    vi.spyOn(f.agent, "openPairing").mockImplementation(() => {
      const result = open();
      f.agent.closePairing();
      return result;
    });
    await expect(client.openPairing()).rejects.toMatchObject({
      code: "server-error",
      serverCode: "operation-failed",
    });
    expect(events).toEqual([]);
    expect(await client.status()).toEqual({
      ...f.agent.localStatus,
      relayOnline: false,
      sessions: 0,
      phones: [],
      connected: [],
    });
  });

  it("retains legacy status, devices, revoke and pairing clients against the v2 server", async () => {
    const f = await realServer();
    expect(await control.controlRequest(f.path, "status")).toEqual({
      ...f.agent.localStatus,
      relayOnline: false,
      sessions: 0,
      phones: [],
      connected: [],
    });
    expect(await control.controlRequest(f.path, "devices")).toEqual([]);
    expect(await control.controlRequest(f.path, "unpair", { target: phoneFp })).toEqual({
      removed: false,
    });
    let qrText: string | undefined;
    const errors: Error[] = [];
    const legacy = control.controlPairSession(f.path, {
      onOpen: (qr) => {
        qrText = qr;
      },
      onRequest: async () => false,
      onClose: () => {},
      onError: (error) => errors.push(error),
    });
    cleanup.push(() => legacy.close());
    await vi.waitFor(() => expect(qrText).toBeTypeOf("string"));
    const client = await control.connectControlV2(f.path);
    cleanup.push(() => client.close());
    await expect(client.openPairing()).rejects.toMatchObject({
      code: "server-error",
      serverCode: "pairing-busy",
    });
    const request = f.agent.pairing.handleRequest(encryptedRequest(qrText!));
    await request;
    expect(f.agent.pairingList).toEqual([]);
    await control.controlRequest(f.path, "pair-close");
    legacy.close();
    await vi.waitFor(() => expect(f.agent.pairingOpen).toBe(false));
    const opened = await client.openPairing();
    await client.closePairing(opened.flowId);
    expect(errors).toEqual([]);
  });
});
