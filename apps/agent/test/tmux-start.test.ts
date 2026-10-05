import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { startTmuxBackend } from "../src/backends/tmux/start.js";
import { createLogger, type Logger } from "../src/log.js";
import { waitFor } from "./fakes/wait.js";

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
