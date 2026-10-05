import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { paths, saveConfig } from "../src/config.js";
import {
  type DoctorOptions,
  doctorExitCode,
  parseTmuxVersion,
  type RunDoctorDeps,
  runDoctor,
} from "../src/doctor.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import type { LocalStatus } from "../src/local-status.js";
import type { ServiceDefinition, ServiceSnapshot } from "../src/service-manager.js";

// Fail closed even against the legacy runDoctor(paths, config, deps) signature.
// Its default probes must never reach the developer's applications or relay.
const blocked = vi.hoisted(() => ({
  auth: vi.fn(async () => {
    throw new Error("BLOCKED_ITERM_AUTH");
  }),
  herdr: vi.fn(async () => {
    throw new Error("BLOCKED_HERDR_PROBE");
  }),
  execFile: vi.fn(() => {
    throw new Error("BLOCKED_CHILD_PROCESS");
  }),
  webSocket: vi.fn(),
  fetch: vi.fn(async () => {
    throw new Error("BLOCKED_FETCH");
  }),
  control: vi.fn(async () => {
    throw new Error("BLOCKED_CONTROL");
  }),
  manager: vi.fn(() => {
    throw new Error("BLOCKED_MANAGER");
  }),
}));
vi.mock("../src/backends/iterm2/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/backends/iterm2/auth.js")>()),
  requestCookieAndKey: blocked.auth,
}));
vi.mock("../src/backends/herdr/start.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/backends/herdr/start.js")>()),
  checkHerdr: blocked.herdr,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: blocked.execFile,
}));
vi.mock("ws", () => ({
  default: class InMemoryWebSocket {
    private handlers = new Map<string, () => void>();
    constructor() {
      blocked.webSocket();
      queueMicrotask(() => this.handlers.get("error")?.());
    }
    once(event: string, handler: () => void) {
      this.handlers.set(event, handler);
      return this;
    }
    close() {}
  },
}));
vi.mock("../src/control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control.js")>()),
  controlRequest: blocked.control,
}));
vi.mock("../src/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/launchd.js")>()),
  createLaunchdManager: blocked.manager,
  PLIST: "/doctor-blocked-plist",
}));
vi.mock("../src/backends/iterm2/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/backends/iterm2/client.js")>()),
  DEFAULT_SOCKET: "/doctor-blocked-iterm-socket",
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
      path === "/doctor-blocked-plist" || path === "/doctor-blocked-iterm-socket"
        ? false
        : fs.existsSync(path),
  };
});

vi.stubGlobal("fetch", blocked.fetch);
afterAll(() => vi.unstubAllGlobals());

const INSTANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const probe of Object.values(blocked)) expect(probe).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-doctor-"));
  dirs.push(root);
  const p = paths(join(root, "state"));
  const { fp } = loadOrCreateIdentity(p);
  saveConfig(p, {
    v: 1,
    relayUrl: "wss://relay.example.test/private?token=PRIVATE_URL_SENTINEL",
    computerName: "Test Mac",
    accent: "blue",
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4_000,
    idleMinActiveMs: 1_500,
  });
  const local: LocalStatus = {
    controlVersion: 1,
    process: {
      pid: 123,
      agentVersion: "test",
      computerFp: fp,
      stateDir: p.dir,
      serviceInstance: null,
    },
    backends: [
      { name: "iterm2", connected: false },
      { name: "tmux", connected: false },
      { name: "herdr", connected: true },
    ],
    terminalReady: true,
    relayOnline: true,
    sessions: 0,
    phones: [],
    connected: [],
  };
  const definition: ServiceDefinition = {
    nodePath: "/installed/node",
    cliPath: "/installed/cli.js",
    stateDir: p.dir,
    serviceInstance: INSTANCE,
    environment: {
      PATH: "/installed/bin",
      HERDR_SOCKET_PATH: "/installed/herdr.sock",
      XDG_CONFIG_HOME: "/installed/config",
      HERDR_SESSION: "ignored",
    },
    logPath: p.log,
  };
  const snapshot: ServiceSnapshot = {
    installed: false,
    loaded: false,
    raw: null,
    definition: null,
  };
  const options: DoctorOptions = {
    defaultStateDir: p.dir,
    requiredBackends: [],
    env: {
      PATH: "/shell/bin",
      HERDR_SOCKET_PATH: "/shell/herdr.sock",
      XDG_CONFIG_HOME: "/shell/config",
      HERDR_SESSION: "transient",
    },
  };
  const deps: RunDoctorDeps = {
    inspectManager: vi.fn(async () => snapshot),
    controlStatus: vi.fn(async () => local),
    tmuxVersion: vi.fn(async () => "tmux 3.2\n"),
    checkHerdr: vi.fn(async () => ({
      name: "herdr",
      ok: true,
      detail: "not installed (optional)",
    })),
    relayHealth: vi.fn(async () => true),
    itermSocketExists: vi.fn(() => false),
  };
  return { root, p, local, definition, snapshot, options, deps };
}

