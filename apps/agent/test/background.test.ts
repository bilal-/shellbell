import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureLinuxHost, macBackground } from "../src/background.js";
import {
  describeBackground,
  installBackground,
  MACOS_SERVICE_PROMPTS,
} from "../src/background-commands.js";
import { resolveLinuxPaths } from "../src/host-paths.js";
import { inspectLinuxState } from "../src/host-state.js";
import { ServiceLifecycleError, type ServiceStatus } from "../src/service-lifecycle.js";
import { SystemdUnavailableError } from "../src/systemd-lifecycle.js";
import { fixture } from "./host-fixtures.js";

const runtime = { nodePath: "/opt/node", cliPath: "/opt/shellbell/dist/cli.js" };
const stopped: ServiceStatus = {
  manager: "launchd",
  definitionPath: "/owned/service.plist",
  installed: false,
  loaded: false,
  startupEnabled: null,
  autostartConfigured: false,
  managedPid: null,
  ownership: "none",
  local: null,
  ready: false,
};
const running = (version: string): ServiceStatus => ({
  ...stopped,
  installed: true,
  loaded: true,
  startupEnabled: true,
  autostartConfigured: true,
  ready: true,
  local: {
    controlVersion: 1,
    process: {
      pid: 7,
      agentVersion: version,
      computerFp: "a".repeat(26),
      stateDir: "/state",
      serviceInstance: "550e8400-e29b-41d4-a716-446655440000",
    },
    backends: [],
    terminalReady: false,
  } as unknown as ServiceStatus["local"],
});

function fakeLaunchd(initial: ServiceStatus, installed = runtime) {
  let state = initial;
  const calls: string[] = [];
  const lifecycle = {
    installedRuntime: async () => (state.installed ? { ...installed, stateDir: "/state" } : null),
    status: async () => state,
    install: vi.fn(async () => {
      calls.push("install");
      state = running("2.0.0");
      return state;
    }),
    start: async () => state,
    stop: async () => state,
    restart: async () => state,
    uninstall: async () => state,
    enable: vi.fn(async () => {
      calls.push("enable");
      state = { ...state, startupEnabled: true };
      return state;
    }),
  };
  return { lifecycle, calls, background: macBackground(lifecycle, () => runtime) };
}

