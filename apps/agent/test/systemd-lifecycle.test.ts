import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LocalStatus } from "../src/local-status.js";
import { ServiceOwnerStore } from "../src/service-ownership.js";
import type { SystemdManagerApi, SystemdObservation, SystemdVerb } from "../src/systemd-manager.js";
import { lifecycleFixture } from "./systemd-fixtures.js";

vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("unexpected process spawn");
  },
  exec: () => {
    throw new Error("unexpected exec");
  },
  execFile: () => {
    throw new Error("unexpected execFile");
  },
  execFileSync: () => {
    throw new Error("unexpected execFileSync");
  },
}));
vi.mock("../src/identity.js", () => ({
  readIdentity: () => {
    throw new Error("legacy identity read");
  },
  loadOrCreateIdentity: () => {
    throw new Error("identity creation");
  },
}));
vi.mock("../src/backends/registry.js", () => ({
  BACKEND_ORDER: ["iterm2", "tmux", "herdr"],
  BackendRegistry: class {
    constructor() {
      throw new Error("unexpected backend");
    }
  },
}));

async function fixture() {
  const f = await lifecycleFixture();
  const api = (await import("../src/systemd-lifecycle.js").catch(
    () => ({}),
  )) as typeof import("../src/systemd-lifecycle.js");
  expect(api.SystemdServiceLifecycle, "Linux lifecycle must exist").toBeTypeOf("function");
  const { parseSystemdUnit } = await import("../src/systemd-unit.js");
  const { resolveLinuxPaths } = await import("../src/host-paths.js");
  const calls: string[] = [];
  let now = 0;
  const state = {
    observation: {
      available: true,
      loadState: "not-found",
      activeState: "inactive",
      subState: "dead",
      mainPid: null,
      unitFileState: "disabled",
      fragmentPath: "",
      dropInPaths: "",
      needDaemonReload: false,
      conditionResult: true,
    } as SystemdObservation,
    local: null as LocalStatus | null,
    offline: false,
    probeCalls: 0,
    onExecute: undefined as undefined | ((verb: SystemdVerb) => void | Promise<void>),
    onObserve: undefined as undefined | (() => void),
  };
  function makeLocal(pid: number): LocalStatus {
    const def = parseSystemdUnit(readFileSync(f.location.definitionPath));
    return {
      controlVersion: 1,
      process: {
        pid,
        agentVersion: "fixture",
        computerFp: f.fp,
        stateDir: f.selected.dir,
        serviceInstance: def.serviceInstance,
      },
      backends: [
        { name: "iterm2", connected: false },
        { name: "tmux", connected: false },
        { name: "herdr", connected: false },
      ],
      terminalReady: false,
      relayOnline: false,
      sessions: 0,
      phones: [],
      connected: [],
    };
  }
  const manager: SystemdManagerApi = {
    observe: async () => {
      state.onObserve?.();
      return { ...state.observation };
    },
    linger: async () => "no",
    execute: async (verb) => {
      calls.push(verb);
      if (state.onExecute) return state.onExecute(verb);
      if (verb === "daemon-reload") {
        const installed = existsSync(f.location.definitionPath);
        state.observation.loadState = installed ? "loaded" : "not-found";
        state.observation.fragmentPath = installed ? f.location.definitionPath : "";
        state.observation.unitFileState = existsSync(f.location.enablementPath)
          ? "enabled"
          : "disabled";
      } else if (verb === "start") {
        const pid = (state.observation.mainPid ?? 120) + 1;
        Object.assign(state.observation, {
          activeState: "active",
          subState: "running",
          mainPid: pid,
        });
        state.local = makeLocal(pid);
      } else {
        Object.assign(state.observation, {
          activeState: "inactive",
          subState: "dead",
          mainPid: null,
        });
        state.local = null;
      }
    },
  };
  const options = {
    env: f.env,
    home: f.home,
    machine: f.machineOptions,
    manager,
    selectPaths: (env: NodeJS.ProcessEnv) => {
      if (env.SHELLBELL_DIR !== f.selected.dir || env.XDG_RUNTIME_DIR !== f.runtime)
        throw new Error("wrong selected paths");
      // Real validation still runs, while the admitted object itself is retained.
      resolveLinuxPaths({ ...f.hostOptions, env });
      return f.selected;
    },
    resolveRuntime: () => ({
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/shellbell/dist/cli.js",
      packageRoot: "/opt/shellbell",
    }),
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
    probe: async (sock: string) => {
      expect(sock).toBe(f.selected.sock);
      state.probeCalls++;
      if (state.local && !state.offline) return state.local;
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  };
  return {
    ...f,
    calls,
    state,
    options,
    makeLocal,
    lifecycle: new api.SystemdServiceLifecycle(options),
    make: () => new api.SystemdServiceLifecycle(options),
    parseSystemdUnit,
  };
}

describe("Linux systemd lifecycle", () => {
  it("refuses a desktop-owned host before starting a headless job", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    const owner = new ServiceOwnerStore({ stateDir: f.selected.dir, uid: process.getuid!() });
    await owner.mutate(owner.inspect()?.revision ?? null, async (tx) => {
      tx.publish({
        v: 1,
        mode: "desktop",
        consented: true,
        startupEnabled: false,
        transition: null,
      });
    });
    f.calls.length = 0;
    await expect(f.lifecycle.start()).rejects.toThrow(/desktop/i);
    expect(f.calls).toEqual([]);
  });
  it("status creates nothing and exposes no machine identity or raw private metadata", async () => {
    const f = await fixture();
    const before = readdirSync(f.runtime);
    const status = await f.lifecycle.status();
    expect(status).toMatchObject({
      manager: "systemd",
      installed: false,
      ready: false,
      enabled: false,
      ownership: "none",
    });
    expect(readdirSync(f.runtime)).toEqual(before);
    expect(existsSync(f.location.configRoot)).toBe(false);
    expect(JSON.stringify(status)).not.toContain(f.machine.machineId);
    expect(f.calls).toEqual([]);
  });
  it("separates install, enable, start, stop and disable while preserving credentials", async () => {
    const f = await fixture();
    const original = [f.selected.identity, f.selected.config, f.selected.pairings].map((path) =>
      readFileSync(path),
    );
    expect(await f.lifecycle.install()).toMatchObject({
      installed: true,
      enabled: false,
      ready: false,
    });
    expect(f.calls).toEqual(["daemon-reload"]);
    expect(existsSync(f.location.enablementPath)).toBe(false);
    expect(await f.lifecycle.enable()).toMatchObject({ enabled: true, ready: false });
    expect(f.calls).not.toContain("start");
    expect(await f.lifecycle.start()).toMatchObject({
      ready: true,
      enabled: true,
      managedPid: 121,
    });
    const stopped = await f.lifecycle.stop();
    expect(stopped).toMatchObject({ ready: false, enabled: true, startupEnabled: true });
    expect(stopped.diagnostic).toMatch(/enabled.*later|later.*enabled/);
    expect(readlinkSync(f.location.enablementPath)).toBe(f.location.definitionPath);
    await f.lifecycle.start();
    expect(await f.lifecycle.disable()).toMatchObject({ enabled: false, ready: true });
    expect(f.state.observation.activeState).toBe("active");
    [f.selected.identity, f.selected.config, f.selected.pairings].forEach((path, i) => {
      expect(readFileSync(path)).toEqual(original[i]);
    });
  });
  it("keeps active identical installs byte/inode/UUID stable and rejects active changes", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    const before = readFileSync(f.location.definitionPath);
    const ino = lstatSync(f.location.definitionPath).ino;
    f.calls.length = 0;
    await f.lifecycle.install();
    expect(readFileSync(f.location.definitionPath)).toEqual(before);
    expect(lstatSync(f.location.definitionPath).ino).toBe(ino);
    expect(f.calls).toEqual([]);
    f.options.resolveRuntime = () => ({
      nodePath: "/new/node",
      cliPath: "/new/cli.js",
      packageRoot: "/new",
    });
    await expect(f.make().install()).rejects.toThrow(/active|stop/);
    expect(readFileSync(f.location.definitionPath)).toEqual(before);
  });
  it("updates inactive definitions without losing explicit autostart and allocates a new instance", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    const old = f.parseSystemdUnit(readFileSync(f.location.definitionPath));
    f.options.resolveRuntime = () => ({
      nodePath: "/new/node",
      cliPath: "/new/cli.js",
      packageRoot: "/new",
    });
    await f.make().install();
    const current = f.parseSystemdUnit(readFileSync(f.location.definitionPath));
    expect(current.serviceInstance).not.toBe(old.serviceInstance);
    expect(current.nodePath).toBe("/new/node");
    expect(readlinkSync(f.location.enablementPath)).toBe(f.location.definitionPath);
    expect(f.calls).not.toContain("start");
  });
  it.each(["reload", "discovery"])("restores exact prior bytes on %s failure", async (failure) => {
    const f = await fixture();
    await f.lifecycle.install();
    const before = readFileSync(f.location.definitionPath);
    f.options.resolveRuntime = () => ({
      nodePath: "/new/node",
      cliPath: "/new/cli.js",
      packageRoot: "/new",
    });
    f.state.onExecute = () => {
      if (failure === "reload") throw new Error("STDERR_SENTINEL");
      f.state.observation.fragmentPath = "/foreign.service";
    };
    await expect(f.make().install()).rejects.toThrow();
    expect(readFileSync(f.location.definitionPath)).toEqual(before);
    expect(f.calls).not.toContain("start");
  });
  it("preserves an external replacement during rollback", async () => {
    const f = await fixture();
    f.state.onExecute = () => {
      renameSync(f.location.definitionPath, `${f.location.definitionPath}.saved`);
      writeFileSync(f.location.definitionPath, "FOREIGN_SENTINEL", { mode: 0o600 });
      throw new Error("STDERR_SENTINEL");
    };
    await expect(f.lifecycle.install()).rejects.toThrow(/recovery|unresolved/);
    expect(readFileSync(f.location.definitionPath, "utf8")).toBe("FOREIGN_SENTINEL");
  });
  it.each(["masked", "alias", "generated", "unknown"])(
    "refuses manager unit-file state %s before mutation",
    async (unitFileState) => {
      const f = await fixture();
      await f.lifecycle.install();
      f.calls.length = 0;
      f.state.observation.unitFileState = unitFileState;
      expect((await f.lifecycle.status()).ready).toBe(false);
      await expect(f.lifecycle.start()).rejects.toThrow();
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    { fragmentPath: "/foreign.service" },
    { dropInPaths: "/override.conf" },
    { needDaemonReload: true },
    { available: false },
  ])("refuses conflicting manager observations %j", async (change) => {
    const f = await fixture();
    await f.lifecycle.install();
    f.calls.length = 0;
    Object.assign(f.state.observation, change);
    await expect(f.lifecycle.start()).rejects.toThrow();
    expect((await f.lifecycle.status()).ready).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it("reports external enablement and leaves unrelated links and a running job intact", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    await f.lifecycle.start();
    const other = join(dirname(f.location.enablementPath), "external.service");
    symlinkSync(f.location.definitionPath, other);
    f.state.onExecute = () => {
      f.state.observation.unitFileState = "enabled";
    };
    const result = await f.lifecycle.disable();
    expect(result).toMatchObject({ enabled: true, autostartConfigured: false, ready: true });
    expect(result.diagnostic).toMatch(/external/);
    expect(readlinkSync(other)).toBe(f.location.definitionPath);
    expect(f.calls).not.toContain("stop");
  });
  it("requires current MainPID ownership even for offline-relay local readiness", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    expect((await f.lifecycle.status()).ready).toBe(true);
    f.state.observation.mainPid = 999;
    expect(await f.lifecycle.status()).toMatchObject({ ready: false, ownership: "foreign" });
    f.calls.length = 0;
    await expect(f.lifecycle.stop()).rejects.toThrow(/foreign|ownership/);
    expect(f.calls).toEqual([]);
  });
  it("cleans up an owned job created by a timed-out start without replaying start", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.onExecute = (verb) => {
      if (verb === "start") {
        Object.assign(f.state.observation, {
          activeState: "active",
          subState: "running",
          mainPid: 456,
        });
        f.state.local = f.makeLocal(456);
        throw new Error("STDERR_SENTINEL");
      }
      if (verb === "stop") {
        Object.assign(f.state.observation, {
          activeState: "inactive",
          subState: "dead",
          mainPid: null,
        });
        f.state.local = null;
      }
    };
    await expect(f.lifecycle.start()).rejects.toThrow(/start/);
    expect(f.calls).toEqual(["daemon-reload", "start", "stop"]);
    expect(f.state.observation.activeState).toBe("inactive");
  });
  it("does not stop a replacement job discovered during start failure cleanup", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.onExecute = () => {
      Object.assign(f.state.observation, {
        activeState: "active",
        subState: "running",
        mainPid: 456,
      });
      f.state.local = f.makeLocal(999);
      throw new Error("STDERR_SENTINEL");
    };
    await expect(f.lifecycle.start()).rejects.toThrow(/unresolved|ownership/);
    expect(f.calls).not.toContain("stop");
  });
  it("re-observes manager ownership during readiness and refuses changing jobs", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.onExecute = () => {
      Object.assign(f.state.observation, {
        activeState: "active",
        subState: "running",
        mainPid: 456,
      });
      f.state.local = f.makeLocal(456);
    };
    let probes = 0;
    f.options.probe = async () => {
      probes++;
      f.state.observation.mainPid = 999;
      return f.makeLocal(456);
    };
    await expect(f.make().start()).rejects.toThrow();
    expect(probes).toBeGreaterThan(0);
    expect(f.calls).not.toContain("stop");
  });
  it("revokes with corrupt credentials but refuses a positively foreign endpoint", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    writeFileSync(f.selected.identity, "CORRUPT_SECRET");
    const result = await f.lifecycle.stop();
    expect(result.ownership).toBe("degraded");
    expect(readFileSync(f.selected.identity, "utf8")).toBe("CORRUPT_SECRET");
    expect(JSON.stringify(result)).not.toContain("CORRUPT_SECRET");
    Object.assign(f.state.observation, {
      activeState: "active",
      subState: "running",
      mainPid: 456,
    });
    f.state.local = f.makeLocal(999);
    f.calls.length = 0;
    await expect(f.lifecycle.stop()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("unsafe runtime permits exact manager revocation only and reports remaining files", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    await f.lifecycle.start();
    chmodSync(f.runtime, 0o755);
    const probes = f.state.probeCalls;
    const result = await f.lifecycle.uninstall();
    expect(result.ownership).toBe("degraded");
    expect(result.diagnostic).toMatch(/cleanup|remain/);
    expect(f.state.probeCalls).toBe(probes);
    expect(existsSync(f.location.definitionPath)).toBe(true);
    expect(readlinkSync(f.location.enablementPath)).toBe(f.location.definitionPath);
  });
  it("uninstall stops first, preserves identity, and never resurrects a failed stop", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    await f.lifecycle.start();
    f.calls.length = 0;
    f.state.onExecute = () => {
      throw new Error("STDERR_SENTINEL");
    };
    await expect(f.lifecycle.uninstall()).rejects.toThrow(/stop/);
    expect(f.calls).toEqual(["stop"]);
    expect(existsSync(f.location.definitionPath)).toBe(true);
    f.state.onExecute = undefined;
    f.calls.length = 0;
    await f.lifecycle.uninstall();
    expect(f.calls[0]).toBe("stop");
    expect(existsSync(f.location.definitionPath)).toBe(false);
    expect(existsSync(f.location.enablementPath)).toBe(false);
    expect(existsSync(f.selected.identity)).toBe(true);
  });
  it("does not admit access-granting operations with missing or corrupt state", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    unlinkSync(f.selected.identity);
    f.calls.length = 0;
    for (const operation of ["install", "enable", "start", "restart"] as const)
      await expect(f.lifecycle[operation]()).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(existsSync(f.selected.identity)).toBe(false);
  });
  it("installs when an absent manager unit has empty UnitFileState", async () => {
    const f = await fixture();
    f.state.observation.unitFileState = "";
    expect(await f.lifecycle.install()).toMatchObject({ installed: true, enabled: false });
  });
  it("does not confuse a linked definition with autostart enablement", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.observation.unitFileState = "linked";
    expect(await f.lifecycle.status()).toMatchObject({
      enabled: false,
      autostartConfigured: false,
    });
  });
  it("cleans up a newly started owned job whose local endpoint never appeared", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.offline = true;
    await expect(f.lifecycle.start()).rejects.toThrow(/start/);
    expect(f.calls).toEqual(["daemon-reload", "start", "stop"]);
  });
  it("pins the first manager job across readiness polling and never cleans up a replacement", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    let afterStart = false;
    f.state.onExecute = (verb) => {
      if (verb === "start") {
        afterStart = true;
        Object.assign(f.state.observation, {
          activeState: "active",
          subState: "running",
          mainPid: 456,
        });
      }
    };
    f.options.clock.sleep = async () => {
      if (afterStart) {
        f.state.observation.mainPid = 999;
        f.state.local = f.makeLocal(999);
      }
    };
    await expect(f.make().start()).rejects.toThrow(/unresolved|ownership/);
    expect(f.calls).not.toContain("stop");
  });
  it("waits for the same endpoint to disappear after manager MainPID becomes zero", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    f.state.onExecute = () => {
      Object.assign(f.state.observation, {
        activeState: "inactive",
        subState: "dead",
        mainPid: null,
      });
    };
    const sleep = f.options.clock.sleep;
    f.options.clock.sleep = async (ms) => {
      f.state.local = null;
      await sleep(ms);
    };
    expect(await f.make().stop()).toMatchObject({ ready: false, activeState: "inactive" });
  });
  it("does not issue start after another job becomes active during its initial probe", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.options.probe = async () => {
      Object.assign(f.state.observation, {
        activeState: "active",
        subState: "running",
        mainPid: 999,
      });
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    };
    await expect(f.make().start()).rejects.toThrow();
    expect(f.calls).toEqual(["daemon-reload"]);
  });
  it("does not report readiness after a definition is replaced during its local probe", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    f.options.probe = async () => {
      writeFileSync(f.location.definitionPath, "REPLACED_PRIVATE_SENTINEL");
      return f.state.local!;
    };
    expect(await f.make().status()).toMatchObject({ ready: false, ownership: "foreign" });
  });
  it("does not echo malformed endpoint state paths during degraded revocation", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    writeFileSync(f.selected.identity, "corrupt");
    f.state.local!.process.stateDir = "/PRIVATE_SENTINEL\u0000";
    const error = await f.lifecycle.stop().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("PRIVATE_SENTINEL");
    expect(f.calls).not.toContain("stop");
  });
  it("rejects readiness when the manager condition changes after the local probe", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    f.options.probe = async () => {
      f.state.observation.conditionResult = false;
      return f.state.local!;
    };
    expect((await f.make().status()).ready).toBe(false);
  });
  it("stops an exact owned job even when the autostart leaf was replaced, preserving the foreign leaf", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    await f.lifecycle.start();
    unlinkSync(f.location.enablementPath);
    symlinkSync("/FOREIGN_LINK_SENTINEL", f.location.enablementPath);
    const result = await f.lifecycle.stop();
    expect(result.ready).toBe(false);
    expect(result.autostartConfigured).toBe(false);
    expect(result.diagnostic).toMatch(/foreign|external/);
    expect(result.diagnostic).not.toContain("FOREIGN_LINK_SENTINEL");
    expect(readlinkSync(f.location.enablementPath)).toBe("/FOREIGN_LINK_SENTINEL");
    await f.lifecycle.uninstall();
    expect(existsSync(f.location.definitionPath)).toBe(false);
    expect(readlinkSync(f.location.enablementPath)).toBe("/FOREIGN_LINK_SENTINEL");
  });
  it("restores owned enablement after enable reload failure without starting a job", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.onExecute = () => {
      throw new Error("STDERR_SENTINEL");
    };
    const error = await f.lifecycle.enable().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("STDERR_SENTINEL");
    expect(existsSync(f.location.enablementPath)).toBe(false);
    expect(f.calls).not.toContain("start");
  });
  it("keeps a requested disable after reload failure and reports cleanup failure after start timeout", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    f.state.onExecute = () => {
      throw new Error("STDERR_SENTINEL");
    };
    await expect(f.lifecycle.disable()).rejects.toThrow(/disable/);
    expect(existsSync(f.location.enablementPath)).toBe(false);
    f.state.onExecute = (verb) => {
      if (verb === "start") {
        Object.assign(f.state.observation, {
          activeState: "active",
          subState: "running",
          mainPid: 456,
        });
        f.state.local = f.makeLocal(456);
      }
      throw new Error("STDERR_SENTINEL");
    };
    await expect(f.lifecycle.start()).rejects.toThrow(/cleanup.*unresolved/);
    expect(f.state.observation.activeState).toBe("active");
  });
  it("refuses a foreign autostart leaf when enabling and reports it when disabling", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    unlinkSync(f.location.enablementPath);
    symlinkSync("/foreign", f.location.enablementPath);
    f.calls.length = 0;
    await expect(f.lifecycle.enable()).rejects.toThrow(/foreign/);
    expect((await f.lifecycle.disable()).diagnostic).toMatch(/foreign|external/i);
    expect(readlinkSync(f.location.enablementPath)).toBe("/foreign");
    expect(f.calls).toEqual([]);
  });
  it("does not return successful start if readiness disappears during final confirmation", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    let probes = 0;
    const probe = f.options.probe;
    f.options.probe = async (sock) => {
      probes++;
      if (probes >= 3) f.state.offline = true;
      return probe(sock);
    };
    await expect(f.make().start()).rejects.toThrow(/start/);
    expect(f.calls).toEqual(["daemon-reload", "start", "stop"]);
  });
  it("persists an inactive runtime update and subsequently uses that exact stored runtime", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    const { resolveLinuxPaths } = await import("../src/host-paths.js");
    const root = join(f.root, "new-runtime");
    mkdirSync(root, { mode: 0o700 });
    f.env.XDG_RUNTIME_DIR = root;
    let admitted = f.selected;
    f.options.selectPaths = (env) => {
      admitted = resolveLinuxPaths({ ...f.hostOptions, env });
      return admitted;
    };
    f.options.probe = async (sock) => {
      expect(sock).toBe(admitted.sock);
      if (f.state.local) return f.state.local;
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    };
    await f.make().install();
    expect(f.parseSystemdUnit(readFileSync(f.location.definitionPath)).runtimeRoot).toBe(root);
    f.env.XDG_RUNTIME_DIR = "/forbidden-caller-runtime";
    expect(await f.make().start()).toMatchObject({ ready: true });
    expect(admitted.runtimeDir.startsWith(`${root}/`)).toBe(true);
  });
  it("refuses explicit conflicting state and serializes mutations in a separate local lifecycle guard", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    const { acquireControlGuard } = await import("../src/control-guard.js");
    const release = acquireControlGuard(join(f.selected.runtimeDir, "service"));
    f.calls.length = 0;
    try {
      await expect(f.lifecycle.start()).rejects.toThrow(/busy/);
    } finally {
      release();
    }
    f.env.SHELLBELL_DIR = join(f.root, "conflicting-state");
    await expect(f.make().start()).rejects.toThrow(/conflicts/);
    expect(f.calls).toEqual([]);
    expect(existsSync(f.env.SHELLBELL_DIR)).toBe(false);
  });
  it("refuses an inactive update if the manager starts a job during the local probe", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    const before = readFileSync(f.location.definitionPath);
    f.options.resolveRuntime = () => ({
      nodePath: "/new/node",
      cliPath: "/new/cli.js",
      packageRoot: "/new",
    });
    f.options.probe = async () => {
      Object.assign(f.state.observation, {
        activeState: "active",
        subState: "running",
        mainPid: 999,
      });
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    };
    await expect(f.make().install()).rejects.toThrow(/active|changed|stop/);
    expect(readFileSync(f.location.definitionPath)).toEqual(before);
  });
  it("does not rewrite a running definition when rolling back only an enablement link", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    await f.lifecycle.start();
    const ino = lstatSync(f.location.definitionPath).ino;
    f.state.onExecute = () => {
      throw new Error("reload failure");
    };
    await expect(f.lifecycle.enable()).rejects.toThrow();
    expect(lstatSync(f.location.definitionPath).ino).toBe(ino);
    expect(f.state.observation.activeState).toBe("active");
  });
  it.each([
    ["stop", "already-inactive"],
    ["uninstall", "already-inactive"],
    ["stop", "post-stop"],
    ["uninstall", "post-stop"],
  ] as const)(
    "%s rejects replacement during %s absence probing and preserves owned files",
    async (operation, stage) => {
      const f = await fixture();
      await f.lifecycle.install();
      await f.lifecycle.enable();
      if (stage === "post-stop") await f.lifecycle.start();
      const original = readFileSync(f.location.definitionPath);
      let probes = 0;
      let replaced = false;
      const probe = f.options.probe;
      f.options.probe = async (sock) => {
        probes++;
        if (
          (stage === "already-inactive" && probes === 2) ||
          (stage === "post-stop" && f.calls.includes("stop"))
        ) {
          replaced = true;
          Object.assign(f.state.observation, {
            activeState: "active",
            subState: "running",
            mainPid: 999,
          });
          f.state.local = f.makeLocal(999);
          throw Object.assign(new Error("absent"), { code: "ENOENT" });
        }
        return probe(sock);
      };
      f.calls.length = 0;
      await expect(f.make()[operation]()).rejects.toThrow(/stop|ownership|changed|unresolved/);
      expect(replaced).toBe(true);
      expect(readFileSync(f.location.definitionPath)).toEqual(original);
      expect(readlinkSync(f.location.enablementPath)).toBe(f.location.definitionPath);
      expect(f.calls).not.toContain("start");
    },
  );
  it.each(["replacement", "unavailable", "overridden"])(
    "stop rejects %s manager state during final result confirmation",
    async (change) => {
      const f = await fixture();
      await f.lifecycle.install();
      await f.lifecycle.start();
      let afterStopProbes = 0;
      const probe = f.options.probe;
      f.options.probe = async (sock) => {
        if (f.calls.includes("stop") && ++afterStopProbes === 2) {
          if (change === "replacement")
            Object.assign(f.state.observation, {
              activeState: "active",
              subState: "running",
              mainPid: 999,
            });
          if (change === "unavailable") f.state.observation.available = false;
          if (change === "overridden") f.state.observation.dropInPaths = "/foreign.conf";
        }
        return probe(sock);
      };
      await expect(f.make().stop()).rejects.toThrow(/stop|unresolved|confirmation/);
      expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
    },
  );
  it("does not claim failed-start cleanup succeeded after a replacement appears during absence probing", async () => {
    const f = await fixture();
    await f.lifecycle.install();
    f.state.onExecute = () => {
      throw new Error("command timeout");
    };
    const probe = f.options.probe;
    f.options.probe = async (sock) => {
      if (f.calls.includes("start")) {
        Object.assign(f.state.observation, {
          activeState: "active",
          subState: "running",
          mainPid: 999,
        });
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      }
      return probe(sock);
    };
    await expect(f.make().start()).rejects.toThrow(/cleanup remains unresolved/);
    expect(f.calls).not.toContain("stop");
  });
  it("keeps absolute caller PATH entries in Node-first defaults-last order without empty, relative or duplicate entries", async () => {
    const f = await fixture();
    f.env.PATH =
      "/usr/bin:/home/user/.local/bin::relative/bin:/opt/node/bin:/bin:./local:/extra/bin:/usr/local/bin:/home/user/.local/bin";
    f.env.ITERM2_COOKIE = "PRIVATE_ENV_SENTINEL";
    await f.make().install();
    const raw = readFileSync(f.location.definitionPath);
    expect(f.parseSystemdUnit(raw).path).toBe(
      "/opt/node/bin:/home/user/.local/bin:/extra/bin:/usr/local/bin:/usr/bin:/bin",
    );
    expect(raw.toString("utf8")).not.toContain("PRIVATE_ENV_SENTINEL");
    const ino = lstatSync(f.location.definitionPath).ino;
    await f.make().install();
    expect(lstatSync(f.location.definitionPath).ino).toBe(ino);
  });
  it.each([
    "/custom\nbin",
    "/custom\tbin",
    "/custom\u007fbin",
    "/custom\u0085bin",
    "/custom\ud800bin",
  ])("rejects unsafe persisted Linux PATH text %j before publishing a unit", async (entry) => {
    const f = await fixture();
    f.env.PATH = `${entry}:/usr/bin`;
    await expect(f.make().install()).rejects.toThrow(/invalid|foreign/);
    expect(existsSync(f.location.definitionPath)).toBe(false);
    expect(f.calls).toEqual([]);
  });
});
