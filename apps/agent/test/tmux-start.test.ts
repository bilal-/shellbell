import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { startTmuxBackend } from "../src/backends/tmux/start.js";
import { createLogger, type Logger } from "../src/log.js";
import { waitFor } from "./fakes/wait.js";

/** pid 60 is a tmux client in a Ghostty window. */
const GHOSTTY_CLIENT = new Map([
  [60, { ppid: 61, args: "tmux attach" }],
  [61, { ppid: 1, args: "/Applications/Ghostty.app/Contents/MacOS/ghostty" }],
]);

/** Minimal fake control client, same shape as `tmux-backend.test.ts`'s `FakeControl`: one pane,
 * no real tmux anywhere in this file. */
class FakeControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  alive = true;
  constructor(readonly sessionId: string) {
    super();
  }
  async start(): Promise<void> {}
  stop(): void {
    this.alive = false;
  }
  async command(line: string): Promise<string[]> {
    if (line.startsWith("list-panes")) {
      return [
        [
          "%1",
          "$0",
          "main",
          "@0",
          "0",
          "zsh",
          "0",
          "host",
          "/tmp",
          "10",
          "3",
          "1",
          "1",
          "3",
          "0",
          "2",
          "0",
          "zsh",
        ].join("\t"),
      ];
    }
    if (line.startsWith("list-clients")) return ["$0\t1"];
    if (line.startsWith("display-message")) return ["4\t1\t3\t10\t3"];
    if (line.startsWith("capture-pane")) return ["hello", "world", ""];
    throw new Error(`unexpected ${line.split(" ")[0]}`);
  }
}

const log = createLogger({ stdout: false });
let handle: { stop(): void } | null = null;

afterEach(() => {
  handle?.stop();
  handle = null;
});

