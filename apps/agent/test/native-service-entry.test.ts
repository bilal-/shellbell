import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { buildAgent } from "../src/cli.js";
import { createLogger } from "../src/log.js";
import {
  admitNativeState,
  runNativeService,
  sanitizeNativeEnvironment,
} from "../src/native/service-entry.js";
import { ServiceOwnerStore } from "../src/service-ownership.js";
import { nativeFixture } from "./native-fixture.js";

// Observe real I/O without substituting file contents or filesystem behavior.
const fileReads = vi.hoisted(() => ({
  paths: new Set<string>(),
  descriptors: new Map<number, string>(),
  foreignLog: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      const fd = fs.openSync(...args);
      fileReads.descriptors.set(fd, String(args[0]));
      return fd;
    },
    closeSync(fd: number) {
      try {
        return fs.closeSync(fd);
      } finally {
        fileReads.descriptors.delete(fd);
      }
    },
    readSync(...args: Parameters<typeof fs.readSync>) {
      const path = fileReads.descriptors.get(args[0]);
      if (path) fileReads.paths.add(path);
      return fs.readSync(...args);
    },
    readFileSync(...args: Parameters<typeof fs.readFileSync>) {
      fileReads.paths.add(String(args[0]));
      return fs.readFileSync(...args);
    },
    lstatSync(...args: Parameters<typeof fs.lstatSync>) {
      const stat = fs.lstatSync(...args);
      if (stat && String(args[0]) === fileReads.foreignLog) stat.uid = process.getuid!() + 1;
      return stat;
    },
  };
});

