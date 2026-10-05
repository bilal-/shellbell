import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHerdr, startHerdrBackend } from "../src/backends/herdr/start.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { createLogger, type Logger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let server: FakeHerdr | null = null;
let handle: { stop(): void } | null = null;

afterEach(async () => {
  handle?.stop();
  handle = null;
  await server?.stop();
  server = null;
});

const emptySnapshot = () => ({
  type: "session_snapshot",
  snapshot: {
    version: "0.8.2",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
  },
});

describe("checkHerdr", () => {
  it("reports the version and protocol when herdr answers", async () => {
    server = new FakeHerdr();
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    expect(await checkHerdr({ log, socketPath: server.path })).toEqual({
      name: "herdr",
      ok: true,
      detail: "v0.8.2 protocol 20",
    });
  });

  it("PASSES when herdr is not installed at all (it is optional)", async () => {
    //: `doctor` exits 1 if any check fails, and most users have no herdr.
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-doctor-"));
    const check = await checkHerdr({
      log,
      socketPath: join(dir, "herdr.sock"),
      herdrOnPath: () => false,
    });
    expect(check).toEqual({ name: "herdr", ok: true, detail: "not installed (optional)" });
  });

  it("says herdr is installed but not running when the binary exists and the socket does not", async () => {
    // Herdr only creates its socket while it is running, so an installed-but-stopped herdr looks
    // exactly like a missing one at the socket. Reporting "not installed" to someone who has it
    // installed sends them to reinstall something they already have.
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-doctor-"));
    const check = await checkHerdr({
      log,
      socketPath: join(dir, "herdr.sock"),
      herdrOnPath: () => true,
    });
    expect(check).toEqual({
      name: "herdr",
      ok: true,
      detail: "installed but not running (optional)",
    });
  });

  it("FAILS when a running herdr is too old, with the upgrade fix", async () => {
    server = new FakeHerdr();
    server.reply("ping", () => ({ type: "pong", version: "0.6.9", protocol: 22 }));
    await server.start();
    const check = await checkHerdr({ log, socketPath: server.path });
    expect(check.ok).toBe(false);
    expect(check.fix).toMatch(/0\.7\.2/);
  });

  it("FAILS when a running herdr has no session.snapshot", async () => {
    server = new FakeHerdr();
    server.fail("session.snapshot", "invalid_request", "unknown method");
    await server.start();
    const check = await checkHerdr({ log, socketPath: server.path });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/session\.snapshot/);
  });
});

