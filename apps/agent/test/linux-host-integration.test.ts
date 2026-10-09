import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildAgent, program } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import { initializeLinuxHost } from "../src/host-init.js";
import { resolveLinuxPaths } from "../src/host-paths.js";
import { readLinuxIdentity, requireLinuxState } from "../src/host-state.js";
import { createLogger } from "../src/log.js";
import { config, fixture } from "./host-fixtures.js";

const blocked = vi.hoisted(() => ({
  iterm: vi.fn(
    class {
      constructor() {
        throw new Error("unexpected iTerm2 construction");
      }
    },
  ),
  herdr: vi.fn(() => {
    throw new Error("unexpected Herdr detector");
  }),
  stopTmux: vi.fn(),
  control: vi.fn(
    class {
      async start() {
        throw new Error("synthetic control startup stop");
      }
    },
  ),
  request: vi.fn(() => {
    throw Object.assign(new Error("synthetic absent control"), { code: "ENOENT" });
  }),
  external: vi.fn(() => {
    throw new Error("unexpected external operation");
  }),
}));
vi.mock("../src/host-paths.js", async (original) => {
  const module = await original<typeof import("../src/host-paths.js")>();
  return { ...module, resolveLinuxPaths: vi.fn(module.resolveLinuxPaths) };
});
vi.mock("../src/host-state.js", async (original) => {
  const module = await original<typeof import("../src/host-state.js")>();
  return { ...module, requireLinuxState: vi.fn(module.requireLinuxState) };
});
vi.mock("../src/control.js", () => ({
  ControlServer: blocked.control,
  controlRequest: blocked.request,
  controlPairSession: blocked.external,
}));
vi.mock("../src/launchd.js", () => ({ createLaunchdManager: blocked.external }));
vi.mock("../src/systemd-lifecycle.js", () => ({
  SystemdServiceLifecycle: class {
    constructor() {
      throw new Error("shellbell: fixture systemd manager unavailable");
    }
  },
}));
vi.mock("../src/relay-client.js", async (original) => {
  const module = await original<typeof import("../src/relay-client.js")>();
  return {
    ...module,
    RelayClient: class extends module.RelayClient {
      override start = blocked.external;
    },
  };
});
vi.mock("../src/backends/iterm2/client.js", async (original) => ({
  ...(await original<typeof import("../src/backends/iterm2/client.js")>()),
  ITerm2Client: blocked.iterm,
}));
vi.mock("../src/backends/herdr/start.js", async (original) => ({
  ...(await original<typeof import("../src/backends/herdr/start.js")>()),
  startHerdrBackend: blocked.herdr,
}));
vi.mock("../src/backends/tmux/start.js", () => ({
  startTmuxBackend: () => ({ stop: blocked.stopTmux }),
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(resolveLinuxPaths).mockReset();
  vi.mocked(requireLinuxState).mockReset();
  process.exitCode = 0;
});

function tree(dir: string): unknown {
  if (!existsSync(dir)) return null;
  const st = lstatSync(dir);
  return {
    mode: st.mode,
    ...(st.isDirectory()
      ? {
          children: Object.fromEntries(
            readdirSync(dir)
              .sort()
              .map((name) => [name, tree(join(dir, name))]),
          ),
        }
      : { bytes: readFileSync(dir).toString("base64") }),
  };
}

function selectFixture(p: ReturnType<typeof resolveLinuxPaths>) {
  vi.stubEnv("SHELLBELL_DIR", p.dir);
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  vi.mocked(resolveLinuxPaths).mockReturnValue(p);
}

async function ready() {
  const p = resolveLinuxPaths(fixture().options);
  await initializeLinuxHost(p, { kind: "new" }, config);
  return p;
}

it("builds Linux with the exact admitted runtime paths and only a tmux detector", async () => {
  const p = await ready();
  vi.stubEnv("SHELLBELL_DIR", p.dir);
  const identity = readFileSync(p.identity);
  rmSync(p.runtimeDir, { recursive: true });
  const built = await buildAgent(createLogger({ stdout: false }), undefined, false, { paths: p });
  try {
    expect(built.p).toBe(p);
    expect(existsSync(p.runtimeDir)).toBe(true);
    expect(readFileSync(p.identity)).toEqual(identity);
    expect(blocked.iterm).not.toHaveBeenCalled();
    expect(blocked.herdr).not.toHaveBeenCalled();
    expect(blocked.control).toHaveBeenCalledWith(
      p.sock,
      built.agent,
      expect.anything(),
      p.pid,
      expect.any(Function),
      expect.any(Function),
      "terminal",
    );
  } finally {
    built.stopBackendDetectors();
  }
  expect(blocked.stopTmux).toHaveBeenCalledOnce();
});

it.each(["start", "pair"])(
  "%s carries the single selected object from ctx into foreground construction",
  async (command) => {
    const p = await ready();
    selectFixture(p);
    vi.mocked(resolveLinuxPaths).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("synthetic exit");
    });
    await expect(program.parseAsync([command], { from: "user" })).rejects.toThrow("synthetic exit");
    expect(resolveLinuxPaths).toHaveBeenCalledOnce();
    expect(blocked.control).toHaveBeenCalledWith(
      p.sock,
      expect.anything(),
      expect.anything(),
      p.pid,
      expect.any(Function),
      expect.any(Function),
      "terminal",
    );
    expect(blocked.iterm).not.toHaveBeenCalled();
    expect(blocked.herdr).not.toHaveBeenCalled();
    expect(blocked.external).not.toHaveBeenCalled();
  },
);

