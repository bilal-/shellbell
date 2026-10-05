import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, chmodSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SystemdCommand } from "../src/systemd-manager.js";
import { managerApi, shown, systemdFixture } from "./systemd-fixtures.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("unexpected process spawn");
  }),
  exec: () => {
    throw new Error("unexpected process exec");
  },
  execFile: () => {
    throw new Error("unexpected process execFile");
  },
  execFileSync: () => {
    throw new Error("unexpected process execFileSync");
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, accessSync: vi.fn(fs.accessSync) };
});

describe("local systemd manager", () => {
  it("escapes local bus address bytes and ignores hostile inherited transports", async () => {
    const f = systemdFixture();
    const runtime = join(f.root, "run ,;%=雪");
    renameSync(f.runtime, runtime);
    const calls: Parameters<SystemdCommand>[] = [];
    const api = await managerApi();
    const manager = api.createSystemdManager({
      location: { ...f.location, managerRuntimeRoot: runtime },
      runtimeFsType: () => 0x01021994,
      run: async (...args) => {
        calls.push(args);
        return { exitCode: 0, stdout: Buffer.from(shown) };
      },
    });
    await manager.observe();
    expect(calls[0]![2].env.DBUS_SESSION_BUS_ADDRESS).toBe(
      `unix:path=${f.root}/run%20%2c%3b%25%3d%e9%9b%aa/bus`,
    );
    expect(calls[0]![2].env).not.toHaveProperty("SHELLBELL_SECRET_TEST_SENTINEL");
  });
  it.each(["missing", "symlink", "filesystem", "uid", "name"])(
    "refuses unsafe transport/target without invoking a command: %s",
    async (kind) => {
      const f = systemdFixture();
      const location = { ...f.location };
      if (kind === "missing") location.managerRuntimeRoot = join(f.root, "missing");
      if (kind === "symlink") {
        location.managerRuntimeRoot = join(f.root, "alias");
        symlinkSync(f.runtime, location.managerRuntimeRoot);
      }
      if (kind === "uid") location.uid += 1;
      if (kind === "name") location.unitName = "--global";
      const calls: Parameters<SystemdCommand>[] = [];
      const api = await managerApi();
      const manager = api.createSystemdManager({
        location,
        runtimeFsType: () => (kind === "filesystem" ? 0x6969 : 0x01021994),
        run: async (...args) => {
          calls.push(args);
          return { exitCode: 0, stdout: Buffer.from(shown) };
        },
      });
      expect((await manager.observe()).available).toBe(false);
      await expect(manager.execute("start")).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );
  it("does not equate a nonzero observation with an absent unit", async () => {
    const f = systemdFixture();
    const api = await managerApi();
    const manager = api.createSystemdManager({
      location: f.location,
      runtimeFsType: () => 0x01021994,
      run: async () => ({ exitCode: 1, stdout: Buffer.from(shown) }),
    });
    expect(await manager.observe()).toMatchObject({
      available: false,
      loadState: "unknown",
      activeState: "unknown",
    });
    await expect(manager.execute("stop")).rejects.toThrow();
    expect(await manager.linger()).toBe("unknown");
  });
  it.each(["timeout", "overflow", "success", "error", "exit"])(
    "bounds spawned commands and cleans up owned child: %s",
    async (outcome) => {
      const f = systemdFixture();
      const api = await managerApi();
      expect(api.createSystemdManager).toBeTypeOf("function");
      vi.useFakeTimers();
      try {
        vi.mocked(accessSync).mockImplementation((path) => {
          if (path !== "/usr/bin/systemctl") throw new Error("unexpected binary");
        });
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(() => true),
        });
        vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
        const manager = api.createSystemdManager({
          location: f.location,
          runtimeFsType: () => 0x01021994,
        });
        const result = manager.execute("start").then(
          () => "ok",
          (error: Error) => error.message,
        );
        expect(spawn).toHaveBeenCalledWith(
          "/usr/bin/systemctl",
          expect.any(Array),
          expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
        );
        if (outcome === "success") child.emit("close", 0);
        if (outcome === "exit") child.emit("close", 1);
        if (outcome === "error") child.emit("error", new Error("SECRET"));
        if (outcome === "overflow") {
          child.stdout.write(Buffer.alloc(32768));
          child.stderr.write(Buffer.alloc(32769));
        }
        if (outcome === "timeout") await vi.advanceTimersByTimeAsync(30000);
        if (outcome === "timeout" || outcome === "overflow") {
          expect(child.kill).toHaveBeenCalledWith("SIGTERM");
          await vi.advanceTimersByTimeAsync(250);
          expect(child.kill).toHaveBeenCalledWith("SIGKILL");
          child.emit("close", null);
        }
        expect(await result).toBe(
          outcome === "success" ? "ok" : "shellbell: systemd command failed",
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("uses fixed scoped commands and a pinned minimal manager environment", async () => {
    const f = systemdFixture();
    const api = await managerApi();
    expect(api.createSystemdManager).toBeTypeOf("function");
    const calls: Parameters<SystemdCommand>[] = [];
    const manager = api.createSystemdManager({
      location: f.location,
      runtimeFsType: () => 0x01021994,
      run: async (...args) => {
        calls.push(args);
        return { exitCode: 0, stdout: Buffer.from(shown) };
      },
    });
    await manager.execute("start");
    expect(calls[0]![0]).toBe("/usr/bin/systemctl");
    expect(calls[0]![1]).toEqual([
      "--user",
      "--no-pager",
      "--no-ask-password",
      "start",
      f.location.unitName,
    ]);
    expect(calls[0]![2]).toEqual({
      timeoutMs: 30000,
      maxOutputBytes: 65536,
      env: {
        HOME: f.home,
        XDG_CONFIG_HOME: f.location.configRoot,
        XDG_RUNTIME_DIR: f.runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${f.runtime}/bus`,
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      },
    });
    await manager.execute("daemon-reload");
    expect(calls[1]![1]).toEqual(["--user", "--no-pager", "--no-ask-password", "daemon-reload"]);
    expect(await manager.observe()).toMatchObject({
      available: true,
      activeState: "active",
      mainPid: 123,
      needDaemonReload: false,
      conditionResult: true,
    });
    expect(calls[2]![1]).toEqual([
      "--user",
      "--no-pager",
      "--no-ask-password",
      "show",
      "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState,FragmentPath,DropInPaths,NeedDaemonReload,ConditionResult",
      f.location.unitName,
    ]);
    await expect(manager.execute("enable" as "start")).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });
  it.each([
    "MainPID=-1",
    "MainPID=9007199254740992",
    "MainPID=1.5",
    "NeedDaemonReload=maybe",
    "ConditionResult=1",
    "ActiveState=future",
    "SubState=future",
    "LoadState=future",
    "UnitFileState=future",
    "FragmentPath=/control\u0085",
  ])("marks malformed or unknown manager state unready: %s", async (line) => {
    const f = systemdFixture();
    const api = await managerApi();
    expect(api.createSystemdManager).toBeTypeOf("function");
    const key = line.split("=")[0]!;
    const manager = api.createSystemdManager({
      location: f.location,
      runtimeFsType: () => 0x01021994,
      run: async () => ({
        exitCode: 0,
        stdout: Buffer.from(shown.replace(new RegExp(`${key}=.*`), line)),
      }),
    });
    expect(await manager.observe()).toMatchObject({
      available: false,
      activeState: "unknown",
      mainPid: null,
    });
  });
  it.each([
    `${shown}MainPID=5\n`,
    `${shown}Unexpected=secret\n`,
    shown.replace("DropInPaths=\n", ""),
    "secret",
    "x".repeat(65537),
  ])(
    "rejects incomplete, duplicate, extra or oversized output without disclosure",
    async (output) => {
      const f = systemdFixture();
      const api = await managerApi();
      expect(api.createSystemdManager).toBeTypeOf("function");
      const manager = api.createSystemdManager({
        location: f.location,
        runtimeFsType: () => 0x01021994,
        run: async () => ({ exitCode: 0, stdout: Buffer.from(output) }),
      });
      const observation = await manager.observe();
      expect(observation.available).toBe(false);
      expect(JSON.stringify(observation)).not.toContain("secret");
    },
  );
  it("fails closed on unsafe transport, nonzero exits and runner errors", async () => {
    const f = systemdFixture();
    const api = await managerApi();
    expect(api.createSystemdManager).toBeTypeOf("function");
    const run: SystemdCommand = async () => {
      throw new Error("SECRET STDERR");
    };
    const manager = api.createSystemdManager({
      location: f.location,
      runtimeFsType: () => 0x01021994,
      run,
    });
    await expect(manager.execute("stop")).rejects.toThrow(/^shellbell: systemd command failed$/);
    expect(await manager.observe()).toMatchObject({ available: false, mainPid: null });
    chmodSync(f.runtime, 0o755);
    await expect(manager.execute("stop")).rejects.toThrow();
    expect(await manager.linger()).toBe("unknown");
  });
  it.each(["yes", "no", "unexpected"])("reads only exact-user linger policy %s", async (value) => {
    const f = systemdFixture();
    const api = await managerApi();
    expect(api.createSystemdManager).toBeTypeOf("function");
    const calls: Parameters<SystemdCommand>[] = [];
    const manager = api.createSystemdManager({
      location: f.location,
      runtimeFsType: () => 0x01021994,
      run: async (...args) => {
        calls.push(args);
        return { exitCode: 0, stdout: Buffer.from(`${value}\n`) };
      },
    });
    expect(await manager.linger()).toBe(value === "unexpected" ? "unknown" : value);
    expect(calls[0]![0]).toBe("/usr/bin/loginctl");
    expect(calls[0]![1]).toEqual([
      "--no-pager",
      "--no-ask-password",
      "show-user",
      String(f.location.uid),
      "--property=Linger",
      "--value",
    ]);
  });
});