describe("startHerdrBackend", () => {
  it("registers the backend BEFORE connecting, then keeps retrying until herdr appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-"));
    const socketPath = join(dir, "herdr.sock");
    const registry = new BackendRegistry(log);
    handle = startHerdrBackend({
      registry,
      log,
      socketPath,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, syncDebounceMs: 60_000 },
    });
    //: the member is registered immediately, so the agent is subscribed to
    // its events before `connect()` can emit any -- but it is NOT advertised while it is down.
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.connected()).toEqual([]);
    expect(registry.nameOf("herdr:x")).toBe("herdr");

    server = new FakeHerdr(socketPath);
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    await waitFor(() => registry.connected().some((b) => b.name === "herdr"), 3000);
    expect(registry.connected().find((b) => b.name === "herdr")?.capabilities.prompts).toBe(false);
  });

  it("stop() unregisters the backend, not just closes it (Minor, Task 6 review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-"));
    const socketPath = join(dir, "herdr.sock");
    const registry = new BackendRegistry(log);
    handle = startHerdrBackend({
      registry,
      log,
      socketPath,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, syncDebounceMs: 60_000 },
    });
    server = new FakeHerdr(socketPath);
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    await waitFor(() => registry.connected().some((b) => b.name === "herdr"), 3000);
    expect(registry.capabilitiesOf("herdr:x")).not.toBeNull();

    handle.stop();
    handle = null;
    // A long-lived host must not keep a dead member registered forever. `nameOf` is a pure prefix
    // parse against the protocol schema and stays "herdr" regardless of registration (by design --
    // it is what lets `setWatched`/`splitId` route to a name the schema knows about even before a
    // backend for it exists); `capabilitiesOf` is the member-registration-sensitive lookup and must
    // go back to null once `stop()` has actually unregistered the member.
    expect(registry.capabilitiesOf("herdr:x")).toBeNull();
    expect(registry.connected()).toEqual([]);
  });

  it("calls onUnavailable exactly once on the first failed attempt, then onConnected once it appears (Minor, Task 6 review: CLI banner resolution)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-"));
    const socketPath = join(dir, "herdr.sock");
    const registry = new BackendRegistry(log);
    let unavailableCalls = 0;
    let connectedPanes: number | null = null;
    handle = startHerdrBackend({
      registry,
      log,
      socketPath,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, syncDebounceMs: 60_000 },
      onUnavailable: () => {
        unavailableCalls += 1;
      },
      onConnected: (n) => {
        connectedPanes = n;
      },
    });
    // A few retry rounds while herdr is absent: onUnavailable must fire exactly once, not once
    // per retry, so the CLI's banner line is painted once rather than repeated forever.
    await new Promise((r) => setTimeout(r, 80));
    expect(unavailableCalls).toBe(1);
    expect(connectedPanes).toBeNull();

    server = new FakeHerdr(socketPath);
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    // Wait on the callback, not the registry: the registry flips to connected the moment
    // `backend.connect()` resolves, while `onConnected` fires a `listSessions()` round-trip later,
    // so waiting on the registry races the thing this test is actually asserting (it failed that
    // way on CI 2026-09-07 -- "expected null to be +0").
    await waitFor(() => connectedPanes !== null, 3000);
    expect(registry.connected().some((b) => b.name === "herdr")).toBe(true);
    expect(connectedPanes).toBe(0);
    expect(unavailableCalls).toBe(1); // still exactly once -- success does not retroactively fire it
  });

  it("logs the error NAME, never the message, when herdr cannot be reached (M-1)", async () => {
    // No FakeHerdr is ever started: `client.ping()` fails with `BackendUnavailable`, whose message
    // embeds both herdr's own error text and this socket path (which carries the OS username).
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-m1-"));
    const socketPath = join(dir, "herdr.sock");
    const registry = new BackendRegistry(log);
    const calls: { msg: string; fields?: Record<string, unknown> }[] = [];
    const captureLog: Logger = {
      debug: (msg, fields) => calls.push({ msg, fields }),
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => captureLog,
    };
    handle = startHerdrBackend({
      registry,
      log: captureLog,
      socketPath,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, syncDebounceMs: 60_000 },
    });
    await waitFor(() => calls.some((c) => c.msg === "herdr not available"));
    const call = calls.find((c) => c.msg === "herdr not available");
    expect(call?.fields).toEqual({ error: "BackendUnavailable" });
    expect(JSON.stringify(call?.fields)).not.toContain(socketPath);
  });

  it(
    "guards everything after connect(): a throwing onConnected is logged, never an unhandled " +
      "rejection, and never re-triggers a retry (M-5)",
    async () => {
      const rejections: unknown[] = [];
      const onRejection = (err: unknown) => rejections.push(err);
      process.on("unhandledRejection", onRejection);
      try {
        const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-m5-"));
        const socketPath = join(dir, "herdr.sock");
        const registry = new BackendRegistry(log);
        handle = startHerdrBackend({
          registry,
          log,
          socketPath,
          retryMs: 20,
          backendOptions: { reconnectMs: 60_000, syncDebounceMs: 60_000 },
          onConnected: () => {
            throw new Error("CLI banner print blew up");
          },
        });
        server = new FakeHerdr(socketPath);
        server.reply("session.snapshot", emptySnapshot);
        await server.start();
        await waitFor(() => registry.connected().some((b) => b.name === "herdr"), 3000);
        // Let any unhandled rejection surface, and give a (wrongly re-armed) retry time to fire.
        await new Promise((r) => setTimeout(r, 80));
        expect(rejections).toHaveLength(0);
        // Still connected -- the throw in onConnected must not have looked like a failed attempt.
        expect(registry.connected().some((b) => b.name === "herdr")).toBe(true);
      } finally {
        process.removeListener("unhandledRejection", onRejection);
      }
    },
  );
});
