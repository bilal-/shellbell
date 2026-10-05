import { unlinkSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { type LinuxPaths, resolveLinuxPaths } from "../src/host-paths.js";
import { SystemdServiceLifecycle } from "../src/systemd-lifecycle.js";
import { hostile, integrationFixture, tree } from "./systemd-integration-fixture.js";

afterEach(() => {
  expect(hostile).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

async function doctor(f: Awaited<ReturnType<typeof integrationFixture>>) {
  return runDoctor(
    { platform: "linux", env: f.env, defaultStateDir: f.selected.dir, requiredBackends: ["tmux"] },
    {
      selectLinuxPaths: () => f.selected,
      inspectLinuxService: () => f.lifecycle.status(),
      inspectManager: hostile,
      controlStatus: async () => {
        const local = f.getLocal();
        if (!local) throw new Error("absent");
        return local;
      },
      tmuxVersion: async () => "tmux 3.4",
      checkHerdr: hostile,
      itermSocketExists: hostile,
      relayHealth: async () => true,
    },
  );
}

it.each(["yes", "no", "unknown"] as const)(
  "reports installed/enabled/active/authenticated readiness and linger %s without mutation",
  async (linger) => {
    const f = await integrationFixture();
    await f.lifecycle.install();
    await f.lifecycle.enable();
    await f.lifecycle.start();
    f.setLinger(linger);
    const before = tree(f.root);
    f.calls.length = 0;
    const checks = await doctor(f);
    expect(checks.find((c) => c.name === "service manager")).toMatchObject({
      severity: "pass",
      detail: expect.stringMatching(/installed.*enabled.*active.*ready/i),
    });
    expect(checks.find((c) => c.name === "service manager")?.detail).toContain(`linger=${linger}`);
    expect(checks.find((c) => c.name === "tmux")?.ok).toBe(true);
    expect(tree(f.root)).toEqual(before);
    expect(f.calls.every((v) => v === "observe" || v === "linger")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(f.machine.machineId);
  },
);

it("manager unavailability remains separate from authenticated foreground/backend health", async () => {
  const f = await integrationFixture();
  await f.lifecycle.install();
  await f.lifecycle.start();
  Object.assign(f.observation, {
    available: false,
    activeState: "unknown",
    mainPid: null,
    diagnostic: "systemd user manager unavailable",
  });
  const before = tree(f.root);
  const checks = await doctor(f);
  expect(checks.find((c) => c.name === "service manager")).toMatchObject({
    severity: "warning",
    detail: expect.stringMatching(/unavailable|unresolved/i),
  });
  expect(checks.find((c) => c.name === "control")?.ok).toBe(true);
  expect(checks.find((c) => c.name === "terminal readiness")?.ok).toBe(true);
  expect(tree(f.root)).toEqual(before);
});

it("still inspects persistence when credentials are damaged without repairing them", async () => {
  const f = await integrationFixture();
  await f.lifecycle.install();
  unlinkSync(f.selected.identity);
  const before = tree(f.root);
  f.calls.length = 0;
  const checks = await doctor(f);
  expect(checks.find((c) => c.name === "host state")?.severity).toBe("error");
  expect(checks.find((c) => c.name === "service manager")?.detail).toMatch(/installed/i);
  expect(f.calls).toContain("observe");
  expect(tree(f.root)).toEqual(before);
});

it.each([false, true])(
  "uses the installed custom state for doctor with running=%s and no shell override",
  async (running) => {
    const f = await integrationFixture();
    await f.lifecycle.install();
    if (running) await f.lifecycle.start();
    const env = { ...f.env };
    delete env.SHELLBELL_DIR;
    const before = tree(f.root);
    const sockets: string[] = [];
    const checks = await runDoctor(
      { platform: "linux", env, defaultStateDir: "/unused", requiredBackends: [] },
      {
        selectLinuxPaths: (selectedEnv = env) =>
          resolveLinuxPaths({ ...f.hostOptions, env: selectedEnv }),
        inspectLinuxService: async (selectPaths?: (env: NodeJS.ProcessEnv) => LinuxPaths) =>
          new SystemdServiceLifecycle({
            ...f.options,
            env,
            ...(selectPaths ? { selectPaths } : {}),
          }).status(),
        inspectManager: hostile,
        controlStatus: async (socket) => {
          sockets.push(socket);
          const local = f.getLocal();
          if (local) return local;
          throw new Error("absent");
        },
        relayHealth: async () => true,
        tmuxVersion: async () => "tmux 3.4",
        checkHerdr: hostile,
        itermSocketExists: hostile,
      },
    );
    expect(checks.find((c) => c.name === "host state")?.severity).toBe("pass");
    expect(checks.find((c) => c.name === "identity")?.severity).toBe("pass");
    expect(sockets).toEqual([f.selected.sock]);
    expect(tree(f.root)).toEqual(before);
  },
);
