import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findHerdrExecutable } from "../src/backends/herdr/executable.js";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  findTerminalExecutable,
  ghosttyWindowLauncher,
  terminalCommandLine,
} from "../src/backends/terminal-launch.js";
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
      "-g",
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
  it("routes a cold hosted request through engine startup and reuses exactly its first session", async () => {
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
    expect(await registry.createSession({ kind: "tab", backend: "tmux", host: "ghostty" })).toBe(
      "tmux:%1",
    );
    expect(start).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(backend, "%1");
    expect(await registry.createSession({ kind: "tab", backend: "tmux", host: "ghostty" })).toBe(
      "tmux:%2",
    );
    expect(start).toHaveBeenCalledOnce();
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
