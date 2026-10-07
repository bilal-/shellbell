import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { processAlive } from "../src/control-guard.js";
import { NativeCoordinator } from "../src/native/coordinator.js";
import { DesktopSupervisor } from "../src/native/desktop-supervisor.js";
import { nativeFixture } from "./native-fixture.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const owners: DesktopSupervisor[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(behavior = "normal") {
  const f = nativeFixture();
  fixtures.push(f);
  f.selection.mode = "desktop";
  writeFileSync(
    join(f.stateDir, "desktop-fixture.json"),
    JSON.stringify({ fp: f.identity.fp, behavior }),
    { mode: 0o600 },
  );
  const supervisor = new DesktopSupervisor({
    uid: process.getuid!(),
    homeDir: f.dir,
    admitBundle: async () => ({
      ...(await f.inspectBundle()),
      nodePath: process.execPath,
      servicePath: fileURLToPath(new URL("./fakes/desktop-child.ts", import.meta.url)),
    }),
    stopTimeoutMs: 1000,
  });
  owners.push(supervisor);
  return { ...f, supervisor };
}
it("certifies a real child then stops it by closing only the private owner pipe", async () => {
  const f = fixture();
  const job = await f.supervisor.start(f.selection);
  expect(job.loaded).toBe(true);
  expect(job.pid).toBeGreaterThan(0);
  expect(existsSync(join(f.stateDir, "desktop-exit.json"))).toBe(false);
  await f.supervisor.stop({ revision: null, runtime: f.runtime(f.selection, job.pid!).process });
  expect(JSON.parse(readFileSync(join(f.stateDir, "desktop-exit.json"), "utf8"))).toEqual({
    pid: job.pid,
    reason: "owner-eof",
  });
  expect((await f.supervisor.inspect(f.selection)).loaded).toBe(false);
});
it("refuses a stale runtime without interrupting the owned child", async () => {
  const f = fixture();
  const job = await f.supervisor.start(f.selection);
  await expect(
    f.supervisor.stop({ revision: null, runtime: f.runtime(f.selection, job.pid! + 1).process }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await f.supervisor.inspect(f.selection)).pid).toBe(job.pid);
});
it("does not report a child that exits early as ready", async () => {
  const f = fixture("early");
  await expect(f.supervisor.start(f.selection)).rejects.toThrow();
  expect((await f.supervisor.inspect(f.selection)).loaded).toBe(false);
});
it.each(["inspect", "start"])("recovers an unexpectedly exited child through %s", async (entry) => {
  const f = fixture();
  const job = await f.supervisor.start(f.selection);
  process.kill(job.pid!, "SIGKILL");
  await vi.waitFor(() => expect(processAlive(job.pid!)).toBe(false));
  // This minimal child uses net.Server, not the real ControlEndpoint's stale-socket reclaim.
  rmSync(join(f.stateDir, "agent.sock"), { force: true });
  const next = { ...f.selection, serviceInstance: randomUUID() };
  next.environment = { ...next.environment, SHELLBELL_SERVICE_INSTANCE: next.serviceInstance };
  if (entry === "inspect") expect((await f.supervisor.inspect(next)).loaded).toBe(false);
  const restarted = await f.supervisor.start(next);
  expect(restarted.loaded).toBe(true);
  expect(restarted.pid).not.toBe(job.pid);
  await f.supervisor.stop({ revision: null, runtime: f.runtime(next, restarted.pid!).process });
});
it.each(["inspect", "status"])(
  "keeps a foreign endpoint observable after child exit through %s",
  async (entry) => {
    const f = fixture();
    const job = await f.supervisor.start(f.selection);
    process.kill(job.pid!, "SIGKILL");
    await vi.waitFor(() => expect(processAlive(job.pid!)).toBe(false));
    const next = { ...f.selection, serviceInstance: randomUUID() };
    rmSync(join(f.stateDir, "agent.sock"), { force: true });
    const foreign = createServer((socket) => {
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ ok: true, data: f.runtime(next, process.pid) })}\n`);
      });
    });
    foreign.listen(join(f.stateDir, "agent.sock"));
    await once(foreign, "listening");
    chmodSync(join(f.stateDir, "agent.sock"), 0o600);
    const coordinator = new NativeCoordinator({
      store: f.store,
      platform: f.platform,
      desktop: f.supervisor,
      bundlePath: f.bundle,
      uid: process.getuid!(),
      homeDir: f.dir,
      agentVersion: "1.0.0",
      defaultStateDir: f.stateDir,
    });
    try {
      if (entry === "inspect") {
        expect(await f.supervisor.inspect(next)).toMatchObject({ loaded: false, pid: null });
      } else {
        await f.store.mutate(null, async (tx) => {
          tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
        });
        expect(await coordinator.status()).toMatchObject({
          desktop: { loaded: false, pid: null },
          local: { kind: "foreign" },
        });
        await expect(
          coordinator.execute({ v: 1, id: 1, cmd: "settings.get" }),
        ).resolves.toBeDefined();
      }
      await expect(f.supervisor.start(next)).rejects.toMatchObject({ code: "conflict" });
      expect(foreign.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        foreign.close((error) => (error ? reject(error) : resolve())),
      );
      await coordinator.close();
    }
  },
);
it("closes the owner channel while startup is still waiting for readiness", async () => {
  const f = fixture("unready");
  const starting = f.supervisor.start(f.selection);
  const rejected = expect(starting).rejects.toMatchObject({ code: "unavailable" });
  await vi.waitFor(async () => expect((await f.supervisor.inspect(f.selection)).loaded).toBe(true));
  await f.supervisor.close();
  await rejected;
  expect(JSON.parse(readFileSync(join(f.stateDir, "desktop-exit.json"), "utf8")).reason).toBe(
    "owner-eof",
  );
});
it("escalates a hung verified child using its owned handle and verifies its exit", async () => {
  const f = fixture("hung");
  const job = await f.supervisor.start(f.selection);
  await f.supervisor.stop({ revision: null, runtime: f.runtime(f.selection, job.pid!).process });
  expect(JSON.parse(readFileSync(join(f.stateDir, "desktop-exit.json"), "utf8")).reason).toBe(
    "sigterm",
  );
});
it("never launches a legacy selection through the desktop supervisor", async () => {
  const f = fixture();
  await expect(f.supervisor.start({ ...f.selection, mode: "manual" })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(existsSync(join(f.stateDir, "desktop-exit.json"))).toBe(false);
});
it("fails closed after actual controller death without killing a terminal process", async () => {
  const f = fixture();
  writeFileSync(
    join(f.stateDir, "desktop-fixture.json"),
    JSON.stringify({ fp: f.identity.fp, slowExit: true }),
    { mode: 0o600 },
  );
  writeFileSync(join(f.stateDir, "desktop-selection.json"), JSON.stringify(f.selection), {
    mode: 0o600,
  });
  const bridge = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("./fakes/desktop-bridge.ts", import.meta.url)),
      f.stateDir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: bridge.stdout });
  bridge.stderr.resume();
  try {
    const [line] = await once(lines, "line");
    const job = JSON.parse(line);
    expect(job.loaded).toBe(true);
    const exited = once(bridge, "exit");
    bridge.kill("SIGKILL");
    await exited;
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(join(f.stateDir, "desktop-exit.json"), "utf8"))).toEqual({
        pid: job.pid,
        reason: "owner-eof",
      });
      expect(processAlive(job.pid)).toBe(false);
    });
  } finally {
    lines.close();
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
  }
});
it("does not signal an owned hung child when the endpoint identity has changed", async () => {
  const f = fixture("hung");
  const job = await f.supervisor.start(f.selection);
  const settings = join(f.stateDir, "desktop-fixture.json");
  writeFileSync(settings, JSON.stringify({ fp: f.identity.fp, behavior: "hung", foreign: true }), {
    mode: 0o600,
  });
  try {
    await expect(
      f.supervisor.stop({ revision: null, runtime: f.runtime(f.selection, job.pid!).process }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(join(f.stateDir, "desktop-exit.json"))).toBe(false);
  } finally {
    writeFileSync(settings, JSON.stringify({ fp: f.identity.fp, behavior: "hung" }), {
      mode: 0o600,
    });
  }
});
