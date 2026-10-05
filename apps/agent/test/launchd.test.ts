import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaunchdManager,
  LABEL,
  plistFor,
  prepareLogFile,
  type ServiceCommand,
} from "../src/launchd.js";
import type { ServiceDefinition } from "../src/service-manager.js";

const cleanupRoots: string[] = [];

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "sb-launchd-"));
  cleanupRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0).reverse())
    rmSync(root, { force: true, recursive: true });
});

describe("plistFor", () => {
  it("emits a launchd plist with the label, argv, PATH and log paths", () => {
    const xml = plistFor({
      nodePath: "/opt/homebrew/bin/node",
      cliPath: "/usr/local/bin/shellbell",
      logPath: "/Users/x/.shellbell/agent.log",
    });
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(LABEL).toBe("sh.bilal.shellbell");
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/usr/local/bin/shellbell</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--service</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(xml).toContain(
      "<key>StandardOutPath</key><string>/Users/x/.shellbell/agent.log</string>",
    );
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = plistFor({ nodePath: "/a&b/node", cliPath: "/c<d/cli.js", logPath: "/l.log" });
    expect(xml).toContain("/a&amp;b/node");
    expect(xml).toContain("/c&lt;d/cli.js");
    expect(xml).not.toContain("/a&b/node");
  });

  it("encodes explicit state environment including XML metacharacters", () => {
    const xml = plistFor({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/shellbell/cli.js",
      logPath: "/Users/test/log",
      environment: { SHELLBELL_DIR: "/Users/test/State & <Work>" },
    });
    expect(xml).toContain(
      "<key>SHELLBELL_DIR</key><string>/Users/test/State &amp; &lt;Work&gt;</string>",
    );
  });

  it("rejects XML-invalid controls while allowing valid non-BMP characters", () => {
    expect(() =>
      plistFor({ nodePath: "/usr/bin/node", cliPath: "/tmp/cli.js", logPath: "/tmp/a\u0000b" }),
    ).toThrow(/XML/);
    expect(
      plistFor({ nodePath: "/usr/bin/node", cliPath: "/tmp/cli.js", logPath: "/tmp/🔔.log" }),
    ).toContain("/tmp/🔔.log");
  });
});

describe("prepareLogFile (minor: launchd would otherwise create agent.log under the default umask)", () => {
  it("creates a missing log file as 0600", () => {
    const log = join(tmpDir(), "agent.log");
    prepareLogFile(log);
    expect(existsSync(log)).toBe(true);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("chmods an existing, looser-mode log file to 0600 without touching its content", () => {
    const log = join(tmpDir(), "agent.log");
    writeFileSync(log, "existing log content\n", { mode: 0o644 });
    prepareLogFile(log);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, "utf8")).toBe("existing log content\n");
  });
});

const instance = "123e4567-e89b-42d3-a456-426614174000";

