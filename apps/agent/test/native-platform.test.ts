import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceCommand } from "../src/launchd.js";
import { createNativePlatform } from "../src/native/platform.js";
import { NativeControllerError, type NativeSelection } from "../src/native/protocol.js";
import { runServiceCommand } from "../src/service-command.js";
import type { ServiceManager } from "../src/service-manager.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const dirs: string[] = [];
it("legacy inspection leaves an absent LaunchAgents parent absent", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-native-readonly-")));
  dirs.push(dir);
  const parent = join(dir, "Library", "LaunchAgents");
  const platform = createNativePlatform({
    root: join(dir, "native"),
    uid: process.getuid!(),
    homeDir: dir,
    run: async (_exe, args) => {
      if (args[0] !== "print") throw new Error("mutation during inspection");
      return { exitCode: 113, stdout: Buffer.alloc(0) };
    },
  });
  expect(await platform.inspectLegacy()).toMatchObject({ installed: false, loaded: false });
  expect(existsSync(parent)).toBe(false);
});
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-native-platform-")));
  dirs.push(dir);
  const root = join(dir, "native");
  const bundle = join(dir, "Shellbell.app");
  const executable = join(bundle, "Contents", "MacOS", "Shellbell");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true, mode: 0o755 });
  writeFileSync(executable, "fixture-not-executable", { mode: 0o755 });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "fixture-info", { mode: 0o644 });
  const calls: {
    executable: string;
    args: readonly string[];
    options: Parameters<ServiceCommand>[2];
  }[] = [];
  const f = {
    dir,
    root,
    bundle,
    executable,
    calls,
    pid: 456,
    program: executable,
    status: "not-registered",
    loginStatus: "not-registered",
    loginDenied: false,
    unregisterStatus: "not-registered",
    signatureExit: 0,
    disabled: false,
    disabledOutput: undefined as string | undefined,
    printExit: 113,
    printOverride: undefined as string | undefined,
    helperResponse: undefined as unknown,
    metadata: {
      CFBundleIdentifier: "sh.bilal.shellbell.host",
      CFBundleExecutable: "Shellbell",
    },
    onCall: undefined as ((args: readonly string[]) => void) | undefined,
    selection: {
      mode: "persistent",
      stateDir: join(dir, "state"),
      computerFp: "a".repeat(26),
      serviceInstance: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      bundlePath: bundle,
      bundleId: "sh.bilal.shellbell.host",
      agentVersion: "1.0.0",
      environment: {
        PATH: "/usr/bin:/bin",
        SHELLBELL_DIR: join(dir, "state"),
        SHELLBELL_SERVICE_INSTANCE: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    } as NativeSelection,
    setLoaded(value: boolean) {
      f.printExit = value ? 0 : 113;
    },
    platform: undefined as unknown as ReturnType<typeof createNativePlatform>,
  };
  const run: ServiceCommand = async (exe, args, options) => {
    // Do not mistake a legacy probe for an observation of this fixture's current job.
    if (args[0] === "print" && args[1]?.includes("/dev.bilalahmad.shellbell")) {
      return { exitCode: 113, stdout: Buffer.alloc(0) };
    }
    calls.push({ executable: exe, args, options });
    f.onCall?.(args);
    if (exe === "/usr/bin/codesign") return { exitCode: f.signatureExit, stdout: Buffer.alloc(0) };
    if (exe === "/usr/bin/plutil")
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify(f.metadata)) };
    if (exe === executable) {
      if (args[0] === "--login-api") {
        if (args[1] === "register" && f.loginDenied)
          return {
            exitCode: 1,
            stdout: Buffer.from(JSON.stringify({ v: 1, ok: false, error: { code: "denied" } })),
          };
        if (args[1] === "register" && f.loginStatus !== "requires-approval")
          f.loginStatus = "enabled";
        if (args[1] === "unregister") f.loginStatus = "not-registered";
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({ v: 1, ok: true, status: f.loginStatus })),
        };
      }
      if (args[1] === "register") {
        f.status = f.status === "requires-approval" ? f.status : "enabled";
        if (f.status === "enabled") f.setLoaded(true);
      }
      if (args[1] === "unregister") {
        f.status = f.unregisterStatus;
        f.setLoaded(false);
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify(f.helperResponse ?? { v: 1, ok: true, status: f.status }),
        ),
      };
    }
    if (exe === "/bin/launchctl") {
      if (args[0] === "disable") {
        f.disabled = true;
        return { exitCode: 0, stdout: Buffer.alloc(0) };
      }
      if (args[0] === "enable") {
        f.disabled = false;
        return { exitCode: 0, stdout: Buffer.alloc(0) };
      }
      if (args[0] === "print-disabled")
        return {
          exitCode: 0,
          stdout: Buffer.from(
            f.disabledOutput ??
              `disabled services = {\n\t"sh.bilal.shellbell.host.agent" => ${f.disabled ? "disabled" : "enabled"}\n}\n`,
          ),
        };
      const label = args[1]?.endsWith(".manual")
        ? "sh.bilal.shellbell.host.manual"
        : "sh.bilal.shellbell.host.agent";
      if (args[0] === "print")
        return {
          exitCode: f.printExit,
          stdout: Buffer.from(
            f.printOverride ??
              `gui/${process.getuid!()}/${label} = {\n\tprogram = ${f.program}\n\targuments = {\n\t\t${label.endsWith("manual") ? f.program : "Shellbell"}\n\t\t--service-run\n\t\t${label.endsWith("manual") ? "manual" : "persistent"}\n\t}\n\tpid = ${f.pid}\n}\n`,
          ),
        };
      if (args[0] === "bootstrap") f.setLoaded(true);
      else if (args[0] === "bootout") f.setLoaded(false);
      else throw new Error("unexpected launchctl verb");
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    throw new Error("unexpected executable");
  };
  f.platform = createNativePlatform({ root, uid: process.getuid!(), homeDir: dir, run });
  return f;
}
describe("native platform ownership", () => {
  it("registers only the main-app login item without loading an agent", async () => {
    const f = fixture();
    expect(await f.platform.setLogin(f.bundle, true)).toBe("enabled");
    expect(f.printExit).toBe(113);
    expect(f.calls.some((call) => call.args[0] === "--service-api")).toBe(false);
    expect(f.calls.some((call) => call.executable === "/bin/launchctl")).toBe(false);
    expect(await f.platform.setLogin(f.bundle, false)).toBe("not-registered");
  });
  it("refuses unsigned login registration before any registration mutation", async () => {
    const f = fixture();
    f.signatureExit = 1;
    await expect(f.platform.setLogin(f.bundle, true)).rejects.toMatchObject({
      code: "startup-unavailable",
    });
    expect(f.loginStatus).toBe("not-registered");
    expect(f.calls.some((call) => call.args[1] === "register")).toBe(false);
  });
  it("keeps pending main-app approval distinct from enabled registration", async () => {
    const f = fixture();
    f.loginStatus = "requires-approval";
    expect(await f.platform.setLogin(f.bundle, true)).toBe("requires-approval");
    expect(f.printExit).toBe(113);
  });
  it("records a requested login preference when registration enters pending user approval", async () => {
    const f = fixture();
    f.onCall = (args) => {
      if (args[0] === "--login-api" && args[1] === "register") {
        f.loginStatus = "requires-approval";
        f.loginDenied = true;
      }
    };
    expect(await f.platform.setLogin(f.bundle, true)).toBe("requires-approval");
  });
  it("rejects desktop execution before any launchd label is selected", async () => {
    const f = fixture();
    f.selection.mode = "desktop";
    await expect(f.platform.start(f.selection)).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls).toEqual([]);
  });
  it("manual recovery verifies the disabled label even when ServiceManagement cannot find the service", async () => {
    const f = fixture();
    f.status = "not-found";
    await f.platform.prepareManualRecovery(f.selection);
    expect(f.disabled).toBe(true);
    expect(f.calls.some((call) => call.args[1] === "register")).toBe(false);
    f.status = "not-registered";
    await f.platform.start(f.selection);
    expect(f.disabled).toBe(false);
  });
  it.each([
    'disabled services = {\n"sh.bilal.shellbell.host.agent" => enabled\n}',
    'disabled services = {\n"other" => disabled\n}',
    'disabled services = {\n"sh.bilal.shellbell.host.agent" => disabled\n"sh.bilal.shellbell.host.agent" => enabled\n}',
  ])("refuses manual recovery without unambiguous disabled evidence: %s", async (output) => {
    const f = fixture();
    f.disabledOutput = output;
    await expect(f.platform.prepareManualRecovery(f.selection)).rejects.toMatchObject({
      code: "operation-failed",
    });
  });
  it("does not disable a persistent job observed running during manual recovery", async () => {
    const f = fixture();
    f.setLoaded(true);
    await expect(f.platform.prepareManualRecovery(f.selection)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.disabled).toBe(false);
  });
  it("rejects an invalid bundle signature before attempting automatic registration", async () => {
    const f = fixture();
    f.signatureExit = 1;
    await expect(f.platform.start(f.selection)).rejects.toMatchObject({
      code: "startup-unavailable",
    });
    expect(f.calls.some((call) => call.args[1] === "register")).toBe(false);
  });
  for (const mode of ["manual", "persistent"] as const) {
    for (const outcome of ["gone", "replacement", "stuck"] as const) {
      it(`bounds asynchronous ${mode} unload with ${outcome} execution`, async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const f = fixture();
        f.selection.mode = mode;
        const observed = await f.platform.start(f.selection);
        let stopping = false;
        let polls = 0;
        f.onCall = (args) => {
          if (args[0] === "bootout" || args[1] === "unregister") stopping = true;
          if (stopping && args[0] === "print") {
            polls++;
            f.setLoaded(outcome !== "gone" || polls < 3);
            if (outcome === "replacement") f.pid = 789;
          }
        };
        const start = performance.now();
        let settled = false;
        const operation = f.platform
          .stop(f.selection, observed)
          .then(
            () => null,
            (error) => error,
          )
          .finally(() => {
            settled = true;
          });
        // Native I/O can schedule the next fake timer after a timer drain ends.
        // Wait for the operation itself, yielding real I/O between drains.
        while (!settled) {
          await vi.runAllTimersAsync();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const error = await operation;
        if (outcome === "gone") expect(error).toBeNull();
        else
          expect(error).toMatchObject({
            code: outcome === "replacement" ? "conflict" : "operation-failed",
          });
        expect(
          f.calls.filter((c) => c.args[0] === "bootout" || c.args[1] === "unregister"),
        ).toHaveLength(1);
        if (outcome === "gone") {
          expect(polls).toBe(3);
          expect(
            f.calls
              .filter((c) => c.args[0] === "print")
              .slice(-3)
              .map((c) => c.options.timeoutMs),
          ).toEqual([10000, 9900, 9800]);
          expect((await f.platform.inspect(mode, f.bundle)).loaded).toBe(false);
        } else if (outcome === "replacement") {
          expect(polls).toBe(1);
        } else {
          expect(performance.now() - start).toBe(10_000);
        }
      });
    }
  }
  it("rejects root before commands or files", () => {
    expect(() =>
      createNativePlatform({ root: "/fixture", uid: 0, homeDir: "/fixture" }),
    ).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
  });
  it("inspects registration and execution separately without creating native state", async () => {
    const f = fixture();
    f.status = "enabled";
    expect(await f.platform.inspect("persistent", f.bundle)).toEqual({
      registration: "enabled",
      loaded: false,
      pid: null,
      bundlePath: f.bundle,
    });
    expect(existsSync(f.root)).toBe(false);
    expect(f.calls.filter((c) => c.executable === f.executable).map((c) => c.args)).toEqual([
      ["--service-api", "status"],
    ]);
    expect(f.calls.at(-1)?.args).toEqual([
      "print",
      `gui/${process.getuid!()}/sh.bilal.shellbell.host.agent`,
    ]);
    expect(
      f.calls.every(
        (c) =>
          c.options.timeoutMs === 10000 &&
          c.options.maxOutputBytes === 65536 &&
          c.options.captureOutput,
      ),
    ).toBe(true);
  });
  it("leaves approval pending without starting manual mode", async () => {
    const f = fixture();
    f.status = "requires-approval";
    expect(await f.platform.start(f.selection)).toMatchObject({
      registration: "requires-approval",
      loaded: false,
    });
    expect(f.calls.some((c) => c.args.includes("bootstrap"))).toBe(false);
  });
  it("refuses a denied helper response without leaking helper contents", async () => {
    const f = fixture();
    f.onCall = (args) => {
      if (args[1] === "register") f.helperResponse = { v: 1, ok: false, error: { code: "denied" } };
    };
    await expect(f.platform.start(f.selection)).rejects.toMatchObject({
      code: "approval-required",
    });
  });
  it.each(["malformed", "timeout"])(
    "does not replay a registration with %s result",
    async (kind) => {
      const f = fixture();
      f.onCall = (args) => {
        if (args[1] !== "register") return;
        if (kind === "timeout") throw new Error("PRIVATE helper content");
        f.helperResponse = {
          v: 1,
          ok: true,
          status: "enabled",
          unexpected: "PRIVATE helper content",
        };
      };
      await expect(f.platform.start(f.selection)).rejects.toMatchObject({
        code: "delivery-unknown",
        message: "delivery-unknown",
      });
      expect(f.calls.filter((c) => c.args[1] === "register")).toHaveLength(1);
    },
  );
  it("refuses a helper replaced while bundle metadata is decoded", async () => {
    const f = fixture();
    f.onCall = (args) => {
      if (args[0] === "-convert") writeFileSync(f.executable, "changed executable fixture");
    };
    await expect(f.platform.inspect("persistent", f.bundle)).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(f.calls.some((c) => c.executable === f.executable)).toBe(false);
  });
  it("rejects ambiguous spacing in a duplicate root ownership field", async () => {
    const f = fixture();
    f.setLoaded(true);
    f.printOverride = `gui/${process.getuid!()}/sh.bilal.shellbell.host.agent = {\n program = ${f.executable}\n arguments = {\n ${f.executable}\n --service-run\n persistent\n }\n pid=999\n pid = 456\n}\n`;
    await expect(f.platform.inspect("persistent", f.bundle)).rejects.toMatchObject({
      code: "unsafe-state",
    });
  });
  it.each(["pid", "program"])("refuses stop when fresh %s ownership changed", async (field) => {
    const f = fixture();
    f.setLoaded(true);
    f.status = "enabled";
    const observed = await f.platform.inspect("persistent", f.bundle);
    if (field === "pid") f.pid++;
    else f.program = join(f.dir, "foreign");
    await expect(f.platform.stop(f.selection, observed)).rejects.toBeInstanceOf(Error);
    expect(f.calls.some((c) => c.args[1] === "unregister")).toBe(false);
  });
  it("unregisters only after fresh ownership and verifies job termination", async () => {
    const f = fixture();
    f.setLoaded(true);
    f.status = "enabled";
    const observed = await f.platform.inspect("persistent", f.bundle);
    f.calls.length = 0;
    await f.platform.stop(f.selection, observed);
    const unregister = f.calls.findIndex((c) => c.args[1] === "unregister");
    expect(unregister).toBeGreaterThan(0);
    expect(f.calls.slice(0, unregister).some((c) => c.args[0] === "print")).toBe(true);
    expect(f.calls.at(-1)?.args[0]).toBe("print");
  });
  it.each([
    ["enabled", "operation-failed"],
    ["requires-approval", "operation-failed"],
    ["not-found", "operation-failed"],
    ["unfamiliar", "delivery-unknown"],
  ])(
    "refuses persistent Stop when unregister reports %s despite absent execution",
    async (status, code) => {
      const f = fixture();
      f.status = "enabled";
      f.unregisterStatus = status!;
      const observed = await f.platform.inspect("persistent", f.bundle);
      expect(observed).toMatchObject({ registration: "enabled", loaded: false, pid: null });
      await expect(f.platform.stop(f.selection, observed)).rejects.toMatchObject({ code });
      expect(f.calls.filter((c) => c.args[1] === "unregister")).toHaveLength(1);
    },
  );
  it("succeeds persistent Stop only with confirmed unregistration and absent execution", async () => {
    const f = fixture();
    f.status = "enabled";
    const observed = await f.platform.inspect("persistent", f.bundle);
    await expect(f.platform.stop(f.selection, observed)).resolves.toBeUndefined();
    expect(f.calls.at(-1)?.args[0]).toBe("print");
    expect(await f.platform.inspect("persistent", f.bundle)).toMatchObject({
      registration: "not-registered",
      loaded: false,
      pid: null,
    });
    expect(f.calls.filter((c) => c.args[1] === "unregister")).toHaveLength(1);
  });
  it("disables an exactly owned loaded job with no running PID", async () => {
    const f = fixture();
    f.setLoaded(true);
    f.status = "enabled";
    f.printOverride = `gui/${process.getuid!()}/sh.bilal.shellbell.host.agent = {\n program = ${f.executable}\n arguments = {\n Shellbell\n --service-run\n persistent\n }\n}\n`;
    const observed = await f.platform.inspect("persistent", f.bundle);
    expect(observed).toMatchObject({ loaded: true, pid: null });
    await f.platform.stop(f.selection, observed);
    expect(f.calls.filter((c) => c.args[1] === "unregister")).toHaveLength(1);
  });
  it("refuses a PID change during helper validation before unregister", async () => {
    const f = fixture();
    f.setLoaded(true);
    f.status = "enabled";
    const observed = await f.platform.inspect("persistent", f.bundle);
    let validations = 0;
    f.onCall = (args) => {
      if (args[0] === "-convert" && ++validations === 2) f.pid++;
    };
    await expect(f.platform.stop(f.selection, observed)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.calls.some((c) => c.args[1] === "unregister")).toBe(false);
  });
  it("bootstraps and stops the exact transient job, removes only its stopped file", async () => {
    const f = fixture();
    f.selection.mode = "manual";
    const observed = await f.platform.start(f.selection);
    expect(observed).toMatchObject({ loaded: true, pid: 456 });
    expect(f.calls.find((c) => c.args[0] === "bootstrap")?.args).toEqual([
      "bootstrap",
      `gui/${process.getuid!()}`,
      join(f.root, "manual.plist"),
    ]);
    await expect(f.platform.remove(f.selection)).rejects.toMatchObject({ code: "conflict" });
    await f.platform.stop(f.selection, observed);
    expect(f.calls.find((c) => c.args[0] === "bootout")?.args).toEqual([
      "bootout",
      `gui/${process.getuid!()}/sh.bilal.shellbell.host.manual`,
    ]);
    await f.platform.remove(f.selection);
    expect(existsSync(join(f.root, "manual.plist"))).toBe(false);
    expect(f.calls.some((c) => c.executable === f.executable)).toBe(false);
  });
  it("refuses a manual helper replaced during the last launchctl observation", async () => {
    const f = fixture();
    f.selection.mode = "manual";
    let prints = 0;
    f.onCall = (args) => {
      if (args[0] === "print" && ++prints === 2)
        writeFileSync(f.executable, "replacement helper fixture");
    };
    await expect(f.platform.start(f.selection)).rejects.toMatchObject({ code: "unsafe-state" });
    expect(f.calls.some((c) => c.args[0] === "bootstrap")).toBe(false);
  });
  it.each([1, 78, Number.NaN])("does not confuse print failure %s with absence", async (code) => {
    const f = fixture();
    f.printExit = code;
    await expect(f.platform.inspect("persistent", f.bundle)).rejects.toBeInstanceOf(Error);
  });
  it("admits the immutable persistent argv while retaining exact program ownership", async () => {
    const f = fixture();
    f.setLoaded(true);
    const target = `gui/${process.getuid!()}/sh.bilal.shellbell.host.agent`;
    const valid = `${target} = {\n program = ${f.executable}\n arguments = {\n Shellbell\n --service-run\n persistent\n }\n pid = 456\n}\n`;
    f.printOverride = valid;
    await expect(f.platform.inspect("persistent", f.bundle)).resolves.toMatchObject({
      loaded: true,
      pid: 456,
    });
    for (const invalid of [
      valid.replace(`program = ${f.executable}`, "program = /tmp/Shellbell"),
      valid.replace("\n Shellbell\n", `\n ${f.executable}\n`),
      valid.replace("\n Shellbell\n", "\n Other\n"),
      valid.replace("\n persistent\n", "\n manual\n"),
      valid.replace("\n persistent\n", "\n persistent\n extra\n"),
    ]) {
      f.printOverride = invalid;
      await expect(f.platform.inspect("persistent", f.bundle)).rejects.toBeInstanceOf(Error);
    }
  });
  it.each(["duplicate", "nested", "wrong-mode", "wrong-label"])(
    "rejects %s launchctl ownership",
    async (kind) => {
      const f = fixture();
      f.setLoaded(true);
      const target = `gui/${process.getuid!()}/sh.bilal.shellbell.host.agent`;
      const valid = `${target} = {\n program = ${f.executable}\n arguments = {\n Shellbell\n --service-run\n persistent\n }\n pid = 456\n}\n`;
      f.printOverride =
        kind === "duplicate"
          ? valid.replace(" pid =", " pid = 999\n pid =")
          : kind === "nested"
            ? `${target} = {\n environment = {\n program = ${f.executable}\n pid = 456\n }\n}\n`
            : kind === "wrong-mode"
              ? valid.replace("\n persistent", "\n manual")
              : valid.replace(".agent =", ".foreign =");
      await expect(f.platform.inspect("persistent", f.bundle)).rejects.toBeInstanceOf(Error);
    },
  );
  it("rejects oversized output even from an injected runner", async () => {
    const f = fixture();
    f.setLoaded(true);
    f.printOverride = "x".repeat(65537);
    await expect(f.platform.inspect("persistent", f.bundle)).rejects.toBeInstanceOf(Error);
  });
  it("reports a missing old bundle without executing it", async () => {
    const f = fixture();
    rmSync(f.bundle, { recursive: true });
    expect(await f.platform.inspect("persistent", f.bundle)).toMatchObject({
      registration: "not-found",
      loaded: false,
    });
    expect(f.calls.every((c) => c.executable === "/bin/launchctl")).toBe(true);
  });
  it.each(["identity", "permissions", "setuid", "symlink"])(
    "rejects invalid helper %s before executing it",
    async (kind) => {
      const f = fixture();
      if (kind === "identity") f.metadata.CFBundleIdentifier = "foreign";
      else if (kind === "permissions") chmodSync(f.executable, 0o777);
      else if (kind === "setuid") chmodSync(f.executable, 0o4755);
      else {
        rmSync(f.executable);
        const target = join(f.dir, "other");
        writeFileSync(target, "fixture", { mode: 0o755 });
        symlinkSync(target, f.executable);
      }
      await expect(f.platform.start(f.selection)).rejects.toBeInstanceOf(Error);
      expect(f.calls.some((c) => c.executable === f.executable)).toBe(false);
    },
  );
});

