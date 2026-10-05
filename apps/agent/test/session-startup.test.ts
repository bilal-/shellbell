import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import type { HerdrClient } from "../src/backends/herdr/client.js";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  herdrServerLauncher,
  macApplicationLauncher,
  waitForBackend,
} from "../src/backends/session-startup.js";
import type { TerminalBackend } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: false });
function fakeBackend() {
  let id = 1;
  return {
    name: "tmux" as const,
    isConnected: false,
    capabilities: {
      subscribe: true,
      prompts: false,
      createSession: true,
      focus: false,
      history: false,
      absoluteLines: false,
    },
    on: () => () => undefined,
    createSession: vi.fn(async () => `%${++id}`),
    close: vi.fn(async () => undefined),
  };
}

describe("explicit terminal startup", () => {
  afterEach(() => vi.useRealTimers());

  it("advertises startup separately and starts a cold backend once for concurrent creation requests", async () => {
    const registry = new BackendRegistry(log);
    const backend = fakeBackend();
    registry.add(backend as unknown as TerminalBackend);
    let ready!: (result: { backend: TerminalBackend; sessionId: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ backend: TerminalBackend; sessionId: string }>((resolve) => {
          ready = resolve;
        }),
    );
    registry.registerSessionLauncher("tmux", { available: () => true, start });
    expect(registry.connected()).toEqual([]);
    expect(registry.launchable()).toEqual(["tmux"]);
    expect(registry.capabilities.subscribe).toBe(false);
    expect(registry.capabilities.createSession).toBe(true);
    const first = registry.createSession({ kind: "tab", backend: "tmux" });
    const second = registry.createSession({ kind: "tab", backend: "tmux" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    backend.isConnected = true;
    ready({ backend: backend as unknown as TerminalBackend, sessionId: "%1" });
    expect(await Promise.all([first, second])).toEqual(["tmux:%1", "tmux:%2"]);
    expect(backend.createSession).toHaveBeenCalledOnce();
    expect(registry.launchable()).toEqual([]);
  });

  it("bounds callers waiting for a startup and retires a removed launcher's result", async () => {
    const registry = new BackendRegistry(log);
    const backend = fakeBackend();
    registry.add(backend as unknown as TerminalBackend);
    let ready!: (result: { backend: TerminalBackend }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ backend: TerminalBackend }>((resolve) => {
          ready = resolve;
        }),
    );
    const remove = registry.registerSessionLauncher("tmux", { available: () => true, start });
    const pending = Array.from({ length: 8 }, () =>
      registry.createSession({ kind: "tab", backend: "tmux" }),
    );
    const settled = Promise.allSettled(pending);
    await expect(registry.createSession({ kind: "tab", backend: "tmux" })).rejects.toThrow(
      "startup is busy",
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    remove();
    backend.isConnected = true;
    ready({ backend: backend as unknown as TerminalBackend });
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("never substitutes a new terminal for an existing window whose backend is gone", async () => {
    const registry = new BackendRegistry(log);
    const start = vi.fn();
    registry.registerSessionLauncher("tmux", { available: () => true, start });
    await expect(
      registry.createSession({ kind: "tab", backend: "tmux", windowId: "tmux:$1" }),
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it("launches an installed iTerm application in the background using fixed executable arguments", async () => {
    const execute = vi.fn(async () => undefined);
    const launcher = macApplicationLauncher("iterm2", {
      platform: "darwin",
      roots: ["/test/apps"],
      exists: (path) => path === "/test/apps/iTerm.app",
      execute,
    });
    expect(launcher?.available()).toBe(true);
    await launcher?.start();
    expect(execute).toHaveBeenCalledWith("/usr/bin/open", ["-g", "-a", "/test/apps/iTerm.app"]);
    expect(macApplicationLauncher("iterm2", { platform: "linux" })).toBeNull();
  });

  it("starts Herdr as a detached headless server, leaving its terminal lifecycle independent", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const launcher = herdrServerLauncher({
      env: { PATH: "/test/bin" },
      executable: (path) => path === "/test/bin/herdr",
      spawnImpl: spawnImpl as unknown as typeof spawn,
    });
    expect(launcher.available()).toBe(true);
    await launcher.start();
    expect(spawnImpl).toHaveBeenCalledWith("/test/bin/herdr", ["server"], {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/test/bin" },
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("waits for a backend event and cleans up a failed readiness deadline", async () => {
    const registry = new BackendRegistry(log);
    const ready = waitForBackend(registry, "tmux");
    const backend = fakeBackend();
    backend.isConnected = true;
    registry.add(backend as unknown as TerminalBackend);
    await ready;
    vi.useFakeTimers();
    const remove = vi.fn();
    const unavailable = waitForBackend({ connected: () => [], on: () => remove }, "iterm2", 50);
    const rejected = expect(unavailable).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(remove).toHaveBeenCalledOnce();
  });

  it("creates Herdr's first workspace and returns its root terminal when no workspace exists", async () => {
    const request = vi.fn(async () => ({ root_pane: { terminal_id: "first-terminal" } }));
    const backend = new HerdrBackend({ client: { request } as unknown as HerdrClient, log });
    expect(await backend.createSession({ kind: "tab", backend: "herdr" })).toBe("first-terminal");
    expect(request).toHaveBeenCalledWith("workspace.create", { cwd: homedir(), focus: false });
    expect(request).toHaveBeenCalledOnce();
  });
});