function row(checks: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const found = checks.find((check) => check.name === name);
  expect(found).toBeDefined();
  return found!;
}

describe("parseTmuxVersion shared with tmux backend", () => {
  it.each([
    ["tmux 3.2a", 3.02],
    ["tmux 3.10", 3.1],
    ["tmux 2.9", 2.09],
  ])("%s", (input, expected) => expect(parseTmuxVersion(input)).toBeCloseTo(expected));
  it("rejects unrecognizable output", () =>
    expect(parseTmuxVersion("PRIVATE_SENTINEL")).toBeNull());
});

describe("doctor evidence", () => {
  it("accepts foreground agent with zero sessions and skips connected probes", async () => {
    const f = fixture();
    const checks = await runDoctor(f.options, f.deps);
    expect(checks.map((c) => c.name)).toEqual([
      "identity",
      "service manager",
      "control",
      "relay",
      "iterm2",
      "tmux",
      "herdr",
      "terminal readiness",
    ]);
    expect(row(checks, "service manager").severity).toBe("warning");
    expect(row(checks, "control").severity).toBe("pass");
    expect(row(checks, "relay").severity).toBe("pass");
    expect(row(checks, "iterm2").severity).toBe("warning");
    expect(row(checks, "herdr").severity).toBe("pass");
    expect(row(checks, "terminal readiness").severity).toBe("pass");
    expect(doctorExitCode(checks)).toBe(0);
    expect(f.deps.checkHerdr).not.toHaveBeenCalled();
    expect(f.deps.relayHealth).not.toHaveBeenCalled();
  });

  it("absent optional tmux warns, required disconnected tmux errors", async () => {
    const f = fixture();
    f.deps.tmuxVersion = vi.fn(async () => {
      throw Object.assign(new Error("PRIVATE_SENTINEL"), { code: "ENOENT" });
    });
    let checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "tmux")).toMatchObject({ ok: true, severity: "warning" });
    expect(doctorExitCode(checks)).toBe(0);
    checks = await runDoctor({ ...f.options, requiredBackends: ["tmux"] }, f.deps);
    expect(row(checks, "tmux")).toMatchObject({ ok: false, severity: "error", required: true });
    expect(doctorExitCode(checks)).toBe(1);
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
  });

  it("checks loaded managed instance separately from local fingerprint and state", async () => {
    const f = fixture();
    f.snapshot.installed = true;
    f.snapshot.loaded = true;
    f.snapshot.definition = f.definition;
    f.deps.controlStatus = vi.fn(async () => ({
      ...f.local,
      process: { ...f.local.process, serviceInstance: INSTANCE },
    }));
    let checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "service manager").severity).toBe("pass");
    expect(row(checks, "control").severity).toBe("pass");
    f.deps.controlStatus = vi.fn(async () => f.local);
    checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "control").severity).toBe("pass");
    expect(row(checks, "service manager").severity).toBe("error");
  });

  it("stopped and legacy definitions warn without claiming verified ownership", async () => {
    const f = fixture();
    f.snapshot.installed = true;
    f.snapshot.definition = f.definition;
    expect(row(await runDoctor(f.options, f.deps), "service manager").severity).toBe("warning");
    f.snapshot.loaded = true;
    f.definition.serviceInstance = null;
    expect(row(await runDoctor(f.options, f.deps), "service manager").severity).toBe("warning");
  });

  it("rejects foreign and malformed local statuses without echoing payloads", async () => {
    const f = fixture();
    for (const payload of [
      { ...f.local, process: { ...f.local.process, computerFp: "b".repeat(26) } },
      { ...f.local, process: { ...f.local.process, stateDir: "/PRIVATE_SENTINEL" } },
      { ...f.local, terminalReady: false, secret: "PRIVATE_SENTINEL" },
    ]) {
      f.deps.controlStatus = vi.fn(async () => payload);
      const checks = await runDoctor(f.options, f.deps);
      expect(row(checks, "control").severity).toBe("error");
      expect(row(checks, "terminal readiness").severity).not.toBe("pass");
      expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
    }
  });

  it("does not probe guessed paths after manager or state selection failure", async () => {
    const f = fixture();
    f.deps.inspectManager = vi.fn(async () => {
      throw new Error("PRIVATE_SENTINEL");
    });
    let checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "service manager").severity).toBe("error");
    expect(f.deps.controlStatus).not.toHaveBeenCalled();
    expect(f.deps.tmuxVersion).not.toHaveBeenCalled();
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
    f.deps.inspectManager = vi.fn(async () => ({
      ...f.snapshot,
      installed: true,
      definition: f.definition,
    }));
    checks = await runDoctor({ ...f.options, requestedStateDir: "/different" }, f.deps);
    expect(row(checks, "identity").detail).toMatch(/unavailable/i);
    expect(f.deps.controlStatus).not.toHaveBeenCalled();
  });

  it("marks required backends unavailable after manager failure without guessing setup", async () => {
    const f = fixture();
    f.deps.inspectManager = vi.fn(async () => {
      throw new Error("PRIVATE_SENTINEL");
    });
    const checks = await runDoctor({ ...f.options, requiredBackends: ["herdr"] }, f.deps);
    expect(row(checks, "herdr")).toMatchObject({ severity: "error", required: true });
    expect(f.deps.checkHerdr).not.toHaveBeenCalled();
  });

  it("preserves malformed identity and does not create fresh state", async () => {
    const f = fixture();
    writeFileSync(f.p.identity, '{"PRIVATE_SENTINEL"');
    const before = readFileSync(f.p.identity);
    const checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "identity").severity).toBe("error");
    expect(f.deps.controlStatus).not.toHaveBeenCalled();
    expect(readFileSync(f.p.identity)).toEqual(before);
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
    const fresh = join(f.root, "not-created");
    await runDoctor({ ...f.options, defaultStateDir: fresh }, f.deps);
    expect(existsSync(fresh)).toBe(false);
  });

  it("relay reachability is supporting evidence only when agent offline", async () => {
    const f = fixture();
    f.deps.controlStatus = vi.fn(async () => ({ ...f.local, relayOnline: false }));
    const checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "relay").severity).toBe("error");
    expect(f.deps.relayHealth).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_URL_SENTINEL");
  });

  it("reports missing control endpoint, offline relay and no terminal separately", async () => {
    const f = fixture();
    f.deps.controlStatus = vi.fn(async () => {
      throw Object.assign(new Error("PRIVATE_SENTINEL"), { code: "ENOENT" });
    });
    const checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "control").severity).toBe("error");
    expect(row(checks, "relay").severity).toBe("error");
    expect(row(checks, "terminal readiness").severity).toBe("error");
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
  });

  it("invalid config is a fixed path-only relay error without a health request", async () => {
    const f = fixture();
    writeFileSync(f.p.config, '{"PRIVATE_SENTINEL"');
    const before = readFileSync(f.p.config);
    const checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "relay").severity).toBe("error");
    expect(f.deps.relayHealth).not.toHaveBeenCalled();
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
    expect(readFileSync(f.p.config)).toEqual(before);
  });

  it("required disconnected iTerm and Herdr error even if standalone setup is present", async () => {
    const f = fixture();
    f.deps.controlStatus = vi.fn(async () => ({
      ...f.local,
      backends: f.local.backends.map((b) => ({ ...b, connected: b.name === "tmux" })),
      terminalReady: true,
    }));
    f.deps.itermSocketExists = vi.fn(() => true);
    f.deps.checkHerdr = vi.fn(async () => ({
      name: "herdr",
      ok: true,
      detail: "v0.8.2 protocol 22",
    }));
    const checks = await runDoctor({ ...f.options, requiredBackends: ["iterm2", "herdr"] }, f.deps);
    expect(row(checks, "iterm2")).toMatchObject({ severity: "error", required: true });
    expect(row(checks, "herdr")).toMatchObject({ severity: "error", required: true });
    expect(row(checks, "terminal readiness").severity).toBe("pass");
  });

  it("uses installed backend environment", async () => {
    const f = fixture();
    f.snapshot.installed = true;
    f.snapshot.definition = f.definition;
    f.deps.controlStatus = vi.fn(async () => ({
      ...f.local,
      backends: f.local.backends.map((b) => ({ ...b, connected: b.name === "tmux" })),
      terminalReady: true,
    }));
    await runDoctor(f.options, f.deps);
    expect(f.deps.checkHerdr).toHaveBeenCalledWith(
      expect.objectContaining({
        PATH: "/installed/bin",
        HERDR_SOCKET_PATH: "/installed/herdr.sock",
        XDG_CONFIG_HOME: "/installed/config",
      }),
    );
    expect((f.deps.checkHerdr as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty(
      "HERDR_SESSION",
    );
    expect(f.deps.tmuxVersion).not.toHaveBeenCalled();
  });

  it("uses current-shell backend environment without installed service", async () => {
    const f = fixture();
    f.deps.controlStatus = vi.fn(async () => ({
      ...f.local,
      backends: f.local.backends.map((b) => ({ ...b, connected: b.name === "iterm2" })),
      terminalReady: true,
    }));
    const checks = await runDoctor(f.options, f.deps);
    expect(f.deps.tmuxVersion).toHaveBeenCalledWith(
      expect.objectContaining({ PATH: "/shell/bin", HERDR_SESSION: "transient" }),
    );
    expect(f.deps.checkHerdr).toHaveBeenCalledWith(
      expect.objectContaining({ HERDR_SOCKET_PATH: "/shell/herdr.sock" }),
    );
    expect(row(checks, "herdr")).toMatchObject({ severity: "warning", ok: true });
    expect(row(checks, "herdr").detail).toMatch(/not found on PATH/);
  });

  it("old tmux and broken Herdr error while setup evidence does not imply terminal readiness", async () => {
    const f = fixture();
    f.deps.controlStatus = vi.fn(async () => ({
      ...f.local,
      backends: f.local.backends.map((b) => ({ ...b, connected: false })),
      terminalReady: false,
    }));
    f.deps.tmuxVersion = vi.fn(async () => "tmux 3.1a");
    f.deps.checkHerdr = vi.fn(async () => ({
      name: "herdr",
      ok: false,
      detail: "PRIVATE_SENTINEL",
      fix: "upgrade",
    }));
    const checks = await runDoctor(f.options, f.deps);
    expect(row(checks, "tmux").severity).toBe("error");
    expect(row(checks, "herdr").severity).toBe("error");
    expect(row(checks, "terminal readiness").severity).toBe("error");
    expect(JSON.stringify(checks)).not.toContain("PRIVATE_SENTINEL");
  });
});
