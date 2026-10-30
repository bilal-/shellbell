import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import type { HerdrClient } from "../src/backends/herdr/client.js";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  herdrServerLauncher,
  macApplicationInstalled,
  macApplicationLauncher,
  waitForBackend,
} from "../src/backends/session-startup.js";
import type { TerminalBackend } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: false });
// iTerm2 is the engine whose own new tabs are desktop windows, so a cold start may create one
// directly; tmux and Herdr cold starts go through a desktop window host instead.
function fakeBackend() {
  let id = 1;
  return {
    name: "iterm2" as const,
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
    registry.registerSessionLauncher("iterm2", { available: () => true, start });
    expect(registry.connected()).toEqual([]);
    expect(registry.launchable()).toEqual(["iterm2"]);
    expect(registry.capabilities.subscribe).toBe(false);
    expect(registry.capabilities.createSession).toBe(true);
    const first = registry.createSession({ kind: "tab", backend: "iterm2" });
    const second = registry.createSession({ kind: "tab", backend: "iterm2" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    backend.isConnected = true;
    ready({ backend: backend as unknown as TerminalBackend, sessionId: "%1" });
    expect(await Promise.all([first, second])).toEqual(["iterm2:%1", "iterm2:%2"]);
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
    const remove = registry.registerSessionLauncher("iterm2", { available: () => true, start });
    const pending = Array.from({ length: 8 }, () =>
      registry.createSession({ kind: "tab", backend: "iterm2" }),
    );
    const settled = Promise.allSettled(pending);
    await expect(registry.createSession({ kind: "tab", backend: "iterm2" })).rejects.toThrow(
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
    const ready = waitForBackend(registry, "iterm2");
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

describe("whether a Mac application is installed anywhere", () => {
  const spotlight = (found: string, indexing = "Indexing enabled.") =>
    vi.fn(async (file: string) => ({
      stdout: file === "/usr/bin/mdfind" ? found : `/:\n\t${indexing}\n`,
    }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("answers from the usual folders without asking Spotlight", () => {
    const execute = spotlight("");
    expect(macApplicationInstalled("com.example.app", () => true, { execute })()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("finds an app outside the usual folders, and says it changed", async () => {
    const execute = spotlight("/Volumes/Tools/iTerm.app\n");
    const onChange = vi.fn();
    const installed = macApplicationInstalled("com.googlecode.iterm2", () => false, {
      execute,
      exists: (path) => path === "/Volumes/Tools/iTerm.app",
      onChange,
    });
    expect(installed()).toBeUndefined();
    await settle();
    expect(installed()).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("/usr/bin/mdfind", [
      "kMDItemCFBundleIdentifier == 'com.googlecode.iterm2'",
    ]);
  });

  it("counts an app as missing only when Spotlight is indexing and finds nothing", async () => {
    for (const [execute, expected] of [
      [spotlight(""), false],
      [spotlight("", "Indexing disabled."), undefined],
      [spotlight("/gone/iTerm.app\n"), false],
      [
        vi.fn(async () => {
          throw new Error("no Spotlight");
        }),
        undefined,
      ],
    ] as const) {
      const installed = macApplicationInstalled("com.example.app", () => false, {
        execute,
        exists: () => false,
      });
      installed();
      await settle();
      expect(installed()).toBe(expected);
    }
  });

  it("asks Spotlight at most once a minute", async () => {
    let clock = 0;
    const execute = spotlight("");
    const installed = macApplicationInstalled("com.example.app", () => false, {
      execute,
      now: () => clock,
    });
    installed();
    await settle();
    installed();
    clock = 59_000;
    installed();
    expect(execute.mock.calls.filter(([file]) => file === "/usr/bin/mdfind")).toHaveLength(1);
    clock = 60_000;
    installed();
    await settle();
    expect(execute.mock.calls.filter(([file]) => file === "/usr/bin/mdfind")).toHaveLength(2);
  });
});
