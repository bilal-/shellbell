import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findTerminalExecutable } from "../src/backends/executable.js";
import { findHerdrExecutable } from "../src/backends/herdr/executable.js";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  ghosttyWindowLauncher,
  openOrDiscard,
  terminalCommandLine,
} from "../src/backends/terminal-launch.js";
import { NotShownOnComputer } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

describe("terminal window launchers", () => {
  it("skips executable directories when resolving the actual attach program", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-attach-path-"));
    const first = join(root, "a"),
      second = join(root, "b");
    try {
      mkdirSync(join(first, "tmux"), { recursive: true });
      mkdirSync(second);
      writeFileSync(join(second, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      expect(findTerminalExecutable("tmux", { PATH: `${first}:${second}` })).toBe(
        join(second, "tmux"),
      );
      expect(findTerminalExecutable("tmux", { PATH: relative(process.cwd(), second) })).toBe(
        join(second, "tmux"),
      );
      const local = resolve("herdr");
      expect(findHerdrExecutable({ PATH: ":/unused" }, (path) => path === local)).toBe(local);
      expect(findTerminalExecutable("herdr", { PATH: ":/unused" }, (path) => path === local)).toBe(
        local,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds per-user installs that the service's fixed PATH omits", () => {
    const env = { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/someone" };
    expect(findHerdrExecutable(env, (path) => path === "/Users/someone/.local/bin/herdr")).toBe(
      "/Users/someone/.local/bin/herdr",
    );
    expect(
      findTerminalExecutable("tmux", env, (path) => path === "/Users/someone/.cargo/bin/tmux"),
    ).toBe("/Users/someone/.cargo/bin/tmux");
    expect(
      findHerdrExecutable(env, (path) =>
        ["/usr/bin/herdr", "/Users/someone/.local/bin/herdr"].includes(path),
      ),
    ).toBe("/usr/bin/herdr");
  });
  it("launches Ghostty when no window or application is open, with fixed native arguments", async () => {
    const execute = vi.fn(async () => {});
    const launcher = ghosttyWindowLauncher({
      platform: "darwin",
      roots: ["/apps"],
      exists: () => true,
      execute,
    })!;
    expect(launcher.available()).toBe(true);
    await launcher.launch({ executable: "/tools/tmux", args: ["attach-session", "-t", "$12"] });
    expect(execute).toHaveBeenCalledWith("/usr/bin/open", [
      "-n",
      "-a",
      "/apps/Ghostty.app",
      "--args",
      "--initial-window=true",
      "--window-save-state=never",
      "--quit-after-last-window-closed=true",
      "--initial-command='/tools/tmux' 'attach-session' '-t' '$12'",
    ]);
    expect(ghosttyWindowLauncher({ platform: "linux" })).toBeNull();
  });
  it("passes paired cell dimensions only to the newly launched Ghostty instance", async () => {
    const execute = vi.fn(async () => {});
    const launcher = ghosttyWindowLauncher({
      platform: "darwin",
      roots: ["/apps"],
      exists: () => true,
      execute,
    })!;
    await launcher.launch({
      executable: "/tools/herdr",
      args: ["terminal", "attach", "new-terminal"],
      initialSize: { cols: 54, rows: 38 },
    });
    expect(execute.mock.calls[0]).toEqual([
      "/usr/bin/open",
      expect.arrayContaining(["-n", "--window-width=54", "--window-height=38"]),
    ]);
    execute.mockClear();
    await expect(
      launcher.launch({ executable: "/tools/herdr", args: [], initialSize: { cols: 1, rows: 1 } }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not launch missing applications and keeps local command words literal", async () => {
    const execute = vi.fn(async () => {});
    const launcher = ghosttyWindowLauncher({ platform: "darwin", exists: () => false, execute })!;
    await expect(launcher.launch({ executable: "/tools/tmux", args: [] })).rejects.toThrow(
      /not installed/,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(
      terminalCommandLine({ executable: "/tools/a'b", args: ["$(touch /tmp/no)", "$12"] }),
    ).toBe("'/tools/a'\\''b' '$(touch /tmp/no)' '$12'");
    expect(() => terminalCommandLine({ executable: "tmux", args: [] })).toThrow();
    expect(() =>
      terminalCommandLine({
        executable: "/tools/tmux",
        args: [],
        environment: { DATA: "a".repeat(8192) },
      }),
    ).toThrow(/large/);
    expect(() => terminalCommandLine({ executable: "/tools/tmux", args: ["bad\nword"] })).toThrow();
    expect(
      terminalCommandLine({
        executable: "/tools/herdr",
        args: ["terminal", "attach", "term_one"],
        environment: { HERDR_SOCKET_PATH: "/private/path with spaces/server.sock" },
      }),
    ).toContain("'HERDR_SOCKET_PATH=/private/path with spaces/server.sock'");
    expect(
      findTerminalExecutable("tmux", { PATH: ".:/bin:/tools" }, (path) => path === "/tools/tmux"),
    ).toBe("/tools/tmux");
  });
  it.each([undefined, { cols: 54, rows: 40 }])(
    "routes a cold hosted request through engine startup with size %j and reuses exactly its first session",
    async (initialSize) => {
      const registry = new BackendRegistry(createLogger({ stdout: false }));
      const backend = new FakeBackend("tmux");
      Object.defineProperty(backend, "isConnected", { value: false, writable: true });
      registry.add(backend);
      const start = vi.fn(async () => {
        Object.defineProperty(backend, "isConnected", { value: true, writable: true });
        return { backend, sessionId: "%1" };
      });
      registry.registerSessionLauncher("tmux", { available: () => true, start });
      const create = vi.fn(async (_backend, firstId) => firstId ?? "%2");
      registry.registerHostedLauncher(
        { backend: "tmux", host: "ghostty", label: "Ghostty" },
        { available: () => true, create },
      );
      expect(registry.launchTargets()).toEqual([
        { backend: "tmux", host: "ghostty", label: "Ghostty" },
      ]);
      expect(
        await registry.createSession({
          kind: "tab",
          backend: "tmux",
          host: "ghostty",
          ...(initialSize ? { initialSize } : {}),
        }),
      ).toBe("tmux:%1");
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]).toEqual(initialSize ? [initialSize] : []);
      expect(create.mock.calls.at(-1)).toEqual(
        initialSize ? [backend, "%1", initialSize] : [backend, "%1"],
      );
      expect(await registry.createSession({ kind: "tab", backend: "tmux", host: "ghostty" })).toBe(
        "tmux:%2",
      );
      expect(start).toHaveBeenCalledOnce();
      await registry.close();
    },
  );
  it("keeps different phone grids owned by their coalesced startup requests", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend("tmux");
    Object.defineProperty(backend, "isConnected", { value: false, writable: true });
    registry.add(backend);
    let ready!: (result: { backend: typeof backend; sessionId: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ backend: typeof backend; sessionId: string }>((resolve) => {
          ready = resolve;
        }),
    );
    const create = vi.fn(async (_backend, firstId) => firstId ?? "%2");
    registry.registerSessionLauncher("tmux", { available: () => true, start });
    registry.registerHostedLauncher(
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { available: () => true, create },
    );
    const firstSize = { cols: 54, rows: 40 };
    const secondSize = { cols: 100, rows: 60 };
    const first = registry.createSession({
      kind: "tab",
      backend: "tmux",
      host: "ghostty",
      initialSize: firstSize,
    });
    const second = registry.createSession({
      kind: "tab",
      backend: "tmux",
      host: "ghostty",
      initialSize: secondSize,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(firstSize));
    Object.defineProperty(backend, "isConnected", { value: true, writable: true });
    ready({ backend, sessionId: "%1" });
    expect(await Promise.all([first, second])).toEqual(["tmux:%1", "tmux:%2"]);
    expect(create.mock.calls).toEqual([
      [backend, "%1", firstSize],
      [backend, undefined, secondSize],
    ]);
    await registry.close();
  });

  it("refuses unregistered hosts and existing-window host requests before any creation", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend("tmux");
    registry.add(backend);
    const nativeCreate = vi.spyOn(backend, "createSession");
    const create = vi.fn(async () => "%1");
    await expect(
      registry.createSession({ kind: "tab", backend: "tmux", host: "remote-command" }),
    ).rejects.toThrow(/unavailable/);
    registry.registerHostedLauncher(
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { available: () => true, create },
    );
    await expect(
      registry.createSession({
        kind: "tab",
        backend: "tmux",
        host: "ghostty",
        windowId: "tmux:$0",
      }),
    ).rejects.toThrow(/unavailable/);
    expect(create).not.toHaveBeenCalled();
    expect(nativeCreate).not.toHaveBeenCalled();
    await registry.close();
  });
});

describe("opening a new session's desktop window", () => {
  it("leaves a session alone once its window opened", async () => {
    const discard = vi.fn(async () => {});
    await openOrDiscard(async () => {}, discard);
    expect(discard).not.toHaveBeenCalled();
  });

  it("closes the new session when its window cannot open, then reports that", async () => {
    const discard = vi.fn(async () => {});
    const failed = openOrDiscard(async () => {
      throw new Error("Ghostty could not be launched");
    }, discard);
    await expect(failed).rejects.toBeInstanceOf(NotShownOnComputer);
    await expect(failed).rejects.toThrow("so the new session was closed");
    expect(discard).toHaveBeenCalledOnce();
  });

  it("says so when the unopened session could not be closed either", async () => {
    await expect(
      openOrDiscard(
        async () => {
          throw new Error("no window");
        },
        async () => {
          throw new Error("no tmux");
        },
      ),
    ).rejects.toThrow("could not be closed");
  });
});
