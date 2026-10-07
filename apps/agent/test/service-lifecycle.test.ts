import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgent } from "../src/cli.js";
import { paths } from "../src/config.js";
import { controlRequest } from "../src/control.js";
import { loadOrCreateIdentity, readIdentity } from "../src/identity.js";
import type { LocalStatus } from "../src/local-status.js";
import { createLogger } from "../src/log.js";
import {
  ServiceLifecycle,
  selectServicePaths,
  withServiceDefinitionGuard,
} from "../src/service-lifecycle.js";
import type { ServiceDefinition, ServiceManager, ServiceSnapshot } from "../src/service-manager.js";
import { ServiceOwnerStore } from "../src/service-ownership.js";
import { resolveServiceRuntime } from "../src/service-runtime.js";

const identityReadFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === identityReadFailure.path)
        throw Object.assign(new Error("PRIVATE_READ_ERROR"), { code: "EACCES" });
      return fs.readFileSync(...args);
    },
  };
});
vi.mock("../src/service-runtime.js", () => ({
  resolveServiceRuntime: vi.fn(() => ({
    nodePath: "/durable/node",
    cliPath: "/durable/shellbell/dist/cli.js",
    packageRoot: "/durable/shellbell",
  })),
}));
const INSTANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
const dirs: string[] = [];
afterEach(() => {
  identityReadFailure.path = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeManager implements ServiceManager {
  startupEnabled = true;
  readonly kind = "launchd" as const;
  events: string[] = [];
  pid = 100;
  current: ServiceSnapshot;
  original: ServiceDefinition;
  failNew = false;
  constructor(
    readonly definitionPath: string,
    definition: ServiceDefinition,
    loaded = true,
  ) {
    this.original = definition;
    this.current = { installed: true, loaded, definition, raw: Buffer.from("EXACT OLD BYTES") };
  }
  async inspect() {
    return {
      ...this.current,
      startupEnabled: this.current.installed ? this.startupEnabled : false,
    };
  }
  async setStartupEnabled(enabled: boolean) {
    this.events.push(`startup:${enabled}`);
    this.startupEnabled = enabled;
  }
  async write(definition: ServiceDefinition) {
    this.events.push("write-new");
    this.current = { installed: true, loaded: false, definition, raw: Buffer.from("NEW") };
  }
  async restore(raw: Buffer | null) {
    this.events.push(raw ? "restore-old" : "remove-new");
    this.current = {
      installed: raw !== null,
      loaded: false,
      raw,
      definition: raw ? this.original : null,
    };
  }
  async load() {
    const old = this.current.definition === this.original;
    this.events.push(old ? "load-old" : "load-new");
    if (!this.current.loaded) this.pid++;
    this.current.loaded = true;
    if (this.failNew && !old) throw new Error("bootstrap failed");
    return this.pid;
  }
  async unload() {
    this.events.push(this.current.definition === this.original ? "unload-old" : "unload-new");
    this.current.loaded = false;
  }
}
function fixture(loaded = true) {
  const dir = mkdtempSync(join(tmpdir(), "sb-lifecycle-"));
  dirs.push(dir);
  const p = paths(join(dir, "state"));
  const { fp } = loadOrCreateIdentity(p);
  const definition: ServiceDefinition = {
    nodePath: "/old/node",
    cliPath: "/old/dist/cli.js",
    stateDir: p.dir,
    serviceInstance: INSTANCE,
    environment: { SHELLBELL_DIR: p.dir },
    logPath: p.log,
  };
  mkdirSync(join(dir, "LaunchAgents"));
  const manager = new FakeManager(join(dir, "LaunchAgents", "shellbell.plist"), definition, loaded);
  let now = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const local = (): LocalStatus => ({
    controlVersion: 1,
    process: {
      pid: manager.pid,
      agentVersion: "test",
      computerFp: fp,
      stateDir: p.dir,
      serviceInstance: manager.current.definition?.serviceInstance ?? null,
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
  });
  const probe = vi.fn(async () => {
    if (!manager.current.loaded) throw absent();
    return local();
  });
  const options = { manager, defaultStateDir: join(dir, "unused"), env: {}, clock, probe };
  return { p, manager, local, probe, options, clock, controller: new ServiceLifecycle(options) };
}
describe("transactional service lifecycle", () => {
  it.each([null, INSTANCE])(
    "starts a supervised child under its parent's ownership lock with instance %s",
    async (serviceInstance) => {
      const f = fixture(false);
      f.manager.original.serviceInstance = serviceInstance;
      let child: Awaited<ReturnType<typeof buildAgent>> | undefined;
      f.manager.load = async () => {
        const deps = {
          paths: f.p,
          serviceInstance,
          managedService: true,
          itermBackend: null,
          startHerdr: () => ({ stop() {} }),
          tmuxBackendOptions: {
            execImpl: async () => {
              throw new Error("no tmux in fixture");
            },
          },
        };
        child = await buildAgent(createLogger({ stdout: false }), undefined, false, deps);
        await child.control.start();
        f.manager.current.loaded = true;
        f.manager.pid = process.pid;
        return f.manager.pid;
      };
      const controller = new ServiceLifecycle({
        ...f.options,
        probe: (sock, timeoutMs) =>
          controlRequest(sock, "status", undefined, { timeoutMs, maxResponseBytes: 64 * 1024 }),
      });
      try {
        const result = await controller.start();
        expect(result).toMatchObject({
          ready: true,
          ownership: "verified",
          managedPid: process.pid,
          local: { process: { serviceInstance } },
        });
      } finally {
        if (child) {
          child.stopBackendDetectors();
          await child.control.stop();
          child.agent.stop();
        }
      }
    },
  );

  it("stops now without changing observed future startup and can disable without stopping", async () => {
    const f = fixture();
    expect((await f.controller.status()).startupEnabled).toBe(true);
    await f.controller.stop();
    expect((await f.controller.status()).startupEnabled).toBe(true);
    await f.controller.start();
    const pid = f.manager.pid;
    await f.controller.disable();
    expect(f.manager.current.loaded).toBe(true);
    expect(f.manager.pid).toBe(pid);
    expect((await f.controller.status()).startupEnabled).toBe(false);
  });
  it("reports disabled future startup independently of an installed and running service", async () => {
    const f = fixture();
    expect(await f.controller.disable()).toMatchObject({
      installed: true,
      loaded: true,
      startupEnabled: false,
      autostartConfigured: false,
    });
    expect(await f.controller.status()).toMatchObject({ autostartConfigured: false, ready: true });
    expect(await f.controller.enable()).toMatchObject({
      installed: true,
      loaded: true,
      startupEnabled: true,
      autostartConfigured: true,
    });
  });
  it("refuses headless mutations of a desktop-owned state directory", async () => {
    const f = fixture();
    const owner = new ServiceOwnerStore({
      stateDir: realpathSync(f.p.dir),
      uid: process.getuid!(),
    });
    await owner.mutate(null, async (tx) => {
      tx.publish({
        v: 1,
        mode: "desktop",
        consented: true,
        startupEnabled: false,
        transition: null,
      });
    });
    await expect(f.controller.stop()).rejects.toThrow(/desktop/i);
    expect(f.manager.events).toEqual([]);
    expect(f.manager.current.loaded).toBe(true);
  });
  it("shares the definition guard while preserving non-install absent-parent behavior", async () => {
    const f = fixture(false);
    const parent = join(f.p.dir, "absent-LaunchAgents");
    const manager = new FakeManager(
      join(parent, "sh.bilal.shellbell.plist"),
      f.manager.original,
      false,
    );
    await withServiceDefinitionGuard(manager, false, async () => {
      expect(existsSync(parent)).toBe(false);
    });
    await withServiceDefinitionGuard(manager, true, async () => {
      expect(existsSync(`${manager.definitionPath}.lock`)).toBe(true);
      const lifecycle = new ServiceLifecycle({ ...f.options, manager });
      await expect(lifecycle.stop()).rejects.toThrow("busy");
    });
    expect(existsSync(`${manager.definitionPath}.lock`)).toBe(false);
  });
  describe.each(["malformed", "unreadable"] as const)("%s identity", (damage) => {
    function damagedFixture() {
      const f = fixture();
      if (damage === "malformed") writeFileSync(f.p.identity, '{"PRIVATE_IDENTITY_SENTINEL"');
      const identityBytes = readFileSync(f.p.identity);
      if (damage === "unreadable") identityReadFailure.path = realpathSync(f.p.identity);
      return { ...f, identityBytes };
    }
    function expectIdentityPreserved(f: ReturnType<typeof damagedFixture>) {
      identityReadFailure.path = undefined;
      expect(readFileSync(f.p.identity)).toEqual(f.identityBytes);
    }
    it.each([
      ["stop", "absent"],
      ["stop", "unresponsive"],
      ["uninstall", "absent"],
      ["uninstall", "unresponsive"],
    ] as const)(
      "%s unloads the exact job with an %s endpoint without repairing identity",
      async (command, endpoint) => {
        const f = damagedFixture();
        const events: string[] = [];
        const unload = f.manager.unload.bind(f.manager);
        f.manager.unload = async () => {
          events.push("unload");
          await unload();
        };
        const restore = f.manager.restore.bind(f.manager);
        f.manager.restore = async (raw) => {
          events.push("remove");
          await restore(raw);
        };
        f.probe.mockImplementation(async () => {
          if (f.manager.current.loaded && endpoint === "unresponsive") throw new Error("timeout");
          events.push("endpoint-absent");
          throw absent();
        });
        const result = await f.controller[command]();
        expect(result).toMatchObject({
          ready: false,
          loaded: false,
          installed: command === "stop",
        });
        expect(result.diagnostic).toMatch(/invalid identity|cannot read identity/);
        expect(result.diagnostic).not.toMatch(/PRIVATE_|identity is missing/);
        expect(f.manager.events).toEqual(
          command === "stop" ? ["unload-old"] : ["unload-old", "remove-new"],
        );
        const stopped = events.indexOf("endpoint-absent", events.indexOf("unload") + 1);
        expect(stopped).toBeGreaterThan(events.indexOf("unload"));
        if (command === "uninstall") expect(events.indexOf("remove")).toBeGreaterThan(stopped);
        else expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
        expectIdentityPreserved(f);
      },
    );
    it.each(["install", "start", "restart", "status"] as const)(
      "%s rejects the identity error before manager mutations or readiness certification",
      async (command) => {
        const f = damagedFixture();
        await expect(f.controller[command]()).rejects.toThrow(
          /invalid identity|cannot read identity/,
        );
        expect(f.manager.events).toEqual([]);
        expect(f.manager.current.loaded).toBe(true);
        expect(f.probe).not.toHaveBeenCalled();
        expectIdentityPreserved(f);
      },
    );
    it.each(["stop", "uninstall"] as const)(
      "%s refuses a responsive endpoint that cannot be certified",
      async (command) => {
        const f = damagedFixture();
        f.probe.mockImplementation(async () => ({
          ...f.local(),
          process: { ...f.local().process, serviceInstance: null },
        }));
        await expect(f.controller[command]()).rejects.toThrow(/foreign|foreground/);
        expect(f.manager.events).toEqual([]);
        expectIdentityPreserved(f);
      },
    );
    it("uninstall retains the definition when the endpoint stays unresponsive after unload", async () => {
      const f = damagedFixture();
      f.probe.mockRejectedValue(new Error("timeout"));
      await expect(f.controller.uninstall()).rejects.toThrow(/stop timed out/);
      expect(f.manager.events).toEqual(["unload-old"]);
      expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
      expect(f.clock.now()).toBe(10_000);
      expectIdentityPreserved(f);
    });
    it("uninstall retains the definition when exact-job unload fails", async () => {
      const f = damagedFixture();
      f.probe.mockRejectedValue(absent());
      f.manager.unload = async () => {
        throw new Error("unload denied");
      };
      await expect(f.controller.uninstall()).rejects.toThrow(/unload denied/);
      expect(f.manager.current.loaded).toBe(true);
      expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
      expect(f.manager.events).toEqual([]);
      expectIdentityPreserved(f);
    });
  });
  it("rejects invalid persisted CLI text on first install before creating state or the guard parent", async () => {
    const f = fixture(false);
    const stateDir = join(f.p.dir, "not-created-state");
    const manager = new FakeManager(
      join(f.p.dir, "not-created-agents", "service.plist"),
      f.manager.original,
      false,
    );
    manager.current = { installed: false, loaded: false, definition: null, raw: null };
    const controller = new ServiceLifecycle({ ...f.options, manager, requestedStateDir: stateDir });
    vi.mocked(resolveServiceRuntime).mockReturnValueOnce({
      nodePath: "/durable/node",
      cliPath: "/durable/PRIVATE_SENTINEL\u0001/dist/cli.js",
      packageRoot: "/durable/package",
    });
    await expect(controller.install()).rejects.toMatchObject({
      rollback: "not-needed",
      message: "invalid XML character in service definition",
    });
    expect(manager.events).toEqual([]);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(join(f.p.dir, "not-created-agents"))).toBe(false);
  });
  it("rejects invalid persisted CLI text on update before any manager or identity/log mutation", async () => {
    const f = fixture();
    const keys = readFileSync(f.p.identity);
    writeFileSync(f.p.log, "prior log", { mode: 0o644 });
    vi.mocked(resolveServiceRuntime).mockReturnValueOnce({
      nodePath: "/durable/node",
      cliPath: "/durable/PRIVATE_SENTINEL\u0001/dist/cli.js",
      packageRoot: "/durable/package",
    });
    await expect(f.controller.install()).rejects.toMatchObject({
      rollback: "not-needed",
      message: "invalid XML character in service definition",
    });
    expect(f.manager.events).toEqual([]);
    expect(f.manager.current.loaded).toBe(true);
    expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
    expect(readFileSync(f.p.identity)).toEqual(keys);
    expect(readFileSync(f.p.log, "utf8")).toBe("prior log");
    expect(statSync(f.p.log).mode & 0o777).toBe(0o644);
  });
  it.each(["install", "restart"] as const)(
    "%s restores prior loaded state when unload succeeds but verification throws",
    async (command) => {
      const f = fixture();
      const keys = readFileSync(f.p.identity);
      const unload = f.manager.unload.bind(f.manager);
      f.manager.unload = async () => {
        await unload();
        throw new Error("unload verification failed");
      };
      await expect(f.controller[command]()).rejects.toMatchObject({
        message: "unload verification failed",
        rollback: "restored",
      });
      expect(f.manager.current.loaded).toBe(true);
      expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
      expect(f.manager.events).toEqual(["unload-old", "load-old"]);
      expect(readFileSync(f.p.identity)).toEqual(keys);
    },
  );
  it.each(["install", "restart"] as const)(
    "%s preserves separate recovery failure after a partially completed unload",
    async (command) => {
      const f = fixture();
      const unload = f.manager.unload.bind(f.manager);
      f.manager.unload = async () => {
        await unload();
        throw new Error("unload verification failed");
      };
      f.manager.load = async () => {
        throw new Error("recovery load failed");
      };
      let failure: unknown;
      try {
        await f.controller[command]();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        message: "unload verification failed",
        rollback: "failed",
        rollbackDiagnostic: "recovery load failed",
      });
      const recoveryPath = (failure as { recoveryPath: string }).recoveryPath;
      expect(readFileSync(recoveryPath)).toEqual(Buffer.from("EXACT OLD BYTES"));
      expect(statSync(recoveryPath).mode & 0o777).toBe(0o600);
      expect(f.manager.current.loaded).toBe(false);
      expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
    },
  );
  it.each(["foreign", "unknown"] as const)(
    "does not reload after uncertain unload while an %s endpoint may remain",
    async (owner) => {
      const f = fixture();
      const unload = f.manager.unload.bind(f.manager);
      let attempted = false;
      f.manager.unload = async () => {
        await unload();
        attempted = true;
        throw new Error("unload verification failed");
      };
      f.probe.mockImplementation(async () => {
        if (!attempted) return f.local();
        if (owner === "unknown") throw new Error("timed out");
        return { ...f.local(), process: { ...f.local().process, pid: 999, serviceInstance: null } };
      });
      await expect(f.controller.restart()).rejects.toMatchObject({
        message: "unload verification failed",
        rollback: "failed",
        rollbackDiagnostic: expect.stringContaining("stop timed out"),
      });
      expect(f.manager.events).toEqual(["unload-old"]);
      expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
    },
  );
  it("first install creates one identity and leaves it recoverable after failed launch", async () => {
    const f = fixture(false);
    unlinkSync(f.p.identity);
    f.manager.current = { installed: false, loaded: false, definition: null, raw: null };
    f.manager.failNew = true;
    const controller = new ServiceLifecycle({ ...f.options, requestedStateDir: f.p.dir });
    await expect(controller.install()).rejects.toMatchObject({ rollback: "restored" });
    expect(existsSync(f.p.identity)).toBe(true);
    expect(f.manager.current.installed).toBe(false);
    expect(f.manager.events).toEqual(["write-new", "load-new", "unload-new", "remove-new"]);
  });
  it("first install certifies the new identity and persists only allowed environment", async () => {
    const f = fixture(false);
    unlinkSync(f.p.identity);
    f.manager.current = { installed: false, loaded: false, definition: null, raw: null };
    f.probe.mockImplementation(async () => {
      if (!f.manager.current.loaded) throw absent();
      return { ...f.local(), process: { ...f.local().process, computerFp: readIdentity(f.p)!.fp } };
    });
    const controller = new ServiceLifecycle({
      ...f.options,
      requestedStateDir: f.p.dir,
      env: {
        HERDR_SESSION: "transient",
        PRIVATE_SENTINEL: "secret",
        HERDR_SOCKET_PATH: "/owned/herdr.sock",
        XDG_CONFIG_HOME: "/owned/config",
      },
    });
    expect(await controller.install()).toMatchObject({ ready: true, managedPid: 101 });
    expect(f.manager.current.definition?.environment).toMatchObject({
      HERDR_SOCKET_PATH: "/owned/herdr.sock",
      XDG_CONFIG_HOME: "/owned/config",
    });
    expect(f.manager.current.definition?.environment).not.toHaveProperty("HERDR_SESSION");
    expect(f.manager.current.definition?.environment).not.toHaveProperty("PRIVATE_SENTINEL");
  });
  it("returns a structured preflight error before creating LaunchAgents or state", async () => {
    const f = fixture(false);
    const definitionPath = join(f.p.dir, "missing-agents", "service.plist");
    const manager = new FakeManager(definitionPath, f.manager.original, false);
    const controller = new ServiceLifecycle({
      ...f.options,
      manager,
      env: { XDG_CONFIG_HOME: "PRIVATE_SENTINEL" },
    });
    await expect(controller.install()).rejects.toMatchObject({ rollback: "not-needed" });
    expect(existsSync(join(f.p.dir, "missing-agents"))).toBe(false);
    expect(manager.events).toEqual([]);
  });
  it("rejects invalid persisted backend text before unloading or changing identity", async () => {
    const f = fixture();
    const keys = readFileSync(f.p.identity);
    const controller = new ServiceLifecycle({
      ...f.options,
      env: { HERDR_SOCKET_PATH: "/PRIVATE_SENTINEL\u0000" },
    });
    await expect(controller.install()).rejects.toMatchObject({ rollback: "not-needed" });
    expect(f.manager.events).toEqual([]);
    expect(readFileSync(f.p.identity)).toEqual(keys);
  });
  it("absent service stop/uninstall do not create missing directories", async () => {
    const f = fixture(false);
    const definitionPath = join(f.p.dir, "missing-agents", "service.plist");
    const manager = new FakeManager(definitionPath, f.manager.original, false);
    manager.current = { installed: false, loaded: false, definition: null, raw: null };
    const controller = new ServiceLifecycle({ ...f.options, manager });
    expect(await controller.stop()).toMatchObject({ ready: false, installed: false });
    expect(await controller.uninstall()).toMatchObject({ ready: false, installed: false });
    await expect(controller.start()).rejects.toMatchObject({ rollback: "not-needed" });
    expect(existsSync(join(f.p.dir, "missing-agents"))).toBe(false);
    expect(existsSync(f.options.defaultStateDir)).toBe(false);
  });
  it("restores the old loaded service after a failed definition write", async () => {
    const f = fixture();
    f.manager.write = async () => {
      throw new Error("write failed");
    };
    await expect(f.controller.install()).rejects.toMatchObject({
      message: "write failed",
      rollback: "restored",
    });
    expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
    expect(f.manager.current.loaded).toBe(true);
  });
  it("legacy definitions can stop and uninstall without understanding their control protocol", async () => {
    const f = fixture();
    f.manager.original.serviceInstance = null;
    f.probe.mockImplementation(async () => {
      if (!f.manager.current.loaded) throw absent();
      return { running: true } as never;
    });
    expect(await f.controller.stop()).toMatchObject({
      ready: false,
      loaded: false,
      installed: true,
      diagnostic: expect.stringContaining("may start at next login"),
    });
    expect(await f.controller.uninstall()).toMatchObject({ ready: false, installed: false });
  });
  it("updates the installed custom directory, rotates the instance, and preserves identity and log", async () => {
    const f = fixture();
    const identity = readFileSync(f.p.identity);
    writeFileSync(f.p.log, "existing log\n", { mode: 0o644 });
    const first = await f.controller.install();
    const marker = f.manager.current.definition!.serviceInstance;
    expect(first).toMatchObject({
      ready: true,
      ownership: "verified",
      local: { relayOnline: false, terminalReady: false },
      managedPid: 101,
    });
    expect(f.manager.current.definition?.environment.SHELLBELL_DIR).toBe(realpathSync(f.p.dir));
    expect(marker).not.toBe(INSTANCE);
    await f.controller.install();
    expect(f.manager.current.definition?.serviceInstance).not.toBe(marker);
    expect(readFileSync(f.p.identity)).toEqual(identity);
    expect(readFileSync(f.p.log, "utf8")).toBe("existing log\n");
    expect(statSync(f.p.log).mode & 0o777).toBe(0o600);
    expect(existsSync(f.options.defaultStateDir)).toBe(false);
  });
  it("rejects an explicit state migration with zero manager mutations", async () => {
    const f = fixture();
    const controller = new ServiceLifecycle({
      ...f.options,
      requestedStateDir: join(f.p.dir, "other"),
    });
    await expect(controller.install()).rejects.toThrow(/migration/);
    expect(f.manager.events).toEqual([]);
  });
  it.each(["status", "start", "restart", "stop", "uninstall"] as const)(
    "%s never creates missing identity",
    async (command) => {
      const f = fixture(false);
      unlinkSync(f.p.identity);
      try {
        await f.controller[command]();
      } catch {
        /* start/restart require the missing identity */
      }
      expect(existsSync(f.p.identity)).toBe(false);
    },
  );
  it("does not replace missing identity on an installed service upgrade", async () => {
    const f = fixture(false);
    unlinkSync(f.p.identity);
    await expect(f.controller.install()).rejects.toThrow(/identity is missing/);
    expect(f.manager.events).toEqual([]);
    expect(existsSync(f.p.identity)).toBe(false);
  });
  it("status inspects readiness without kickstarting or writing state", async () => {
    const f = fixture();
    expect(await f.controller.status()).toMatchObject({
      ready: true,
      loaded: true,
      autostartConfigured: true,
      managedPid: null,
    });
    expect(f.manager.events).toEqual([]);
  });
  it.each(["install", "start", "restart"] as const)(
    "%s refuses a foreground endpoint without sending a stop signal",
    async (command) => {
      const f = fixture();
      f.probe.mockImplementation(async () => ({
        ...f.local(),
        process: { ...f.local().process, serviceInstance: null },
      }));
      await expect(f.controller[command]()).rejects.toThrow(/foreign|foreground/);
      expect(f.manager.events).toEqual([]);
    },
  );
  it("start retains the runtime and instance and is idempotent for the correct live process", async () => {
    const f = fixture();
    const definition = f.manager.current.definition;
    expect(await f.controller.start()).toMatchObject({ ready: true, managedPid: 100 });
    expect(await f.controller.start()).toMatchObject({ ready: true, managedPid: 100 });
    expect(f.manager.current.definition).toBe(definition);
    expect(f.manager.events).toEqual(["load-old", "load-old"]);
  });
  it("restart obtains a new PID while retaining definition, instance, and identity", async () => {
    const f = fixture();
    const keys = readFileSync(f.p.identity);
    expect(await f.controller.restart()).toMatchObject({ ready: true, managedPid: 101 });
    expect(f.manager.events).toEqual(["unload-old", "load-old"]);
    expect(f.manager.current.definition?.serviceInstance).toBe(INSTANCE);
    expect(readFileSync(f.p.identity)).toEqual(keys);
  });
  it("stop is idempotent and preserves future autostart; uninstall preserves all state", async () => {
    const f = fixture();
    const keys = readFileSync(f.p.identity);
    expect(await f.controller.stop()).toMatchObject({
      ready: false,
      loaded: false,
      autostartConfigured: true,
    });
    await f.controller.stop();
    expect(f.manager.events).toEqual(["unload-old"]);
    expect(await f.controller.uninstall()).toMatchObject({
      ready: false,
      installed: false,
      autostartConfigured: false,
    });
    await f.controller.uninstall();
    expect(f.manager.events).toEqual(["unload-old", "remove-new"]);
    expect(readFileSync(f.p.identity)).toEqual(keys);
  });
  it("uninstall leaves the definition intact if unload fails", async () => {
    const f = fixture();
    f.manager.unload = async () => {
      throw new Error("unload denied");
    };
    await expect(f.controller.uninstall()).rejects.toThrow(/unload denied/);
    expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
  });
  it.each(["stop", "uninstall"] as const)(
    "%s can unload its validated job even when status is unresponsive",
    async (command) => {
      const f = fixture();
      f.probe.mockImplementation(async () => {
        if (f.manager.current.loaded) throw new Error("timeout");
        throw absent();
      });
      expect(await f.controller[command]()).toMatchObject({ ready: false, loaded: false });
      expect(f.manager.events[0]).toBe("unload-old");
    },
  );
  it("uninstall waits for the old endpoint to disappear and never removes a live definition", async () => {
    const f = fixture();
    f.probe.mockImplementation(async () => f.local());
    await expect(f.controller.uninstall()).rejects.toThrow(/stop timed out/);
    expect(f.manager.events).toEqual(["unload-old"]);
    expect(f.manager.current.installed).toBe(true);
    expect(f.clock.now()).toBe(10_000);
  });
  it("serializes concurrent operations with a separate definition guard", async () => {
    const f = fixture();
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = f.manager.inspect.bind(f.manager);
    let blocked = false;
    f.manager.inspect = async () => {
      if (!blocked && existsSync(`${f.p.serviceOwner}.lock`)) {
        blocked = true;
        entered();
        await waiting;
      }
      return original();
    };
    const pending = f.controller.install();
    await entering;
    try {
      await expect(new ServiceLifecycle(f.options).stop()).rejects.toThrow(/busy/);
    } finally {
      resume();
    }
    expect((await pending).ready).toBe(true);
    expect(existsSync(`${f.p.sock}.lock`)).toBe(false);
    expect(existsSync(`${f.manager.definitionPath}.lock`)).toBe(false);
  });
  it("preserves recoverable original bytes privately if rollback cannot unload the new job", async () => {
    const f = fixture();
    f.manager.failNew = true;
    const unload = f.manager.unload.bind(f.manager);
    f.manager.unload = async () => {
      if (f.manager.current.definition !== f.manager.original)
        throw new Error("rollback unload denied");
      await unload();
    };
    let failure: unknown;
    try {
      await f.controller.install();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      rollback: "failed",
      message: "bootstrap failed",
      rollbackDiagnostic: "rollback unload denied",
    });
    const path = (failure as { recoveryPath: string }).recoveryPath;
    expect(readFileSync(path)).toEqual(Buffer.from("EXACT OLD BYTES"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(f.manager.events).not.toContain("restore-old");
    expect(f.manager.current.raw).toEqual(Buffer.from("NEW"));
  });
  it.each(["restore", "reload"])(
    "reports original and rollback %s failures separately",
    async (failure) => {
      const f = fixture();
      f.manager.failNew = true;
      if (failure === "restore")
        f.manager.restore = async () => {
          throw new Error("restore denied");
        };
      else {
        const load = f.manager.load.bind(f.manager);
        f.manager.load = async () => {
          if (f.manager.events.includes("restore-old")) throw new Error("reload denied");
          return load();
        };
      }
      await expect(f.controller.install()).rejects.toMatchObject({
        message: "bootstrap failed",
        rollback: "failed",
        rollbackDiagnostic: `${failure} denied`,
      });
    },
  );
  it("legacy status is unverified but manager PID can certify start; upgrade failures restore old legacy job", async () => {
    const f = fixture();
    f.manager.original.serviceInstance = null;
    expect(await f.controller.status()).toMatchObject({ ready: false, ownership: "legacy" });
    expect(await f.controller.start()).toMatchObject({ ready: true, managedPid: 100 });
    f.manager.failNew = true;
    f.probe.mockImplementation(async () => {
      if (!f.manager.current.loaded) throw absent();
      return { controlVersion: 0 } as never;
    });
    await expect(f.controller.install()).rejects.toMatchObject({ rollback: "restored" });
    expect(f.manager.current.loaded).toBe(true);
  });
  it("start rejects a local response from a different PID even with matching identity and marker", async () => {
    const f = fixture(false);
    f.probe.mockImplementation(async () => {
      if (!f.manager.current.loaded) throw absent();
      return { ...f.local(), process: { ...f.local().process, pid: 999 } };
    });
    await expect(f.controller.start()).rejects.toMatchObject({ rollback: "restored" });
    expect(f.manager.current.loaded).toBe(false);
  });
  it("rejects bootstrap without readiness and restores exact old definition and loaded state", async () => {
    const f = fixture();
    const keys = readFileSync(f.p.identity);
    f.probe.mockImplementation(async () => {
      if (!f.manager.current.loaded || f.manager.current.definition !== f.manager.original)
        throw absent();
      return f.local();
    });
    await expect(f.controller.install()).rejects.toMatchObject({ rollback: "restored" });
    expect(f.manager.events).toEqual([
      "unload-old",
      "write-new",
      "load-new",
      "unload-new",
      "restore-old",
      "load-old",
    ]);
    expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
    expect(f.manager.current.loaded).toBe(true);
    expect(readFileSync(f.p.identity)).toEqual(keys);
  });
  it("restores an unloaded prior definition when bootstrap fails", async () => {
    const f = fixture(false);
    f.manager.failNew = true;
    await expect(f.controller.install()).rejects.toMatchObject({ rollback: "restored" });
    expect(f.manager.current.loaded).toBe(false);
    expect(f.manager.current.raw).toEqual(Buffer.from("EXACT OLD BYTES"));
    expect(f.manager.events).toEqual(["write-new", "load-new", "unload-new", "restore-old"]);
  });
});

describe("selectServicePaths", () => {
  it("accepts aliases of the same existing directory and resolves absent paths without writes", () => {
    const f = fixture();
    const alias = join(f.p.dir, "..", "alias");
    symlinkSync(f.p.dir, alias);
    expect(selectServicePaths(f.manager.current, alias, "/unused").dir).toBe(
      selectServicePaths(f.manager.current, undefined, "/unused").dir,
    );
    const target = join(f.p.dir, "missing", "..", "new");
    const selected = selectServicePaths(
      { installed: false, loaded: false, definition: null, raw: null },
      target,
      "/unused",
    );
    expect(selected.dir).toBe(join(f.p.dir, "new"));
    expect(existsSync(selected.dir)).toBe(false);
  });
});