describe("shared bounded command runner", () => {
  it.each(["stdout", "stderr"] as const)(
    "kills on %s overflow without leaking output",
    async (stream) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      spawn.mockReturnValue(child);
      const promise = runServiceCommand("/fixture/executable", ["literal;$()"], {
        timeoutMs: 10000,
        maxOutputBytes: 8,
        captureOutput: true,
      });
      const rejection = expect(promise).rejects.toThrow("output limit exceeded");
      child[stream].write(Buffer.from("PRIVATE_CONTENT"));
      await rejection;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenLastCalledWith("/fixture/executable", ["literal;$()"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  );
  it("kills and rejects at the injected deadline", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const promise = runServiceCommand("/fixture/executable", [], {
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      captureOutput: true,
    });
    const rejection = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe("legacy handoff guard", () => {
  it("serializes against the same fixed legacy definition guard and releases after failure", async () => {
    const f = fixture();
    const definitionPath = join(f.dir, "Library/LaunchAgents/sh.bilal.shellbell.plist");
    const legacy: ServiceManager = {
      kind: "launchd",
      definitionPath,
      async inspect() {
        return { installed: false, loaded: false, raw: null, definition: null };
      },
      async write() {},
      async restore() {},
      async load() {
        return 1;
      },
      async unload() {},
      async setStartupEnabled() {},
    };
    const platform = createNativePlatform({
      root: f.root,
      uid: process.getuid!(),
      homeDir: f.dir,
      legacy,
      run: async () => {
        throw new Error("must not run");
      },
    });
    await expect(
      platform.withLegacyGuard(async (manager) => {
        expect(manager).toBe(legacy);
        expect(existsSync(`${definitionPath}.lock`)).toBe(true);
        await expect(platform.withLegacyGuard(async () => undefined)).rejects.toThrow("busy");
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    expect(existsSync(`${definitionPath}.lock`)).toBe(false);
    await expect(
      platform.withLegacyGuard(async () => {
        throw new NativeControllerError("conflict");
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(platform.withLegacyGuard((manager) => manager.inspect())).resolves.toMatchObject({
      installed: false,
    });
    expect(existsSync(f.root)).toBe(false);
  });
});