function capture() {
  const lines: string[] = [];
  return { lines, out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
}

describe("macOS background", () => {
  it("installs a Mac that doesn't run Shellbell yet and says what macOS may ask", async () => {
    const f = fakeLaunchd(stopped);
    const { lines, out } = capture();
    expect(
      await installBackground({ background: () => f.background, version: "2.0.0" }, false, out),
    ).toBe(0);
    expect(f.calls).toEqual(["install"]);
    expect(lines.join("\n")).toMatch(
      /2\.0\.0 is running in the background and starts again whenever you log in/,
    );
    expect(lines.join("\n")).toMatch(/After this Mac restarts, log in once/);
    expect(lines.at(-1)).toBe(MACOS_SERVICE_PROMPTS);
  });

  it("leaves the running copy alone when it already is this version from the same files", async () => {
    const f = fakeLaunchd(running("2.0.0"));
    expect((await f.background.install("2.0.0")).running).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("reinstalls when another version or another copy of the files runs", async () => {
    expect((await fakeLaunchd(running("1.9.0")).background.install("2.0.0")).version).toBe("2.0.0");
    const moved = fakeLaunchd(running("2.0.0"), { ...runtime, cliPath: "/old/dist/cli.js" });
    await moved.background.install("2.0.0");
    expect(moved.calls).toEqual(["install"]);
  });

  it("turns start-at-login back on without restarting", async () => {
    const f = fakeLaunchd({ ...running("2.0.0"), startupEnabled: false });
    expect((await f.background.install("2.0.0")).startsAtLogin).toBe(true);
    expect(f.calls).toEqual(["enable"]);
  });

  it("checks the files it would install before reading any state", async () => {
    const f = fakeLaunchd(stopped);
    const status = vi.spyOn(f.lifecycle, "status");
    const background = macBackground(f.lifecycle, () => {
      throw new Error("source checkout is not an installed built package");
    });
    const { lines, out } = capture();
    expect(
      await installBackground({ background: () => background, version: "2.0.0" }, false, out),
    ).toBe(2);
    expect(lines.join(" ")).toMatch(/installed built package/);
    expect(status).not.toHaveBeenCalled();
  });

  it("keeps a failed change's recovery details, structured in JSON", async () => {
    const f = fakeLaunchd(stopped);
    const failure = new ServiceLifecycleError("launch failed");
    failure.rollback = "failed";
    failure.rollbackDiagnostic = "unload denied";
    failure.recoveryPath = "/owned/recovery";
    f.lifecycle.install.mockRejectedValueOnce(failure);
    const json = capture();
    expect(
      await installBackground({ background: () => f.background, version: "2" }, true, json.out),
    ).toBe(2);
    expect(JSON.parse(json.lines[0]!)).toEqual({
      error: "launch failed",
      rollback: "failed",
      rollbackDiagnostic: "unload denied",
      recoveryPath: "/owned/recovery",
    });
    f.lifecycle.install.mockRejectedValueOnce(failure);
    const text = capture();
    await installBackground({ background: () => f.background, version: "2" }, false, text.out);
    expect(text.lines.join(" ")).toMatch(
      /couldn't put the previous setup back \(unload denied\).*\/owned\/recovery/,
    );
  });

  it("does nothing when the Mac app runs Shellbell", async () => {
    const f = fakeLaunchd(stopped);
    const { out } = capture();
    expect(
      await installBackground(
        { background: () => f.background, version: "2", appOwned: () => true },
        false,
        out,
      ),
    ).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it("says a computer without background services should use run", async () => {
    const f = fakeLaunchd(stopped);
    f.lifecycle.install.mockRejectedValueOnce(new SystemdUnavailableError("x"));
    const { lines, out } = capture();
    await installBackground({ background: () => f.background, version: "2" }, false, out);
    expect(lines.join(" ")).toMatch(/can't run Shellbell in the background.*shellbell run/);
  });
});

describe("describeBackground", () => {
  const base = {
    installed: true,
    running: true,
    startsAtLogin: true,
    available: true,
    version: "1.2.3",
    service: stopped,
  };
  it("names the next step for each way Shellbell can be stopped", () => {
    expect(describeBackground({ ...base, running: false, installed: false }, "macos")[0]).toMatch(
      /Run `shellbell install`/,
    );
    expect(describeBackground({ ...base, running: false }, "macos")[0]).toMatch(
      /starts again the next time you log in/,
    );
    expect(describeBackground({ ...base, running: false, available: false }, "linux")[0]).toMatch(
      /shellbell run/,
    );
  });
  it("says Linux stops at logout until linger is on", () => {
    expect(describeBackground({ ...base, keepsRunningAfterLogout: false }, "linux", "sam")[1]).toBe(
      "It stops when you log out. To keep it running after you log out, an administrator can run: sudo loginctl enable-linger sam",
    );
    expect(describeBackground({ ...base, keepsRunningAfterLogout: true }, "linux")).toHaveLength(1);
  });
});

describe("ensureLinuxHost", () => {
  it("creates this computer's identity once when it has no Shellbell state", async () => {
    const f = fixture();
    const p = resolveLinuxPaths(f.options);
    await ensureLinuxHost(p, { home: f.options.home });
    expect(inspectLinuxState(p).status).toBe("ready");
    await ensureLinuxHost(p, { home: f.options.home });
    expect(inspectLinuxState(p).status).toBe("ready");
  });

  it("never makes a second identity while an older Shellbell keeps one in ~/.shellbell", async () => {
    const f = fixture();
    const p = resolveLinuxPaths(f.options);
    mkdirSync(join(f.options.home, ".shellbell"), { recursive: true });
    writeFileSync(join(f.options.home, ".shellbell", "identity.json"), "{}");
    await expect(ensureLinuxHost(p, { home: f.options.home })).rejects.toThrow(
      /already has an identity on this computer.*won't make a new one/,
    );
    expect(existsSync(p.identity)).toBe(false);
  });

  it("never makes a second identity when the background service keeps its own elsewhere", async () => {
    const f = fixture();
    const p = resolveLinuxPaths(f.options);
    await expect(
      ensureLinuxHost(p, { home: f.options.home, installedStateDir: "/srv/elsewhere" }),
    ).rejects.toThrow(/in \/srv\/elsewhere/);
    await expect(
      ensureLinuxHost(p, { home: f.options.home, installedStateDir: p.dir }),
    ).rejects.toThrow(/identity is missing/);
    expect(existsSync(p.identity)).toBe(false);
  });

  it("refuses a state folder this computer didn't create", async () => {
    const f = fixture();
    const p = resolveLinuxPaths(f.options);
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(p.dir, "identity.json"), "{}", { mode: 0o600 });
    await expect(ensureLinuxHost(p, { home: f.options.home })).rejects.toThrow(
      /didn't create|safety checks/,
    );
  });
});
