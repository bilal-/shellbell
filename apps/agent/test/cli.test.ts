import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateIdentity, parseQr } from "@shellbell/protocol";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import {
  addServiceCommands,
  type BuildAgentDeps,
  buildAgent,
  chooseConfirm,
  isEntryPoint,
  resolveConfigSet,
  resolveRelayOverride,
  shutdown,
  socketAlive,
  tailFile,
  validateRelayUrl,
} from "../src/cli.js";
import { loadConfig, paths } from "../src/config.js";
import { ControlServer, controlPairSession } from "../src/control.js";
import { createLogger } from "../src/log.js";
import { PairingManager } from "../src/pairing.js";
import {
  type ServiceLifecycle,
  ServiceLifecycleError,
  type ServiceStatus,
} from "../src/service-lifecycle.js";
import { waitFor } from "./fakes/wait.js";

describe("service command presentation", () => {
  const status: ServiceStatus = {
    manager: "launchd",
    definitionPath: "/owned/service.plist",
    installed: true,
    loaded: false,
    startupEnabled: true,
    autostartConfigured: true,
    managedPid: null,
    ownership: "none",
    local: null,
    ready: false,
  };
  async function run(command: string, json: boolean, result: ServiceStatus | Error) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((line) => stderr.push(String(line)));
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const program = new Command().option("--json");
      addServiceCommands(
        program,
        () =>
          ({
            [command]: async () => {
              if (result instanceof Error) throw result;
              return result;
            },
          }) as unknown as ServiceLifecycle,
        { platform: "darwin" },
      );
      await program.parseAsync([...(json ? ["--json"] : []), "service", command], { from: "user" });
      return { code: process.exitCode, stdout, stderr };
    } finally {
      log.mockRestore();
      error.mockRestore();
      process.exitCode = previous;
    }
  }
  it.each([false, true])(
    "status returns 2 for unready state, ready status returns 0 (json=%s)",
    async (json) => {
      expect((await run("status", json, status)).code).toBe(2);
      expect((await run("status", json, { ...status, ready: true, loaded: true })).code).toBe(0);
    },
  );
  it.each(["install", "start", "restart", "stop", "uninstall", "enable", "disable"])(
    "%s reports operational success identically in text and JSON",
    async (command) => {
      const result =
        command === "stop" || command === "uninstall"
          ? status
          : { ...status, ready: true, loaded: true };
      for (const json of [false, true]) expect((await run(command, json, result)).code).toBe(0);
    },
  );
  it("JSON errors stay structured on stdout and include distinct rollback diagnostics", async () => {
    const failure = new ServiceLifecycleError("launch failed");
    failure.rollback = "failed";
    failure.rollbackDiagnostic = "unload denied";
    failure.recoveryPath = "/owned/recovery";
    const json = await run("install", true, failure);
    expect(json.code).toBe(2);
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout[0]!)).toEqual({
      error: "launch failed",
      rollback: "failed",
      rollbackDiagnostic: "unload denied",
      recoveryPath: "/owned/recovery",
    });
    const text = await run("install", false, failure);
    expect(text.code).toBe(2);
    expect(text.stderr.join(" ")).toContain("/owned/recovery");
  });
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sb-cli-"));
}

function fakeAgent() {
  return {
    localStatus: {
      controlVersion: 1 as const,
      process: {
        pid: 4242,
        agentVersion: "0.0.1-test",
        computerFp: "a".repeat(26),
        stateDir: "/tmp/shellbell-test-state",
        serviceInstance: null,
      },
      backends: [
        { name: "iterm2" as const, connected: false },
        { name: "tmux" as const, connected: false },
        { name: "herdr" as const, connected: false },
      ],
      terminalReady: false,
    },
    relayOnline: true,
    pairingList: [],
    sessionList: [],
    connectedPhones: [],
    unpair: () => false,
    openPairing: () => ({ qrText: "{}", expiresAt: Date.now() + 1000 }),
    closePairing: () => {},
    stop: vi.fn(),
  };
}