function managerFixture() {
  const root = tmpDir();
  const definitionPath = join(root, "shellbell.plist");
  const stateDir = join(root, "State & <Work>");
  const definition: ServiceDefinition = {
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/shellbell/dist/cli.js",
    stateDir,
    serviceInstance: instance,
    environment: {
      SHELLBELL_DIR: stateDir,
      SHELLBELL_SERVICE_INSTANCE: instance,
      PATH: "/opt/node/bin:/usr/bin:/bin",
    },
    logPath: join(root, "agent.log"),
  };
  const parsed = {
    Label: LABEL,
    ProgramArguments: [definition.nodePath, definition.cliPath, "start", "--service"],
    EnvironmentVariables: definition.environment,
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: definition.logPath,
    StandardErrorPath: definition.logPath,
  };
  const calls: Array<{
    executable: string;
    args: readonly string[];
    options: Parameters<ServiceCommand>[2];
  }> = [];
  let loaded = false;
  let disabled = false;
  let printCode: number | null = null;
  let kickstart = "4242\n";
  let bootoutCode = 0;
  let bootstrapCode = 0;
  let parsedObject: unknown = parsed;
  let beforeCommand: ((executable: string, args: readonly string[]) => Promise<void>) | null = null;
  const run: ServiceCommand = async (executable, args, options) => {
    // This fixture models the current job. Legacy registration behavior has its own suite.
    if (args[0] === "print" && args[1]?.includes("/dev.bilalahmad.shellbell")) {
      return { exitCode: 113, stdout: Buffer.alloc(0) };
    }
    calls.push({ executable, args, options });
    if (beforeCommand) await beforeCommand(executable, args);
    if (executable === "/usr/bin/plutil") {
      if (Buffer.from(options.input ?? []).equals(Buffer.from("invalid"))) {
        return { exitCode: 1, stdout: Buffer.alloc(0) };
      }
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify(parsedObject)) };
    }
    if (args[0] === "print") {
      return { exitCode: printCode ?? (loaded ? 0 : 113), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "print-disabled")
      return {
        exitCode: 0,
        stdout: Buffer.from(
          `disabled services = {\n"${LABEL}" => ${disabled ? "disabled" : "enabled"}\n}\n`,
        ),
      };
    if (args[0] === "enable" || args[0] === "disable") {
      disabled = args[0] === "disable";
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (args[0] === "bootstrap") {
      if (disabled) return { exitCode: 5, stdout: Buffer.alloc(0) };
      if (bootstrapCode === 0) loaded = true;
      return { exitCode: bootstrapCode, stdout: Buffer.alloc(0) };
    }
    if (args[0] === "kickstart") {
      return { exitCode: 0, stdout: Buffer.from(kickstart) };
    }
    if (args[0] === "bootout") {
      if (bootoutCode === 0) loaded = false;
      return { exitCode: bootoutCode, stdout: Buffer.alloc(0) };
    }
    throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
  };
  const manager = createLaunchdManager({ run, uid: 501, homeDir: root, definitionPath });
  return {
    manager,
    run,
    definition,
    definitionPath,
    calls,
    setLoaded: (value: boolean) => {
      loaded = value;
    },
    setPrintCode: (value: number) => {
      printCode = value;
    },
    setKickstart: (value: string) => {
      kickstart = value;
    },
    setBootoutCode: (value: number) => {
      bootoutCode = value;
    },
    setBootstrapCode: (value: number) => {
      bootstrapCode = value;
    },
    setParsed: (value: unknown) => {
      parsedObject = value;
    },
    setBeforeCommand: (value: (executable: string, args: readonly string[]) => Promise<void>) => {
      beforeCommand = value;
    },
  };
}

function gate() {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => entered(),
    release: () => release(),
  };
}