it.each(["absent", "unmarked", "wrong-host", "corrupt"])(
  "doctor reports %s state without creating runtime or probing macOS services",
  async (kind) => {
    const p = await ready();
    if (kind === "absent") rmSync(p.dir, { recursive: true });
    if (kind === "unmarked") rmSync(join(p.dir, "host.json"));
    if (kind === "wrong-host") {
      const marker = JSON.parse(readFileSync(join(p.dir, "host.json"), "utf8"));
      writeFileSync(
        join(p.dir, "host.json"),
        JSON.stringify({ ...marker, hostDigest: "a".repeat(64) }),
      );
    }
    if (kind === "corrupt") writeFileSync(p.identity, "private broken content");
    rmSync(p.runtimeDir, { recursive: true });
    const inspectManager = vi.fn(() => {
      throw new Error("unexpected launchd inspection");
    });
    const checks = await runDoctor(
      { platform: "linux", env: {}, defaultStateDir: "unused", requiredBackends: [] },
      { selectLinuxPaths: () => p, inspectManager },
    );
    expect(checks.some((c) => c.name === "host state" && c.severity === "error")).toBe(true);
    expect(inspectManager).not.toHaveBeenCalled();
    expect(existsSync(p.runtimeDir)).toBe(false);
    expect(JSON.stringify(checks)).not.toContain("private broken content");
  },
);

it.each(["absent", "unmarked", "wrong-host", "corrupt", "unsafe"])(
  "ordinary commands refuse %s state without filesystem mutation",
  async (kind) => {
    const p = await ready();
    if (kind === "absent") rmSync(p.dir, { recursive: true });
    if (kind === "unmarked") rmSync(join(p.dir, "host.json"));
    if (kind === "wrong-host") {
      const marker = JSON.parse(readFileSync(join(p.dir, "host.json"), "utf8"));
      writeFileSync(
        join(p.dir, "host.json"),
        JSON.stringify({ ...marker, hostDigest: "a".repeat(64) }),
      );
    }
    if (kind === "corrupt") writeFileSync(p.identity, "private broken content");
    if (kind === "unsafe") chmodSync(p.config, 0o644);
    selectFixture(p);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = tree(p.dir);
    for (const args of [
      ["start"],
      ["pair"],
      ["status"],
      ["devices"],
      ["unpair", "phone"],
      ["logs"],
    ]) {
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(/Linux host state/);
      expect(tree(p.dir)).toEqual(before);
    }
    await program.parseAsync(["--json", "config", "set", "name", "Changed"], { from: "user" });
    expect(process.exitCode).toBe(2);
    expect(tree(p.dir)).toEqual(before);
    expect(blocked.control).not.toHaveBeenCalled();
    expect(blocked.external).not.toHaveBeenCalled();
  },
);