describe("startTmuxBackend", () => {
  it("registers launchers later when their first detection failed after tmux connected", async () => {
    const registry = new BackendRegistry(log);
    let versionChecks = 0;
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 20,
      terminalExecutable: () => "/tools/tmux",
      terminalWindows: [
        { id: "ghostty", label: "Ghostty", available: () => true, launch: async () => {} },
      ],
      backendOptions: {
        controlFactory: (id) => new FakeControl(id) as unknown as TmuxControl,
        execImpl: async (args) => {
          if (args[0] === "-V") {
            // The launchers' own check is slow and fails; the backend's check succeeds first.
            if (++versionChecks === 1)
              return new Promise((_, reject) => setTimeout(() => reject(new Error("busy")), 50));
            return "tmux 3.4\n";
          }
          if (args[0] === "list-sessions") return "$0\n";
          if (args[0] === "list-clients") return "";
          throw new Error("unexpected tmux command");
        },
      },
    });
    await waitFor(() => registry.connected().some((backend) => backend.name === "tmux"), 3000);
    await waitFor(() => registry.launchTargets().length === 1, 3000);
    // The launchers' failed check, the backend's, then the launchers' retry.
    expect(versionChecks).toBe(3);
  });

  it("offers new tmux windows once tmux is installed while the service runs", async () => {
    const registry = new BackendRegistry(log);
    let installed = false;
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 20,
      terminalExecutable: () => (installed ? "/Users/example/.local/bin/tmux" : undefined),
      terminalWindows: [
        { id: "ghostty", label: "Ghostty", available: () => true, launch: async () => {} },
      ],
      backendOptions: {
        controlFactory: (id) => new FakeControl(id) as unknown as TmuxControl,
        execImpl: async (args) => {
          if (!installed) throw new Error("tmux not found");
          if (args[0] === "-V") return "tmux 3.4\n";
          if (args[0] === "list-sessions") throw new Error("no server running");
          throw new Error("unexpected tmux command");
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(registry.launchTargets()).toEqual([]);
    installed = true;
    await waitFor(() => registry.launchTargets().length === 1, 3000);
  });

  it("starts from no tmux server and opens exactly the first pane in the selected terminal host", async () => {
    const registry = new BackendRegistry(log);
    let running = false;
    const launches: { executable: string; args: readonly string[] }[] = [];
    let sessionsCreated = 0;
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 60_000,
      terminalExecutable: () => "/tools/tmux",
      terminalWindows: [
        {
          id: "ghostty",
          label: "Ghostty",
          available: () => true,
          launch: async (command) => {
            launches.push(command);
          },
        },
      ],
      backendOptions: {
        controlFactory: (id) => new FakeControl(id) as unknown as TmuxControl,
        processTable: async () => GHOSTTY_CLIENT,
        execImpl: async (args) => {
          if (args[0] === "-V") return "tmux 3.4\n";
          if (args[0] === "list-sessions") {
            if (!running) throw new Error("not running");
            return "$0\n";
          }
          if (args[0] === "new-session") {
            running = true;
            sessionsCreated++;
            return "%1\n";
          }
          if (args[0] === "display-message") return "$0\n";
          // The window's own client, attached once the app launched.
          if (args[0] === "list-clients")
            return launches.length ? "$0\t1\t50\n$0\t0\t60\n" : "$0\t1\t50\n";
          throw new Error("unexpected tmux command");
        },
      },
    });
    await waitFor(() => registry.launchTargets().length === 1, 3000);
    expect(registry.connected()).toEqual([]);
    expect(await registry.createSession({ kind: "tab", backend: "tmux", host: "ghostty" })).toBe(
      "tmux:%1",
    );
    expect(sessionsCreated).toBe(1);
    expect(launches).toEqual([{ executable: "/tools/tmux", args: ["attach-session", "-t", "$0"] }]);
  });
  describe("a phone's plain tmux request", () => {
    function start(
      windows: { id: string; available?: () => boolean; fail?: boolean; attaches?: boolean }[],
    ) {
      const registry = new BackendRegistry(log);
      let running = false;
      const launches: string[] = [];
      const tmux: string[][] = [];
      let attached = false;
      handle = startTmuxBackend({
        registry,
        log,
        retryMs: 60_000,
        attachTimeoutMs: 300,
        terminalExecutable: () => "/tools/tmux",
        terminalWindows: windows.map((window) => ({
          id: window.id,
          label: window.id,
          available: window.available ?? (() => true),
          launch: async () => {
            launches.push(window.id);
            if (window.fail) throw new Error("window failed");
            attached = window.attaches !== false;
          },
        })),
        backendOptions: {
          controlFactory: (id) => new FakeControl(id) as unknown as TmuxControl,
          processTable: async () => GHOSTTY_CLIENT,
          execImpl: async (args) => {
            tmux.push(args);
            if (args[0] === "-V") return "tmux 3.4\n";
            if (args[0] === "list-sessions") {
              if (!running) throw new Error("not running");
              return "$0\n";
            }
            if (args[0] === "new-session") {
              running = true;
              return "%1\n";
            }
            if (args[0] === "display-message") return "$0\n";
            if (args[0] === "kill-session") return "";
            if (args[0] === "list-clients") return attached ? "$0\t0\t60\n" : "$0\t1\t50\n";
            throw new Error("unexpected tmux command");
          },
        },
      });
      const created = () => tmux.filter((args) => args[0] === "new-session").length;
      return { registry, launches, tmux, created };
    }

    it("opens in iTerm2 rather than as a detached session", async () => {
      const { registry, launches, created } = start([{ id: "ghostty" }, { id: "iterm2" }]);
      await waitFor(() => registry.launchTargets().length === 2, 3000);
      expect(await registry.createSession({ kind: "tab", backend: "tmux" })).toBe("tmux:%1");
      expect(launches).toEqual(["iterm2"]);
      expect(created()).toBe(1);
    });

    it("is refused, creating nothing, when no terminal app can show it", async () => {
      let installed = true;
      const { registry, launches, created } = start([
        { id: "ghostty", available: () => installed },
      ]);
      await waitFor(() => registry.launchTargets().length === 1, 3000);
      installed = false;
      await expect(registry.createSession({ kind: "tab", backend: "tmux" })).rejects.toThrow(
        "No terminal app on this computer can show a new session.",
      );
      expect(launches).toEqual([]);
      expect(created()).toBe(0);
    });

    it("closes the new tmux session again when its window cannot open", async () => {
      const { registry, launches, tmux } = start([{ id: "iterm2", fail: true }]);
      await waitFor(() => registry.launchTargets().length === 1, 3000);
      await expect(registry.createSession({ kind: "tab", backend: "tmux" })).rejects.toThrow(
        "so the new session was closed",
      );
      expect(launches).toEqual(["iterm2"]);
      expect(tmux).toContainEqual(["kill-session", "-t", "$0"]);
    });

    it("closes the new session when the app starts but no window attaches", async () => {
      const { registry, launches, tmux } = start([{ id: "ghostty", attaches: false }]);
      await waitFor(() => registry.launchTargets().length === 1, 3000);
      await expect(registry.createSession({ kind: "tab", backend: "tmux" })).rejects.toThrow(
        "If your computer is locked, unlock it and try again.",
      );
      expect(launches).toEqual(["ghostty"]);
      expect(tmux).toContainEqual(["kill-session", "-t", "$0"]);
    });
  });

  it("registers the member with the registry BEFORE connect resolves, then retries until tmux appears", async () => {
    const registry = new BackendRegistry(log);
    let up = false;
    const exec = async (args: string[]) => {
      if (!up) throw new Error("no tmux");
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") return "$0\n";
      throw new Error(`unexpected ${args[0]}`);
    };
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 20,
      backendOptions: {
        execImpl: exec,
        controlFactory: (sid) => new FakeControl(sid) as unknown as TmuxControl,
      },
    });
    // Registered synchronously (ruling 11), even though the first `connect()` attempt has not
    // resolved (and, here, never will until `up` flips true) -- `nameOf` proves membership without
    // touching `isConnected`.
    expect(registry.nameOf("tmux:x")).toBe("tmux");
    expect(registry.connected()).toEqual([]);

    up = true;
    await waitFor(() => registry.connected().some((b) => b.name === "tmux"), 3000);
  });

  it("calls onUnavailable exactly once while tmux is absent, then onConnected once with the pane count", async () => {
    const registry = new BackendRegistry(log);
    let up = false;
    let unavailableCalls = 0;
    let connectedPanes: number | null = null;
    const exec = async (args: string[]) => {
      if (!up) throw new Error("no tmux");
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") return "$0\n";
      throw new Error(`unexpected ${args[0]}`);
    };
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 20,
      backendOptions: {
        execImpl: exec,
        controlFactory: (sid) => new FakeControl(sid) as unknown as TmuxControl,
      },
      onUnavailable: () => {
        unavailableCalls += 1;
      },
      onConnected: (n) => {
        connectedPanes = n;
      },
    });
    // Several retry rounds while tmux is absent: onUnavailable must fire exactly once, not once
    // per retry, so the CLI's banner line is painted once rather than repeated forever.
    await new Promise((r) => setTimeout(r, 80));
    expect(unavailableCalls).toBe(1);
    expect(connectedPanes).toBeNull();

    up = true;
    await waitFor(() => registry.connected().some((b) => b.name === "tmux"), 3000);
    expect(connectedPanes).toBe(1);
    expect(unavailableCalls).toBe(1); // success does not retroactively fire it
  });

  it("stop() cancels the retry timer and removes tmux from the registry", async () => {
    const registry = new BackendRegistry(log);
    const exec = async (args: string[]) => {
      throw new Error(`unexpected ${args[0]}`);
    };
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 20,
      backendOptions: { execImpl: exec },
    });
    expect(registry.capabilitiesOf("tmux:x")).not.toBeNull();
    handle.stop();
    handle = null;
    expect(registry.capabilitiesOf("tmux:x")).toBeNull();
    // No retry fires after stop(): if it did, `exec` above would keep throwing harmlessly, but we
    // assert the timer is really gone by giving it several retryMs windows and re-checking.
    await new Promise((r) => setTimeout(r, 80));
    expect(registry.capabilitiesOf("tmux:x")).toBeNull();
  });

  it("a connected backend whose controls all die is re-connected by the supervisor (spec 8.11)", async () => {
    const registry = new BackendRegistry(log);
    const controls: FakeControl[] = [];
    const exec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") return "$0\n";
      throw new Error(`unexpected ${args[0]}`);
    };
    handle = startTmuxBackend({
      registry,
      log,
      retryMs: 20,
      backendOptions: {
        execImpl: exec,
        controlFactory: (sid) => {
          const c = new FakeControl(sid);
          controls.push(c);
          return c as unknown as TmuxControl;
        },
        // Long enough that the backend's OWN 5 s watcher cannot be what reconnects it here -- only
        // the supervisor's `retryMs` loop should notice `isConnected` went false and re-`connect()`.
        watchIntervalMs: 60_000,
      },
    });
    await waitFor(() => registry.connected().some((b) => b.name === "tmux"), 3000);
    expect(controls).toHaveLength(1);

    // Kill the only control client: `TmuxBackend.isConnected` goes false.
    controls[0]!.alive = false;
    await waitFor(() => registry.connected().length === 0, 3000);

    // The supervisor's retry loop calls `connect()` again, which re-syncs controls and gets a
    // fresh, alive one.
    await waitFor(() => registry.connected().some((b) => b.name === "tmux"), 3000);
    expect(controls.length).toBeGreaterThanOrEqual(2);
  });

  it("logs the error NAME, never the message, when tmux cannot be reached", async () => {
    const registry = new BackendRegistry(log);
    const calls: { msg: string; fields?: Record<string, unknown> }[] = [];
    const captureLog: Logger = {
      debug: (msg, fields) => calls.push({ msg, fields }),
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => captureLog,
    };
    const exec = async () => {
      throw new Error("ENOENT");
    };
    handle = startTmuxBackend({
      registry,
      log: captureLog,
      retryMs: 20,
      backendOptions: { execImpl: exec },
    });
    await waitFor(() => calls.some((c) => c.msg === "tmux not available"));
    const call = calls.find((c) => c.msg === "tmux not available");
    expect(call?.fields).toEqual({ error: "BackendUnavailable" });
  });
});