const fixtures: ReturnType<typeof nativeFixture>[] = [];
it("native engine startup drops detector presentation instead of retaining a hidden output queue", async () => {
  const f = await fixture(),
    output = vi.spyOn(console, "log").mockImplementation(() => {});
  const engine = await buildAgent(createLogger({ stdout: false }), undefined, false, {
    paths: f.p,
    serviceInstance: f.selection.serviceInstance,
    nativeService: true,
    itermBackend: null,
    startHerdr: (options) => {
      options.onUnavailable?.();
      return { stop() {} };
    },
    tmuxBackendOptions: {
      execImpl: async () => {
        throw new Error("fixture no tmux");
      },
    },
  });
  try {
    engine.releaseOutput();
    expect(output).not.toHaveBeenCalled();
  } finally {
    engine.stopBackendDetectors();
    engine.agent.stop();
    output.mockRestore();
  }
});
afterEach(() => {
  fileReads.foreignLog = undefined;
  fileReads.paths.clear();
  fileReads.descriptors.clear();
  for (const f of fixtures.splice(0)) f.close();
});
it("admits an appended log beyond the real logger's rotation threshold without reading or changing it", async () => {
  const f = await fixture(),
    log = createLogger({ file: f.p.log, stdout: false });
  log.info("fixture initial entry");
  log.info("x".repeat(1048576));
  const before = lstatSync(f.p.log),
    bytes = readFileSync(f.p.log);
  expect(before.size).toBeGreaterThan(1048576);
  fileReads.paths.clear();
  expect(admitNativeState(f.stateDir, process.getuid!())?.fp).toBe(f.identity.fp);
  let started = false;
  const owner = await runNativeService("manual", {
    bundlePath: f.bundle,
    root: f.root,
    uid: process.getuid!(),
    start: async () => {
      started = true;
      return {
        async stop() {
          started = false;
        },
      };
    },
  });
  expect(started).toBe(true);
  expect(fileReads.paths.has(f.p.log)).toBe(false);
  const after = lstatSync(f.p.log);
  expect({
    ino: after.ino,
    uid: after.uid,
    mode: after.mode,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  }).toEqual({
    ino: before.ino,
    uid: before.uid,
    mode: before.mode,
    size: before.size,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  });
  expect(readFileSync(f.p.log)).toEqual(bytes);
  await owner.stop();
});
it.each(["mode", "directory", "symlink", "foreign-owner"])(
  "refuses unsafe log %s metadata without starting the engine",
  async (kind) => {
    const f = await fixture();
    if (kind === "directory") mkdirSync(f.p.log, { mode: 0o700 });
    else if (kind === "symlink") {
      const target = join(f.dir, "fixture-log-target");
      writeFileSync(target, "fixture", { mode: 0o600 });
      symlinkSync(target, f.p.log);
    } else {
      createLogger({ file: f.p.log, stdout: false }).info("fixture");
      if (kind === "mode") chmodSync(f.p.log, 0o644);
      else fileReads.foreignLog = f.p.log;
    }
    const start = vi.fn();
    await expect(
      runNativeService("manual", {
        bundlePath: f.bundle,
        root: f.root,
        uid: process.getuid!(),
        start,
      }),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(start).not.toHaveBeenCalled();
  },
);
async function fixture() {
  const f = nativeFixture();
  fixtures.push(f);
  await f.store.mutate(null, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  return f;
}
it("stops desktop creation that races owner EOF without leaving an engine behind", async () => {
  const f = await fixture();
  f.selection.mode = "desktop";
  await f.store.mutate(f.store.inspect()!.revision, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  const ownership = new ServiceOwnerStore({ stateDir: f.stateDir, uid: process.getuid!() });
  await ownership.mutate(null, async (tx) => {
    tx.publish({ v: 1, mode: "desktop", consented: true, startupEnabled: false, transition: null });
  });
  const input = new PassThrough();
  let entered!: () => void,
    release!: () => void,
    stopped = 0;
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starting = runNativeService("desktop", {
    bundlePath: f.bundle,
    root: f.root,
    uid: process.getuid!(),
    ownerInput: input,
    start: async () => {
      entered();
      await gate;
      return {
        stop: async () => {
          stopped++;
        },
      };
    },
  });
  const result = expect(starting).rejects.toMatchObject({ code: "unavailable" });
  input.write(`${JSON.stringify({ v: 1, instance: f.selection.serviceInstance })}\n`);
  await begun;
  input.end();
  await new Promise<void>((resolve) => input.once("end", resolve));
  release();
  await result;
  expect(stopped).toBe(1);
});
it("does not admit a desktop engine without explicit ownership consent", async () => {
  const f = await fixture();
  f.selection.mode = "desktop";
  await f.store.mutate(f.store.inspect()!.revision, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  const input = new PassThrough(),
    start = vi.fn();
  try {
    await expect(
      runNativeService("desktop", {
        bundlePath: f.bundle,
        root: f.root,
        uid: process.getuid!(),
        ownerInput: input,
        start,
      }),
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  } finally {
    input.destroy();
  }
});
it("starts only the selected mode and exact identity", async () => {
  const f = await fixture();
  let started = false;
  const owner = await runNativeService("manual", {
    bundlePath: f.bundle,
    root: f.root,
    uid: process.getuid!(),
    start: async (s) => {
      expect(s.computerFp).toBe(f.identity.fp);
      started = true;
      return {
        async stop() {
          started = false;
        },
      };
    },
  });
  expect(started).toBe(true);
  await owner.stop();
  expect(started).toBe(false);
});
it.each(["persistent", "foreign-bundle"])("refuses %s before engine startup", async (which) => {
  const f = await fixture();
  const start = vi.fn();
  await expect(
    runNativeService(which === "persistent" ? "persistent" : "manual", {
      bundlePath: which === "foreign-bundle" ? join(f.dir, "Other.app") : f.bundle,
      root: f.root,
      uid: process.getuid!(),
      start,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(start).not.toHaveBeenCalled();
});
it("rejects a symlink to fixture-owned secret before reading it", async () => {
  const f = await fixture();
  const target = join(f.dir, "other.json");
  writeFileSync(target, "{}", { mode: 0o600 });
  symlinkSync(target, f.p.pairings);
  const start = vi.fn();
  await expect(
    runNativeService("manual", {
      bundlePath: f.bundle,
      root: f.root,
      uid: process.getuid!(),
      start,
    }),
  ).rejects.toMatchObject({ code: "unsafe-state" });
  expect(start).not.toHaveBeenCalled();
});
it("rejects inherited Node injection and produces only admitted service variables", async () => {
  const f = await fixture();
  expect(() =>
    sanitizeNativeEnvironment(f.selection, f.dir, { NODE_OPTIONS: "--require attacker" }),
  ).toThrow();
  expect(
    sanitizeNativeEnvironment(f.selection, f.dir, { HOME: "/untrusted", EXTRA_SECRET: "secret" }),
  ).toEqual({ ...f.selection.environment, HOME: f.dir });
});
it("native entry imports never initialize user state", async () => {
  const f = await fixture();
  await import("../src/native-controller.js");
  await import("../src/native-service.js");
  expect(f.calls).toEqual([]);
});
