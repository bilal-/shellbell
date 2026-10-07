import { InnerMessageSchema } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  PluginBackend,
  startTerminalPlugins,
  type TerminalAdapterPlugin,
} from "../src/backends/plugin.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });
function plugin(raw = new FakeBackend("example")): TerminalAdapterPlugin {
  return {
    apiVersion: 1,
    id: "example",
    label: "Example Terminal",
    platforms: ["darwin", "linux"],
    create: () => raw,
  };
}
describe("locally installed terminal adapters", () => {
  it("does not offer or invoke cold session startup for a read-only adapter", async () => {
    const registry = new BackendRegistry(log);
    const raw = new FakeBackend("example");
    raw.capabilities.createSession = false;
    raw.isConnected = false;
    raw.connect = async () => {
      if (!raw.isConnected) throw new Error("not running");
    };
    raw.createSession = async () => {
      throw new Error("session creation unsupported");
    };
    const launch = vi.fn(async () => {
      raw.isConnected = true;
    });
    const handle = startTerminalPlugins({
      paths: ["/adapter.mjs"],
      registry,
      log,
      admitPath: () => {},
      importModule: async () => ({ default: plugin(Object.assign(raw, { launch })) }),
    });
    try {
      await handle.ready;
      expect(registry.catalog().find((entry) => entry.name === "example")?.launchable).toBe(false);
      expect(registry.launchable()).not.toContain("example");
      await expect(registry.createSession({ kind: "tab", backend: "example" })).rejects.toThrow();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      handle.stop();
      await registry.close();
    }
  });
  it.each(["windowId", "tabId"] as const)(
    "isolates a plugin whose %s exceeds the prefixed wire bound",
    async (field) => {
      const raw = new FakeBackend("example");
      raw.addSession("pane", {});
      const sessions = await raw.listSessions();
      raw.listSessions = async () =>
        sessions.map((session) => ({ ...session, [field]: "x".repeat(128) }));
      const backend = new PluginBackend(raw, "example", new AbortController());
      const registry = new BackendRegistry(log);
      const healthy = new FakeBackend();
      healthy.addSession("healthy", {});
      registry.add(healthy);
      await backend.connect();
      registry.add(backend);
      try {
        await expect(backend.listSessions()).rejects.toThrow(/identities/);
        const list = await registry.listSessions();
        expect(list.map((session) => session.id)).toEqual(["iterm2:healthy"]);
        expect(InnerMessageSchema.safeParse({ type: "sessions", list }).success).toBe(true);
      } finally {
        await registry.close();
      }
    },
  );
  it("loads an enabled plugin, discovers its session and retires its event subscription", async () => {
    const registry = new BackendRegistry(log);
    const raw = new FakeBackend("example");
    raw.addSession("pane", {});
    const handle = startTerminalPlugins({
      paths: ["/adapters/example.mjs"],
      registry,
      log,
      platform: "linux",
      admitPath: () => {},
      importModule: async () => ({ default: plugin(raw) }),
    });
    try {
      await handle.ready;
      await vi.waitFor(() =>
        expect(registry.connected().map((entry) => entry.name)).toContain("example"),
      );
      expect((await registry.listSessions()).map((session) => session.id)).toEqual([
        "example:pane",
      ]);
      expect(registry.catalog().find((entry) => entry.name === "example")?.label).toBe(
        "Example Terminal",
      );
      const seen = vi.fn();
      registry.on(seen);
      raw.emit({ type: "screen-changed", sessionId: "pane" });
      expect(seen).toHaveBeenCalledWith({ type: "screen-changed", sessionId: "example:pane" });
      handle.stop();
      seen.mockClear();
      raw.emit({ type: "screen-changed", sessionId: "pane" });
      expect(seen).not.toHaveBeenCalled();
      expect(registry.connected()).toEqual([]);
    } finally {
      handle.stop();
    }
  });
  it("never imports a rejected entry point or silently replaces a built-in adapter", async () => {
    const registry = new BackendRegistry(log);
    const iterm = new FakeBackend();
    registry.add(iterm);
    const importer = vi.fn(async () => ({ default: { ...plugin(), id: "iterm2" } }));
    const rejected = startTerminalPlugins({
      paths: ["/untrusted.mjs"],
      registry,
      log,
      admitPath: () => {
        throw new Error("unsafe");
      },
      importModule: importer,
    });
    await rejected.ready;
    expect(importer).not.toHaveBeenCalled();
    rejected.stop();
    const reserved = startTerminalPlugins({
      paths: ["/adapters/reserved.mjs"],
      registry,
      log,
      admitPath: () => {},
      importModule: importer,
    });
    await reserved.ready;
    expect(registry.member("iterm2")).toBe(iterm);
    reserved.stop();
  });
  it("skips an adapter for another platform without running its factory", async () => {
    const definition = { ...plugin(), platforms: ["darwin"], create: vi.fn() };
    const handle = startTerminalPlugins({
      paths: ["/adapter.mjs"],
      registry: new BackendRegistry(log),
      log,
      platform: "linux",
      admitPath: () => {},
      importModule: async () => ({ default: definition }),
    });
    await handle.ready;
    expect(definition.create).not.toHaveBeenCalled();
    handle.stop();
  });
  it("refuses manifest impersonation and capabilities without a native implementation", () => {
    expect(
      () => new PluginBackend(new FakeBackend("other"), "example", new AbortController()),
    ).toThrow(/identity/);
    const raw = new FakeBackend("example");
    raw.capabilities.terminalInput = true;
    expect(() => new PluginBackend(raw, "example", new AbortController())).toThrow(
      /implementation/,
    );
  });
  it("rejects malformed screen dimensions and cross-adapter session identities", async () => {
    const raw = new FakeBackend("example");
    raw.addSession("pane", {});
    const backend = new PluginBackend(raw, "example", new AbortController());
    await backend.connect();
    raw.getScreen = async () => ({
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0 },
      lines: [],
      scrollbackTotal: 0,
    });
    await expect(backend.getScreen("pane")).rejects.toThrow(/viewport/);
    raw.listSessions = async () => [{ id: "pane", backend: "iterm2" } as never];
    await expect(backend.listSessions()).rejects.toThrow();
    await backend.close();
  });
  it("fences timed-out native replies and does not reconnect while the operation is still running", async () => {
    const raw = new FakeBackend("example");
    raw.addSession("pane", {});
    let finish!: (value: Awaited<ReturnType<typeof raw.listSessions>>) => void;
    const result = await raw.listSessions();
    raw.listSessions = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const backend = new PluginBackend(raw, "example", new AbortController(), 10);
    await backend.connect();
    await expect(backend.listSessions()).rejects.toThrow(/deadline/);
    expect(backend.isConnected).toBe(false);
    await expect(backend.connect()).rejects.toThrow(/unavailable/);
    finish(result);
    await vi.waitFor(async () => {
      await backend.connect();
      expect(backend.isConnected).toBe(true);
    });
    await backend.close();
  });
  it("does not enter a scheduled mutation after the adapter is closed", async () => {
    const raw = new FakeBackend("example");
    const backend = new PluginBackend(raw, "example", new AbortController());
    await backend.connect();
    const send = backend.sendText("pane", "must not be sent");
    const close = backend.close();
    await expect(send).rejects.toThrow(/retired/);
    await close;
    expect(raw.sentText).toEqual([]);
  });
  it("closes a factory result that arrives after startup was cancelled", async () => {
    const registry = new BackendRegistry(log);
    const raw = new FakeBackend("example");
    const close = vi.spyOn(raw, "close");
    let finish!: (value: FakeBackend) => void;
    const handle = startTerminalPlugins({
      paths: ["/adapter.mjs"],
      registry,
      log,
      admitPath: () => {},
      importModule: async () => ({
        default: {
          ...plugin(),
          create: () =>
            new Promise<FakeBackend>((resolve) => {
              finish = resolve;
            }),
        },
      }),
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    handle.stop();
    finish(raw);
    await handle.ready;
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(registry.member("example")).toBeUndefined();
  });
});