describe("createLaunchdManager", () => {
  it("starts explicitly without retaining a temporary startup enablement", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    await f.manager.setStartupEnabled(false);
    expect(await f.manager.load()).toBe(4242);
    expect(await f.manager.inspect()).toMatchObject({ loaded: true, startupEnabled: false });
    await f.manager.unload();
    expect(await f.manager.inspect()).toMatchObject({ loaded: false, startupEnabled: false });
  });

  it("restores disabled startup after a failed explicit start", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    await f.manager.setStartupEnabled(false);
    f.setBootstrapCode(5);
    await expect(f.manager.load()).rejects.toThrow(/bootstrap/);
    expect(await f.manager.inspect()).toMatchObject({ loaded: false, startupEnabled: false });
  });

  it("observes startup separately from loaded state and disables without bootout", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    await f.manager.load();
    expect(await f.manager.inspect()).toMatchObject({ loaded: true, startupEnabled: true });
    await f.manager.setStartupEnabled(false);
    expect(await f.manager.inspect()).toMatchObject({ loaded: true, startupEnabled: false });
    expect(f.calls.some((call) => call.args[0] === "bootout")).toBe(false);
  });
  it("writes an explicit private definition and inspects raw bytes through plutil", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const raw = readFileSync(f.definitionPath);
    expect(raw.toString()).toContain(
      `<key>SHELLBELL_DIR</key><string>${f.definition.stateDir.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")}</string>`,
    );
    expect(statSync(f.definitionPath).mode & 0o777).toBe(0o600);
    const snapshot = await f.manager.inspect();
    expect(snapshot).toMatchObject({ installed: true, loaded: false, definition: f.definition });
    expect(snapshot.raw).toEqual(raw);
    expect(f.calls.find((call) => call.executable === "/usr/bin/plutil")).toMatchObject({
      args: ["-convert", "json", "-o", "-", "-"],
      options: { input: raw, timeoutMs: 5000, maxOutputBytes: 1048576, captureOutput: true },
    });
  });

  it("loads and unloads only the exact GUI service and validates manager PID", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    f.calls.length = 0;
    expect(await f.manager.load()).toBe(4242);
    expect(
      f.calls.filter((call) => call.executable === "/bin/launchctl").map((call) => call.args),
    ).toEqual([
      ["print", `gui/501/${LABEL}`],
      ["print-disabled", "gui/501"],
      ["bootstrap", "gui/501", f.definitionPath],
      ["kickstart", "-p", `gui/501/${LABEL}`],
    ]);
    await f.manager.unload();
    expect(f.calls.filter((call) => call.args[0] === "bootout").map((call) => call.args)).toEqual([
      ["bootout", `gui/501/${LABEL}`],
    ]);
  });

  it("preserves the definition when bootout fails", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const before = readFileSync(f.definitionPath);
    f.setLoaded(true);
    f.setBootoutCode(5);
    await expect(f.manager.unload()).rejects.toThrow(/bootout/);
    expect(readFileSync(f.definitionPath)).toEqual(before);
    expect(f.calls.some((call) => call.args[0] === "bootstrap")).toBe(false);
  });

  it("rejects malformed PID, disabled bootstrap, and GUI-domain inspection errors", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    f.setKickstart("PID: 4242");
    await expect(f.manager.load()).rejects.toThrow(/PID/);
    f.setLoaded(false);
    f.setBootstrapCode(5);
    await expect(f.manager.load()).rejects.toThrow(/bootstrap/);
    f.setPrintCode(112);
    await expect(f.manager.inspect()).rejects.toThrow(/print/);
  });

  it.each(["0", "2147483648", "1 2", "PID: 42", ""])(
    "rejects malformed kickstart PID %j",
    async (pid) => {
      const f = managerFixture();
      await f.manager.write(f.definition);
      f.setKickstart(pid);
      await expect(f.manager.load()).rejects.toThrow(/PID/);
    },
  );

  it("treats only exit 113 as absent and propagates permission and timeout failures", async () => {
    const f = managerFixture();
    expect(await f.manager.inspect()).toMatchObject({ installed: false, loaded: false });
    f.setPrintCode(5);
    await expect(f.manager.inspect()).rejects.toThrow(/print/);
    const timeout = createLaunchdManager({
      uid: 501,
      homeDir: tmpDir(),
      run: async () => {
        throw new Error("launchctl timed out");
      },
    });
    await expect(timeout.inspect()).rejects.toThrow(/timed out/);
  });

  it("reads legacy definitions with the historical state directory and no instance", async () => {
    const f = managerFixture();
    writeFileSync(f.definitionPath, "legacy", { mode: 0o600 });
    f.setParsed({
      Label: LABEL,
      ProgramArguments: [f.definition.nodePath, f.definition.cliPath, "start", "--service"],
      EnvironmentVariables: { PATH: "/usr/bin:/bin" },
      RunAtLoad: true,
      KeepAlive: true,
      StandardOutPath: f.definition.logPath,
      StandardErrorPath: f.definition.logPath,
    });
    const snapshot = await f.manager.inspect();
    expect(snapshot.definition?.stateDir).toBe(join(dirname(f.definitionPath), ".shellbell"));
    expect(snapshot.definition?.serviceInstance).toBeNull();
  });

  it("rejects a symlink definition before invoking plutil", async () => {
    const f = managerFixture();
    const target = join(dirname(f.definitionPath), "target.plist");
    writeFileSync(target, "other", { mode: 0o600 });
    symlinkSync(target, f.definitionPath);
    await expect(f.manager.inspect()).rejects.toThrow(/metadata/);
    expect(f.calls.some((call) => call.executable === "/usr/bin/plutil")).toBe(false);
  });

  it("rejects unknown, symlinked and world-writable existing definitions", async () => {
    const f = managerFixture();
    writeFileSync(f.definitionPath, "unknown", { mode: 0o600 });
    f.setParsed({ Label: "other.job" });
    await expect(f.manager.write(f.definition)).rejects.toThrow();
    expect(readFileSync(f.definitionPath, "utf8")).toBe("unknown");
    f.setParsed({ Label: LABEL });
    chmodSync(f.definitionPath, 0o666);
    await expect(f.manager.inspect()).rejects.toThrow();
  });

  it("does not publish a definition over an already-loaded orphan job", async () => {
    const f = managerFixture();
    f.setLoaded(true);
    await expect(f.manager.write(f.definition)).rejects.toThrow(/loaded.*definition/);
    expect(existsSync(f.definitionPath)).toBe(false);
  });

  it("rejects contradictory and empty optional environment before a write", async () => {
    const f = managerFixture();
    await expect(
      f.manager.write({
        ...f.definition,
        environment: { ...f.definition.environment, SHELLBELL_DIR: "/wrong" },
      }),
    ).rejects.toThrow(/disagree/);
    await expect(
      f.manager.write({
        ...f.definition,
        environment: { ...f.definition.environment, HERDR_SOCKET_PATH: "" },
      }),
    ).rejects.toThrow(/HERDR_SOCKET_PATH/);
    expect(existsSync(f.definitionPath)).toBe(false);
  });

  it("rejects a recognizable label with unexpected persisted environment", async () => {
    const f = managerFixture();
    writeFileSync(f.definitionPath, "existing", { mode: 0o600 });
    f.setParsed({
      Label: LABEL,
      ProgramArguments: [f.definition.nodePath, f.definition.cliPath, "start", "--service"],
      EnvironmentVariables: { PATH: "/usr/bin", PRIVATE_SECRET: "do-not-persist" },
      RunAtLoad: true,
      KeepAlive: true,
      StandardOutPath: f.definition.logPath,
      StandardErrorPath: f.definition.logPath,
    });
    await expect(f.manager.write(f.definition)).rejects.toThrow(/environment/);
    expect(readFileSync(f.definitionPath, "utf8")).toBe("existing");
  });

  it("rejects conflicting Program even when ProgramArguments look valid", async () => {
    const f = managerFixture();
    writeFileSync(f.definitionPath, "existing", { mode: 0o600 });
    f.setParsed({
      Label: LABEL,
      Program: "/tmp/other-executable",
      ProgramArguments: [f.definition.nodePath, f.definition.cliPath, "start", "--service"],
      EnvironmentVariables: f.definition.environment,
      RunAtLoad: true,
      KeepAlive: true,
      StandardOutPath: f.definition.logPath,
      StandardErrorPath: f.definition.logPath,
    });
    await expect(f.manager.inspect()).rejects.toThrow(/definition|Program/);
    expect(readFileSync(f.definitionPath, "utf8")).toBe("existing");
  });

  it("preserves replacement of a previously validated definition during async write", async () => {
    const f = managerFixture();
    writeFileSync(f.definitionPath, "previous", { mode: 0o600 });
    const pause = gate();
    f.setBeforeCommand(async (executable) => {
      if (executable === "/usr/bin/plutil") {
        pause.enter();
        await pause.wait;
      }
    });
    const pending = f.manager.write(f.definition);
    await pause.entered;
    writeFileSync(f.definitionPath, "replacement", { mode: 0o600 });
    pause.release();
    await expect(pending).rejects.toThrow(/changed|replacement/);
    expect(readFileSync(f.definitionPath, "utf8")).toBe("replacement");
  });

  it("preserves a definition appearing while initially absent write waits for print", async () => {
    const f = managerFixture();
    const pause = gate();
    f.setBeforeCommand(async (_executable, args) => {
      if (args[0] === "print") {
        pause.enter();
        await pause.wait;
      }
    });
    const pending = f.manager.write(f.definition);
    await pause.entered;
    writeFileSync(f.definitionPath, "new owner", { mode: 0o600 });
    pause.release();
    await expect(pending).rejects.toThrow(/changed|replacement/);
    expect(readFileSync(f.definitionPath, "utf8")).toBe("new owner");
  });

  it("preserves replacement during restore's second async plutil conversion", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const pause = gate();
    let conversions = 0;
    f.setBeforeCommand(async (executable) => {
      if (executable === "/usr/bin/plutil" && ++conversions === 2) {
        pause.enter();
        await pause.wait;
      }
    });
    const pending = f.manager.restore(Buffer.from("binary-original"));
    await pause.entered;
    writeFileSync(f.definitionPath, "replacement", { mode: 0o600 });
    pause.release();
    await expect(pending).rejects.toThrow(/changed|replacement/);
    expect(readFileSync(f.definitionPath, "utf8")).toBe("replacement");
  });

  it("lets a fresh manager uninstall only the definition it inspected", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const fresh = createLaunchdManager({
      run: f.run,
      uid: 501,
      homeDir: dirname(f.definitionPath),
      definitionPath: f.definitionPath,
    });
    f.setLoaded(true);
    expect((await fresh.inspect()).installed).toBe(true);
    await fresh.unload();
    await fresh.restore(null);
    expect(existsSync(f.definitionPath)).toBe(false);
  });

  it("does not adopt a replacement after a fresh manager inspects a definition or absence", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const fresh = createLaunchdManager({
      run: f.run,
      uid: 501,
      homeDir: dirname(f.definitionPath),
      definitionPath: f.definitionPath,
    });
    await fresh.inspect();
    writeFileSync(f.definitionPath, "replacement", { mode: 0o600 });
    await expect(fresh.inspect()).rejects.toThrow(/changed|replac/);
    await expect(fresh.restore(null)).rejects.toThrow(/changed|replacement/);
    expect(readFileSync(f.definitionPath, "utf8")).toBe("replacement");
    const absent = managerFixture();
    await absent.manager.inspect();
    writeFileSync(absent.definitionPath, "new owner", { mode: 0o600 });
    await expect(absent.manager.inspect()).rejects.toThrow(/changed|replac/);
    await expect(absent.manager.restore(null)).rejects.toThrow(/changed|replacement/);
    expect(readFileSync(absent.definitionPath, "utf8")).toBe("new owner");
  });

  it("restores binary plist bytes exactly and refuses removal after replacement", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const binary = Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0, 0xff, 0x80]);
    await f.manager.restore(binary);
    expect(readFileSync(f.definitionPath)).toEqual(binary);
    writeFileSync(f.definitionPath, "replacement", { mode: 0o600 });
    await expect(f.manager.restore(null)).rejects.toThrow();
    expect(readFileSync(f.definitionPath, "utf8")).toBe("replacement");
  });

  it("does not restore bytes that plutil rejects", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    const before = readFileSync(f.definitionPath);
    await expect(f.manager.restore(Buffer.from("invalid"))).rejects.toThrow(/plutil/);
    expect(readFileSync(f.definitionPath)).toEqual(before);
  });

  it("refuses to remove an owned definition after unexpected metadata replacement", async () => {
    const f = managerFixture();
    await f.manager.write(f.definition);
    chmodSync(f.definitionPath, 0o400);
    await expect(f.manager.restore(null)).rejects.toThrow(/replac/);
    expect(existsSync(f.definitionPath)).toBe(true);
  });
});