it("config deletion after admission fails closed without default regeneration", async () => {
  const p = await ready();
  selectFixture(p);
  const actual =
    await vi.importActual<typeof import("../src/host-state.js")>("../src/host-state.js");
  vi.mocked(requireLinuxState).mockImplementationOnce((selected) => {
    actual.requireLinuxState(selected);
    rmSync(selected.config);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await program.parseAsync(["--json", "config", "set", "name", "Changed"], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(existsSync(p.config)).toBe(false);
});

it.each(["status", "install", "start", "stop", "restart", "uninstall", "enable", "disable"])(
  "Linux service %s reports manager failure without touching launchd or state",
  async (command) => {
    const p = resolveLinuxPaths(fixture().options);
    selectFixture(p);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["--json", "service", command], { from: "user" });
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).error).toMatch(
      /fixture systemd manager unavailable/,
    );
    expect(blocked.external).not.toHaveBeenCalled();
    expect(existsSync(p.dir)).toBe(false);
  },
);

it.each(["--version", "--help"])("%s needs no Linux machine or state selection", async (arg) => {
  const p = resolveLinuxPaths(fixture().options);
  selectFixture(p);
  vi.mocked(resolveLinuxPaths).mockImplementation(() => {
    throw new Error("selection must be lazy");
  });
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await expect(program.parseAsync([arg], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
  expect(existsSync(p.dir)).toBe(false);
});

it.each(["connected", "wrong-identity", "wrong-state", "unqualified-only", "missing-control"])(
  "Linux doctor checks authenticated foreground readiness: %s",
  async (kind) => {
    const p = await ready();
    const { fp } = readLinuxIdentity(p);
    rmSync(p.runtimeDir, { recursive: true });
    const before = tree(p.dir);
    const status = {
      controlVersion: 1,
      process: {
        pid: 123,
        agentVersion: "test",
        computerFp: kind === "wrong-identity" ? "a".repeat(64) : fp,
        stateDir: kind === "wrong-state" ? "/other" : p.dir,
        serviceInstance: null,
      },
      backends: [
        { name: "iterm2", connected: false },
        { name: "tmux", connected: kind !== "unqualified-only" },
        { name: "herdr", connected: kind === "unqualified-only" },
      ],
      terminalReady: true,
      relayOnline: true,
      sessions: 0,
      phones: [],
      connected: [],
    };
    const controlStatus = vi.fn(async () => {
      if (kind === "missing-control") throw new Error("absent");
      return status;
    });
    const checks = await runDoctor(
      {
        platform: "linux",
        env: {},
        defaultStateDir: "unused",
        requiredBackends: ["tmux", "herdr", "iterm2"],
      },
      {
        selectLinuxPaths: () => p,
        controlStatus,
        tmuxVersion: async () => "tmux 3.2",
        relayHealth: async () => true,
        inspectManager: blocked.external,
        checkHerdr: blocked.external,
        itermSocketExists: blocked.external,
      },
    );
    expect(controlStatus).toHaveBeenCalledWith(p.sock);
    expect(checks.find((c) => c.name === "control")?.ok).toBe(
      kind === "connected" || kind === "unqualified-only",
    );
    expect(checks.find((c) => c.name === "terminal readiness")?.ok).toBe(kind === "connected");
    expect(checks.find((c) => c.name === "herdr")?.severity).toBe("error");
    expect(checks.find((c) => c.name === "iterm2")?.severity).toBe("error");
    expect(checks.find((c) => c.name === "service manager")?.severity).toBe("warning");
    expect(tree(p.dir)).toEqual(before);
    expect(existsSync(p.runtimeDir)).toBe(false);
    expect(blocked.external).not.toHaveBeenCalled();
  },
);

it("Linux doctor turns selection failures into actionable content-free errors", async () => {
  const checks = await runDoctor(
    { platform: "linux", env: {}, defaultStateDir: "unused", requiredBackends: [] },
    {
      selectLinuxPaths: () => {
        throw new Error("private machine identifier");
      },
      inspectManager: blocked.external,
    },
  );
  expect(checks[0]).toMatchObject({
    name: "host state",
    severity: "error",
    fix: expect.stringMatching(/nonroot.*runtime/),
  });
  expect(JSON.stringify(checks)).not.toContain("private machine identifier");
  expect(blocked.external).not.toHaveBeenCalled();
});