describe("start --service runtime identity", () => {
  it("rejects an invalid service instance before creating state or starting detectors", async () => {
    const stateDir = join(tmpDir(), "not-created");
    const sentinel = "PRIVATE_SENTINEL";
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "start", "--service"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SHELLBELL_DIR: stateDir,
        SHELLBELL_SERVICE_INSTANCE: sentinel,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, timedOut: true });
      }, 5_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve({ code, timedOut: false });
      });
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toMatch(/SHELLBELL_SERVICE_INSTANCE/);
    expect(`${stdout}\n${stderr}`).not.toContain(sentinel);
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe("service install runtime preflight", () => {
  it("rejects a source CLI before creating the configured state directory", async () => {
    const stateDir = join(tmpDir(), "not-created");
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "service", "install"], {
      cwd: process.cwd(),
      env: { ...process.env, SHELLBELL_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, timedOut: true });
      }, 5_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve({ code, timedOut: false });
      });
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(2);
    expect(stderr).toMatch(/built|installed/i);
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe("tailFile", () => {
  it("returns only the last maxLines lines within a maxBytes window", () => {
    const dir = tmpDir();
    const file = join(dir, "agent.log");
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const tail = tailFile(file, 64 * 1024, 200);
    const got = tail.split("\n").filter(Boolean);
    expect(got.length).toBe(200);
    expect(got[got.length - 1]).toBe("line 499");
    expect(got[0]).toBe("line 300");
  });

  it("handles a file smaller than maxBytes", () => {
    const dir = tmpDir();
    const file = join(dir, "agent.log");
    writeFileSync(file, "a\nb\nc\n");
    expect(
      tailFile(file, 64 * 1024, 200)
        .split("\n")
        .filter(Boolean),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("validateRelayUrl", () => {
  it("accepts wss:// unconditionally", () => {
    expect(validateRelayUrl("wss://relay.shellbell.dev", false)).toBeNull();
  });
  it("rejects ws:// unless insecure is allowed", () => {
    expect(validateRelayUrl("ws://localhost:8787", false)).toMatch(/insecure/);
  });
  it("accepts ws:// when insecure is allowed (LAN dev)", () => {
    expect(validateRelayUrl("ws://localhost:8787", true)).toBeNull();
  });
  it("rejects other schemes", () => {
    expect(validateRelayUrl("http://relay.shellbell.dev", false)).toMatch(/wss:\/\//);
  });
  it("rejects unparseable urls", () => {
    expect(validateRelayUrl("not a url", false)).toMatch(/valid URL/);
  });
});

describe("resolveRelayOverride (I2: --relay must steer both the socket and the QR)", () => {
  const cfg = loadConfig(paths(tmpDir()));

  it("passes the config through unchanged when no override is given", () => {
    const r = resolveRelayOverride(cfg, undefined);
    expect("cfg" in r && r.cfg).toBe(cfg);
    expect("cfg" in r && r.warning).toBeUndefined();
  });

  it("accepts a wss:// override with no warning", () => {
    const r = resolveRelayOverride(cfg, "wss://relay.example.com");
    expect("cfg" in r && r.cfg.relayUrl).toBe("wss://relay.example.com");
    expect("cfg" in r && r.warning).toBeUndefined();
  });

  it("accepts a ws:// override (unlike `config set relay`, no --insecure needed) with a warning", () => {
    const r = resolveRelayOverride(cfg, "ws://localhost:8787");
    expect("cfg" in r && r.cfg.relayUrl).toBe("ws://localhost:8787");
    expect("cfg" in r && r.warning).toMatch(/insecure relay URL; for local testing only/);
  });

  it("rejects a URL with a scheme other than ws(s)://", () => {
    const r = resolveRelayOverride(cfg, "http://relay.example.com");
    expect("error" in r && r.error).toMatch(/wss:\/\//);
  });

  it("rejects an unparseable URL", () => {
    const r = resolveRelayOverride(cfg, "not a url");
    expect("error" in r && r.error).toMatch(/valid URL/);
  });

  it("the resolved cfg.relayUrl is what the printed QR's `r` actually carries (I2 regression)", () => {
    const r = resolveRelayOverride(cfg, "ws://localhost:8787");
    if (!("cfg" in r)) throw new Error();
    const identity = generateIdentity();
    const pm = new PairingManager({
      identity,
      fp: fingerprint(identity.ed25519.pub),
      computerName: "MBP",
      accent: "emerald",
      relayUrl: r.cfg.relayUrl, // exactly what `buildAgent` passes to `Agent`'s PairingManager
      sendCtrl: () => true,
      savePairing: () => {},
      confirm: async () => true,
      pairingCount: () => 0,
      log: createLogger({ stdout: false }),
    });
    const { qrText } = pm.openWindow();
    expect(parseQr(qrText, { allowInsecure: true }).r).toBe("ws://localhost:8787");
  });
});

describe("resolveConfigSet", () => {
  const cfg = loadConfig(paths(tmpDir()));

  it("accepts a valid relay url", () => {
    const r = resolveConfigSet(cfg, "relay", "wss://relay.example.com", false);
    expect("next" in r && r.next.relayUrl).toBe("wss://relay.example.com");
  });

  it("rejects an insecure relay url with a one-line error, not a ZodError dump", () => {
    const r = resolveConfigSet(cfg, "relay", "ws://localhost:8787", false);
    expect("error" in r && r.error).toMatch(/insecure/);
  });

  it("accepts name changes", () => {
    const r = resolveConfigSet(cfg, "name", "Bilal's MBP", false);
    expect("next" in r && r.next.computerName).toBe("Bilal's MBP");
  });

  it("rejects a name that fails the schema, with a friendly one-line error", () => {
    const r = resolveConfigSet(cfg, "name", "", false);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.error).not.toMatch(/ZodError|\[\n/); // not a raw multi-line dump
    }
  });

  it("accepts a known accent and rejects an unknown one", () => {
    const ok = resolveConfigSet(cfg, "accent", "violet", false);
    expect("next" in ok && ok.next.accent).toBe("violet");
    const bad = resolveConfigSet(cfg, "accent", "beige", false);
    expect("error" in bad && bad.error).toMatch(/unknown accent/);
  });

  it("rejects an unknown key", () => {
    const r = resolveConfigSet(cfg, "bogus", "x", false);
    expect("error" in r && r.error).toMatch(/unknown key/);
  });

  it.each([
    ["notifyMinCommandMs", "30000", 30_000],
    ["idleQuietMs", "30000", 30_000],
    ["idleMinActiveMs", "30000", 30_000],
    ["notifyMinCommandMs", "0", 0],
    ["idleQuietMs", "1", 1],
    ["idleMinActiveMs", "0", 0],
  ])("sets %s from the complete decimal integer %s", (key, value, expected) => {
    const result = resolveConfigSet(cfg, key, value, false);
    expect(result).toEqual({ next: { ...cfg, [key]: expected } });
  });

  it("rejects zero at the positive idleQuietMs boundary", () => {
    expect(resolveConfigSet(cfg, "idleQuietMs", "0", false)).toHaveProperty("error");
  });

  it.each(["notifyMinCommandMs", "idleQuietMs", "idleMinActiveMs"])(
    "rejects malformed and unsafe integers for %s",
    (key) => {
      for (const value of ["-1", "1.5", "NaN", "Infinity", "9007199254740992", "", "12ms"]) {
        expect(
          resolveConfigSet(cfg, key, value, false),
          `${key}=${JSON.stringify(value)}`,
        ).toHaveProperty("error");
      }
    },
  );

  it("lists every supported key when rejecting an unknown key", () => {
    const result = resolveConfigSet(cfg, "unknown", "x", false);
    expect(result).toEqual({
      error:
        "unknown key unknown (expected relay, name, accent, notifyMinCommandMs, idleQuietMs, or idleMinActiveMs)",
    });
  });
});

describe("socketAlive", () => {
  it("is false and does nothing when the socket file does not exist (ENOENT)", async () => {
    const sock = join(tmpDir(), "agent.sock");
    expect(await socketAlive(sock)).toBe(false);
    expect(existsSync(sock)).toBe(false);
  });

  it("is true when a real ControlServer is listening", async () => {
    const sock = join(tmpDir(), "agent.sock");
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    expect(await socketAlive(sock)).toBe(true);
    await server.stop();
  });

  it("is false and preserves a genuinely stale socket for serialized startup cleanup", async () => {
    // Simulate a crash: a child process binds the socket and is SIGKILLed before it can clean
    // up, leaving a real (but unconnectable) AF_UNIX socket file behind -- the scenario I1
    // targets, distinct from a merely-missing file (ENOENT).
    const sock = join(tmpDir(), "agent.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net=require("node:net");const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write("ready\\n"));setInterval(()=>{},1000);`,
        sock,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (d) => {
        if (d.toString().includes("ready")) resolve();
      });
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(existsSync(sock)).toBe(true);

    expect(await socketAlive(sock)).toBe(false);
    expect(existsSync(sock)).toBe(true);
  });
});

describe("chooseConfirm", () => {
  it("native service refuses consent without its native owner and never asks terminal", async () => {
    const ask = vi.fn(async () => true);
    expect(await chooseConfirm({ server: null }, false, ask, false)("a".repeat(26), "phone")).toBe(
      false,
    );
    expect(ask).not.toHaveBeenCalled();
  });
  it("routes an owned native challenge before --yes or the TTY", async () => {
    const askYesNo = vi.fn(async () => true);
    const nativePairingConfirm = vi.fn(async () => false);
    const server = {
      hasNativePairOwner: true,
      nativePairingConfirm,
      hasPairClients: false,
      pairingConfirm: vi.fn(),
    } as unknown as ControlServer;
    const confirm = chooseConfirm({ server }, true, askYesNo);
    await expect(confirm("f".repeat(26), "Phone")).resolves.toBe(false);
    expect(nativePairingConfirm).toHaveBeenCalledWith("f".repeat(26), "Phone");
    expect(askYesNo).not.toHaveBeenCalled();
  });
  it("always accepts when --yes, without touching the server or the TTY prompt", async () => {
    const askYesNo = vi.fn(async () => false);
    const confirm = chooseConfirm({ server: null }, true, askYesNo);
    expect(await confirm("fp", "name")).toBe(true);
    expect(askYesNo).not.toHaveBeenCalled();
  });

  it("falls back to the TTY prompt when no pair-open client is connected", async () => {
    const askYesNo = vi.fn(async () => true);
    const confirm = chooseConfirm({ server: null }, false, askYesNo);
    expect(await confirm("fp", "name")).toBe(true);
    expect(askYesNo).toHaveBeenCalledWith("fp", "name");
  });

  it(
    "routes to the connected pair-open client instead of the TTY, even though the daemon " +
      "conceptually owns a TTY (critical fix C1)",
    async () => {
      const sock = join(tmpDir(), "agent.sock");
      const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
      await server.start();

      let resolveOpen!: () => void;
      const opened = new Promise<void>((r) => {
        resolveOpen = r;
      });
      let resolveRequest!: (v: { phoneFp: string; name: string }) => void;
      const requested = new Promise<{ phoneFp: string; name: string }>((r) => {
        resolveRequest = r;
      });
      const session = controlPairSession(sock, {
        onOpen: () => resolveOpen(),
        onRequest: (phoneFp, name) => {
          resolveRequest({ phoneFp, name });
          return Promise.resolve(true); // the client's own answer decides the result
        },
        onClose: () => {},
        onError: (e) => {
          throw e;
        },
      });
      await opened;
      expect(server.hasPairClients).toBe(true);

      // The daemon's own stdin/TTY prompt must never be consulted while a pair client is live.
      const askYesNo = vi.fn(async () => false);
      const confirm = chooseConfirm({ server }, false, askYesNo);

      const result = await confirm("d".repeat(26), "Bilal's iPhone");

      expect(await requested).toEqual({ phoneFp: "d".repeat(26), name: "Bilal's iPhone" });
      expect(result).toBe(true); // the client's confirm answer, not askYesNo's
      expect(askYesNo).not.toHaveBeenCalled();

      session.close();
      await server.stop();
    },
  );
});

describe("shutdown", () => {
  it("stops the agent, removes agent.sock and agent.pid, and exits(0)", async () => {
    const dir = tmpDir();
    const sock = join(dir, "agent.sock");
    const pid = join(dir, "agent.pid");
    const agent = fakeAgent();
    const server = new ControlServer(sock, agent as never, createLogger({ stdout: false }), pid);
    await server.start();
    writeFileSync(pid, String(process.pid));
    expect(existsSync(sock)).toBe(true);
    expect(existsSync(pid)).toBe(true);

    const exit = vi.fn();
    await shutdown(agent as never, server, exit);

    expect(agent.stop).toHaveBeenCalled();
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(pid)).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("runs the optional cleanup callback (e.g. cancelling buildAgent's first-connect retry timer)", async () => {
    const dir = tmpDir();
    const agent = fakeAgent();
    const server = new ControlServer(
      join(dir, "agent.sock"),
      agent as never,
      createLogger({ stdout: false }),
    );
    await server.start();
    const cleanup = vi.fn();
    const exit = vi.fn();
    await shutdown(agent as never, server, exit, cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("minor: force-exits after a 5s hard deadline if control.stop() never settles, so Ctrl-C can't hang forever", async () => {
    vi.useFakeTimers();
    try {
      const agent = fakeAgent();
      const hangingControl = { stop: () => new Promise<void>(() => {}) };
      const exit = vi.fn();
      void shutdown(agent as never, hangingControl as never, exit);
      await vi.advanceTimersByTimeAsync(5000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    if (line.startsWith("capture-pane")) return ["hello", ""];
    throw new Error(`unexpected ${line.split(" ")[0]}`);
  }
}

/** M-6: `buildAgent`'s tmux banner wiring (`onConnected`/`onUnavailable` -> `print()`) had zero
 * coverage anywhere in the suite -- neither for tmux nor for herdr's identical pattern. Drives it
 * with the `tmuxBackendOptions` test seam (same fake `execImpl`/`controlFactory` shape
 * `tmux-start.test.ts` already injects into `startTmuxBackend` directly), isolated from the real
 * filesystem via `SHELLBELL_DIR`. The static `"  tmux       detecting…"` line the `start` command
 * prints unconditionally (no logic to exercise) is left to the Task 4 anchor verification; only
 * the two DYNAMIC lines that depend on the supervisor's async callbacks are asserted here. */
it.each([false, true])(
  "refuses a desktop-owned CLI engine before creating identity or starting backends (managed service: %s)",
  async (managedService) => {
    const { realpathSync } = await import("node:fs");
    const { ServiceOwnerStore } = await import("../src/service-ownership.js");
    const p = paths(realpathSync(tmpDir()));
    await new ServiceOwnerStore({ stateDir: p.dir, uid: process.getuid!() }).mutate(
      null,
      async (tx) => {
        tx.publish({
          v: 1,
          mode: "desktop",
          consented: true,
          startupEnabled: false,
          transition: null,
        });
      },
    );
    await expect(
      buildAgent(createLogger({ stdout: false }), undefined, false, {
        paths: p,
        itermBackend: null,
        startHerdr: () => {
          throw new Error("backend must not start");
        },
        managedService,
      }),
    ).rejects.toThrow(/desktop-owned/);
    expect(existsSync(p.identity)).toBe(false);
    expect(existsSync(p.config)).toBe(false);
  },
);

it.each([false, true])(
  "invalidates old CLI admission across a desktop claim (claim still locked: %s)",
  async (locked) => {
    const { realpathSync } = await import("node:fs");
    const { ServiceOwnerStore } = await import("../src/service-ownership.js");
    const p = paths(realpathSync(tmpDir()));
    const built = await buildAgent(createLogger({ stdout: false }), undefined, false, {
      paths: p,
      itermBackend: null,
      startHerdr: () => ({ stop() {} }),
      tmuxBackendOptions: {
        execImpl: async () => {
          throw new Error("no tmux in fixture");
        },
      },
    });
    try {
      // Deterministic suspension point: the foreground CLI was admitted, then a
      // desktop setup/start/Quit completed before this CLI published its socket.
      const owner = new ServiceOwnerStore({ stateDir: p.dir, uid: process.getuid!() });
      if (locked) {
        await owner.mutate(null, async () => {
          await expect(built.control.start()).rejects.toThrow(/busy/);
        });
      } else {
        await owner.mutate(null, async (tx) => {
          tx.publish({
            v: 1,
            mode: "desktop",
            consented: true,
            startupEnabled: false,
            transition: null,
          });
        });
        await expect(built.control.start()).rejects.toThrow(/desktop-owned/);
      }
      expect(await socketAlive(p.sock)).toBe(false);
      expect(existsSync(p.pid)).toBe(false);
    } finally {
      built.stopBackendDetectors();
      await built.control.stop();
      await built.agent.stop();
    }
  },
);

describe("buildAgent's tmux banner wiring (M-6)", () => {
  async function withCapturedPrints(
    tmuxBackendOptions: BuildAgentDeps["tmuxBackendOptions"],
    assert: (lines: string[]) => Promise<void> | void,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "sb-cli-tmux-"));
    const prevDir = process.env.SHELLBELL_DIR;
    process.env.SHELLBELL_DIR = dir;
    const log = createLogger({ stdout: false });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (line: string) => lines.push(String(line));
    let built: Awaited<ReturnType<typeof buildAgent>> | null = null;
    try {
      built = await buildAgent(log, undefined, true, {
        tmuxBackendOptions,
        itermBackend: null,
        startHerdr: () => ({ stop() {} }),
      });
      built.releaseOutput();
      await waitFor(() => lines.some((l) => l.includes("tmux")), 3000);
      await assert(lines);
    } finally {
      console.log = origLog;
      built?.stopBackendDetectors();
      built?.agent.stop();
      if (prevDir === undefined) delete process.env.SHELLBELL_DIR;
      else process.env.SHELLBELL_DIR = prevDir;
    }
  }

  it('prints "tmux       not running" via onUnavailable, buffered through print() like iTerm2/herdr', async () => {
    await withCapturedPrints(
      {
        execImpl: async () => {
          throw new Error("no tmux in this test");
        },
      },
      (lines) => {
        expect(lines).toContain("  tmux       not running");
      },
    );
  });

  it('prints "tmux       connected · N panes" via onConnected once a fake tmux answers', async () => {
    const exec = async (args: string[]) => (args[0] === "-V" ? "tmux 3.4\n" : "$0\n");
    const control = new FakeControl("$0");
    await withCapturedPrints(
      { execImpl: exec, controlFactory: () => control as unknown as TmuxControl },
      (lines) => {
        expect(lines).toContain("  tmux       connected · 1 pane");
      },
    );
  });
});

describe("isEntryPoint (npm's bin symlink and pnpm's store can put a symlink on either side)", () => {
  it("matches when argv1 and self already resolve identically (plain `node dist/cli.js`)", () => {
    const resolvePath = (p: string) => p;
    expect(isEntryPoint("/app/dist/cli.js", "file:///app/dist/cli.js", resolvePath)).toBe(true);
  });

  it("matches when argv1 is a symlink that resolves to self's real path (npm global bin)", () => {
    const resolvePath = (p: string) =>
      p === "/prefix/bin/shellbell" ? "/prefix/lib/node_modules/shellbell/dist/cli.js" : p;
    expect(
      isEntryPoint(
        "/prefix/bin/shellbell",
        "file:///prefix/lib/node_modules/shellbell/dist/cli.js",
        resolvePath,
      ),
    ).toBe(true);
  });

  it("matches when self's URL is the symlinked side (pnpm's content-addressed store)", () => {
    const resolvePath = (p: string) =>
      p === "/repo/apps/agent/dist/cli.js" ? "/store/pkg/dist/cli.js" : p;
    expect(
      isEntryPoint("/store/pkg/dist/cli.js", "file:///repo/apps/agent/dist/cli.js", resolvePath),
    ).toBe(true);
  });

  it("does not match a different file", () => {
    const resolvePath = (p: string) => p;
    expect(isEntryPoint("/app/dist/other.js", "file:///app/dist/cli.js", resolvePath)).toBe(false);
  });

  it("falls back to the raw path when realpath throws (e.g. ENOENT)", () => {
    const resolvePath = (p: string) => {
      if (p === "/app/dist/cli.js") throw new Error("ENOENT");
      return p;
    };
    expect(isEntryPoint("/app/dist/cli.js", "file:///app/dist/cli.js", resolvePath)).toBe(true);
  });

  it("is false when argv1 is undefined (e.g. a test importing the pure helpers above)", () => {
    expect(isEntryPoint(undefined, "file:///app/dist/cli.js")).toBe(false);
  });

  it("resolves a real symlink via the real realpathSync (no injected resolver), like npm's bin", () => {
    const dir = tmpDir();
    const real = join(dir, "cli.js");
    const link = join(dir, "shellbell");
    writeFileSync(real, "// fake bundle\n");
    symlinkSync(real, link);
    expect(isEntryPoint(link, `file://${real}`)).toBe(true);
    expect(isEntryPoint(link, `file://${join(dir, "other.js")}`)).toBe(false);
  });
});
