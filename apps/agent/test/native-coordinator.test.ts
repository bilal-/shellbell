import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  derivePskKey,
  encodeCbor,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  pairingAd,
  parseQr,
  seal,
} from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { chooseConfirm } from "../src/cli.js";
import { loadConfig, loadPairings, paths } from "../src/config.js";
import { ControlServer } from "../src/control.js";
import { ControlV2ClientError } from "../src/control-v2-client.js";
import { createLogger } from "../src/log.js";
import { NativeCoordinator, type NativeCoordinatorOptions } from "../src/native/coordinator.js";
import type { NativeRequest, NativeStatus } from "../src/native/protocol.js";
import { ServiceReadiness } from "../src/service-readiness.js";
import { nativeFixture } from "./native-fixture.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(overrides: Partial<NativeCoordinatorOptions> = {}) {
  const f = nativeFixture();
  fixtures.push(f);
  const coordinator = new NativeCoordinator({
    store: f.store,
    platform: f.platform,
    bundlePath: f.bundle,
    uid: process.getuid!(),
    homeDir: f.dir,
    agentVersion: "1.0.0",
    defaultStateDir: f.stateDir,
    readiness: f.readiness,
    inspectBundle: f.inspectBundle,
    ...overrides,
  });
  return { ...f, live: f, coordinator };
}
async function request(
  f: ReturnType<typeof fixture>,
  cmd: string,
  extra: Record<string, unknown> = {},
) {
  const status = await f.coordinator.status();
  return f.coordinator.execute({
    v: 1,
    id: 1,
    cmd,
    args: {
      expect: { revision: status.revision, runtime: status.local.status?.process ?? null },
      ...extra,
    },
  } as NativeRequest as Exclude<NativeRequest, { cmd: "hello" }>);
}
const start = { mode: "manual", consent: true, migrateLegacy: false };
it("rejects unavailable automatic startup before touching the working manual service", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  const before = f.store.inspect();
  const local = structuredClone(f.live.local);
  const calls = [...f.calls];
  Object.assign(f.platform, {
    preflight: async () => {
      throw new Error("startup-unavailable");
    },
  });
  await expect(request(f, "service.start", { ...start, mode: "persistent" })).rejects.toThrow();
  expect(f.store.inspect()).toEqual(before);
  expect(f.live.local).toEqual(local);
  expect(f.calls).toEqual(calls);
});

it("explicit manual recovery replaces a failed persistent destination without changing identity", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  f.live.fail = "start:persistent";
  await expect(request(f, "service.start", { ...start, mode: "persistent" })).rejects.toThrow();
  f.live.fail = undefined;
  const identity = readFileSync(f.p.identity);
  expect((await f.coordinator.status()).manualRecoveryAvailable).toBe(true);
  const result = await request(f, "service.recover", {
    action: "use-manual",
    restartPrevious: false,
    consent: true,
  });
  expect(result).toMatchObject({
    selection: { mode: "manual" },
    transition: null,
    local: { kind: "verified" },
  });
  expect(readFileSync(f.p.identity)).toEqual(identity);
});
it("does not advertise manual recovery for a failed persistent-source stop", async () => {
  const f = fixture();
  await request(f, "service.start", { ...start, mode: "persistent" });
  f.live.fail = "stop:persistent";
  await expect(request(f, "service.start", start)).rejects.toThrow();
  f.live.local = null;
  f.jobs.persistent.loaded = false;
  f.jobs.persistent.pid = null;
  expect((await f.coordinator.status()).manualRecoveryAvailable).toBe(false);
});
it.each(["manual-loaded", "persistent-loaded", "endpoint-present", "legacy-installed"])(
  "manual recovery preserves failed intent without starting anything when %s",
  async (condition) => {
    const f = fixture();
    await request(f, "service.start", start);
    f.live.fail = "start:persistent";
    await expect(request(f, "service.start", { ...start, mode: "persistent" })).rejects.toThrow();
    f.live.fail = condition === "disable-fails" ? "recover:manual" : undefined;
    const before = f.store.inspect();
    if (condition === "manual-loaded")
      f.jobs.manual = { registration: "enabled", loaded: true, pid: 456, bundlePath: f.bundle };
    if (condition === "persistent-loaded")
      f.jobs.persistent = { registration: "enabled", loaded: true, pid: 456, bundlePath: f.bundle };
    if (condition === "endpoint-present") f.live.local = f.live.runtime(f.selection);
    if (condition === "legacy-installed") f.live.legacy.installed = true;
    const starts = f.calls.filter((call) => call.startsWith("start:"));
    await expect(
      request(f, "service.recover", {
        action: "use-manual",
        restartPrevious: false,
        consent: true,
      }),
    ).rejects.toThrow();
    expect(f.store.inspect()).toEqual(before);
    expect(f.calls.filter((call) => call.startsWith("start:"))).toEqual(starts);
  },
);
it("records manual recovery intent before disabling and resumes that intent after failure", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  f.live.fail = "start:persistent";
  await expect(request(f, "service.start", { ...start, mode: "persistent" })).rejects.toThrow();
  f.live.fail = "recover:manual";
  await expect(
    request(f, "service.recover", { action: "use-manual", restartPrevious: false, consent: true }),
  ).rejects.toThrow();
  expect(f.store.inspect()).toMatchObject({
    transition: {
      action: "recover",
      phase: "recovery-required",
      source: { mode: "persistent" },
      destination: { mode: "manual" },
    },
  });
  const admitted = f.phases[f.calls.lastIndexOf("recover:manual")];
  expect(admitted).toMatchObject({
    transition: { action: "recover", destination: { mode: "manual" } },
  });
  f.live.fail = undefined;
  const starts = f.calls.filter((call) => call === "start:persistent").length;
  await expect(
    request(f, "service.recover", { action: "continue", restartPrevious: false, consent: true }),
  ).resolves.toMatchObject({ selection: { mode: "manual" }, transition: null });
  expect(f.calls.filter((call) => call === "start:persistent")).toHaveLength(starts);
});
it("failed manual recovery startup retains resumable manual intent", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  f.live.fail = "start:persistent";
  await expect(request(f, "service.start", { ...start, mode: "persistent" })).rejects.toThrow();
  f.live.fail = "start:manual";
  await expect(
    request(f, "service.recover", { action: "use-manual", restartPrevious: false, consent: true }),
  ).rejects.toThrow();
  expect(f.store.inspect()).toMatchObject({
    selection: { mode: "manual" },
    transition: { phase: "recovery-required", destination: { mode: "manual" } },
  });
  f.live.fail = undefined;
  await expect(
    request(f, "service.recover", { action: "continue", restartPrevious: false, consent: true }),
  ).resolves.toMatchObject({ transition: null, local: { kind: "verified" } });
});
describe("explicit destination ownership admission", () => {
  it.each(["live", "foreign", "unverified"])(
    "refuses an existing %s destination before publishing intent or mutating managers",
    async (kind) => {
      const f = fixture(),
        defaultStateDir = join(f.dir, "missing-default");
      writeFileSync(f.p.pairings, '{"v":1,"phones":[]}\n', { mode: 0o600 });
      const identity = readFileSync(f.p.identity),
        pairings = readFileSync(f.p.pairings);
      let now = 0;
      const readiness = new ServiceReadiness({
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
        probe: async (socket) => {
          if (socket === f.p.sock)
            return kind === "unverified"
              ? { oldStatus: true }
              : {
                  ...f.live.runtime(f.selection, 999),
                  process: {
                    ...f.live.runtime(f.selection, 999).process,
                    computerFp: kind === "foreign" ? "b".repeat(26) : f.identity.fp,
                  },
                };
          throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
        },
      });
      const coordinator = new NativeCoordinator({
        store: f.store,
        platform: f.platform,
        bundlePath: f.bundle,
        uid: process.getuid!(),
        homeDir: f.dir,
        agentVersion: "1.0.0",
        defaultStateDir,
        readiness,
        inspectBundle: f.inspectBundle,
      });
      await expect(
        request({ ...f, coordinator }, "service.start", { ...start, stateDir: f.stateDir }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(f.calls).toEqual([]);
      expect(f.store.inspect()).toBeNull();
      expect(readFileSync(f.p.identity)).toEqual(identity);
      expect(readFileSync(f.p.pairings)).toEqual(pairings);
      expect(existsSync(defaultStateDir)).toBe(false);
    },
  );
  it.each([false, true])(
    "only an absent requested endpoint permits first-use state initialization (absent=%s)",
    async (absent) => {
      const f = fixture(),
        defaultStateDir = join(f.dir, "missing-default"),
        requested = join(f.dir, "requested-new-state");
      let now = 0;
      const readiness = new ServiceReadiness({
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
        probe: async (socket) => {
          if (f.live.local && socket === paths(f.live.local.process.stateDir).sock)
            return f.live.local;
          if (!absent && socket === paths(requested).sock)
            return {
              ...f.live.runtime(f.selection, 999),
              process: { ...f.live.runtime(f.selection, 999).process, stateDir: requested },
            };
          throw Object.assign(new Error("fixture absent"), { code: "ENOENT" });
        },
      });
      const coordinator = new NativeCoordinator({
        store: f.store,
        platform: f.platform,
        bundlePath: f.bundle,
        uid: process.getuid!(),
        homeDir: f.dir,
        agentVersion: "1.0.0",
        defaultStateDir,
        readiness,
        inspectBundle: f.inspectBundle,
      });
      const result = request({ ...f, coordinator }, "service.start", {
        ...start,
        stateDir: requested,
      });
      if (absent) {
        await expect(result).resolves.toMatchObject({
          selection: { stateDir: requested },
          local: { kind: "verified" },
        });
        expect(existsSync(paths(requested).identity)).toBe(true);
        expect(f.calls).toEqual(["start:manual"]);
      } else {
        await expect(result).rejects.toMatchObject({ code: "conflict" });
        expect(existsSync(requested)).toBe(false);
        expect(f.calls).toEqual([]);
        expect(f.store.inspect()).toBeNull();
      }
      expect(existsSync(defaultStateDir)).toBe(false);
    },
  );
});
it("recovery refuses a competing native manager before stopping the selected source", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  f.live.fail = "stop:manual";
  await expect(request(f, "service.restart")).rejects.toMatchObject({ code: "operation-failed" });
  f.live.fail = undefined;
  f.jobs.persistent = { registration: "enabled", loaded: true, pid: 999, bundlePath: f.bundle };
  const before = f.calls.length;
  await expect(
    request(f, "service.recover", { action: "continue", restartPrevious: false, consent: true }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.calls).toHaveLength(before);
});
it("mode handoff removes the stopped source definition before launching its destination", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  await request(f, "service.start", { ...start, mode: "persistent" });
  expect(f.calls).toEqual(["start:manual", "stop:manual", "remove:manual", "start:persistent"]);
  expect(f.phases[2]).toMatchObject({ selection: null, transition: { phase: "source-stopped" } });
});
it("explicit continuation preserves the owned null-instance migration exception", async () => {
  const f = fixture();
  f.live.legacy = {
    installed: true,
    loaded: true,
    raw: Buffer.from("old owned definition"),
    definition: {
      nodePath: `${f.dir}/node`,
      cliPath: `${f.dir}/cli`,
      stateDir: f.stateDir,
      serviceInstance: null,
      environment: {},
      logPath: f.p.log,
    },
  };
  const readiness = new ServiceReadiness({
    probe: async () => {
      if (f.live.legacy.loaded) return { oldStatus: true };
      if (f.live.local) return f.live.local;
      throw Object.assign(new Error(), { code: "ENOENT" });
    },
  });
  const coordinator = new NativeCoordinator({
    store: f.store,
    platform: f.platform,
    bundlePath: f.bundle,
    uid: process.getuid!(),
    homeDir: f.dir,
    agentVersion: "1.0.0",
    defaultStateDir: f.stateDir,
    readiness,
    inspectBundle: f.inspectBundle,
  });
  const target = { ...f, coordinator };
  f.live.fail = "legacy:unload";
  await expect(
    request(target, "service.start", { ...start, migrateLegacy: true }),
  ).rejects.toMatchObject({ code: "operation-failed" });
  f.live.fail = undefined;
  await request(target, "service.recover", {
    action: "continue",
    restartPrevious: false,
    consent: true,
  });
  expect(f.store.inspect()?.transition).toBeNull();
  expect(f.live.legacy.installed).toBe(false);
});
it("can explicitly discard a retained backup after successful legacy restoration", async () => {
  const f = fixture();
  f.live.legacy = {
    installed: true,
    loaded: false,
    raw: Buffer.from("legacy definition"),
    definition: {
      nodePath: `${f.dir}/node`,
      cliPath: `${f.dir}/cli`,
      stateDir: f.stateDir,
      serviceInstance: f.selection.serviceInstance,
      environment: {},
      logPath: f.p.log,
    },
  };
  await request(f, "service.start", { ...start, migrateLegacy: true });
  await request(f, "service.recover", {
    action: "restore-legacy",
    restartPrevious: false,
    consent: true,
  });
  await request(f, "service.recover", {
    action: "discard-backup",
    restartPrevious: false,
    consent: true,
  });
  expect(f.store.inspect()?.recovery).toBeNull();
  expect(f.live.legacy.raw).toEqual(Buffer.from("legacy definition"));
});
describe("native recoverable lifecycle", () => {
  it("inspection creates no controller state and does not change identity", async () => {
    const f = fixture(),
      before = readFileSync(f.p.identity);
    expect(await f.coordinator.status()).toMatchObject({
      revision: null,
      selection: null,
      local: { kind: "absent" },
    });
    expect(existsSync(f.root)).toBe(false);
    expect(readFileSync(f.p.identity)).toEqual(before);
    expect(f.calls).toEqual([]);
  });
  it.each(["manual", "persistent"])(
    "starts %s once, preserves identity, and GUI close leaves it running",
    async (mode) => {
      const f = fixture(),
        before = readFileSync(f.p.identity);
      const status = (await request(f, "service.start", { ...start, mode })) as NativeStatus;
      expect(status.local.kind).toBe("verified");
      expect(status.selection?.mode).toBe(mode);
      expect(readFileSync(f.p.identity)).toEqual(before);
      await expect(request(f, "service.start", { ...start, mode })).rejects.toMatchObject({
        code: "conflict",
      });
      f.coordinator.close();
      expect(f.calls).toEqual([`start:${mode}`]);
      expect(f.phases[0]).toMatchObject({
        selection: { mode },
        transition: { phase: "destination-start-requested" },
      });
    },
  );
  it("stop retains selection; restart gets a fresh instance; remove clears selection", async () => {
    const f = fixture();
    await request(f, "service.start", start);
    const old = f.store.inspect()!.selection!;
    await request(f, "service.stop");
    expect(f.store.inspect()?.selection).toEqual(old);
    await request(f, "service.restart");
    expect(f.store.inspect()?.selection?.serviceInstance).not.toBe(old.serviceInstance);
    await request(f, "service.remove");
    expect(f.store.inspect()?.selection).toBeNull();
    expect(f.calls).toEqual([
      "start:manual",
      "stop:manual",
      "start:manual",
      "stop:manual",
      "remove:manual",
    ]);
  });
  it("retains the source selection before stop side effects and records interrupted work", async () => {
    const f = fixture();
    await request(f, "service.start", start);
    const source = f.store.inspect()!.selection;
    f.live.fail = "stop:manual";
    await expect(request(f, "service.stop")).rejects.toMatchObject({ code: "operation-failed" });
    expect(f.phases[1]).toMatchObject({
      selection: source,
      transition: { phase: "source-stop-requested" },
    });
    expect(f.store.inspect()).toMatchObject({
      selection: source,
      transition: { phase: "recovery-required" },
    });
    const before = f.calls.length;
    await f.coordinator.status();
    expect(f.calls).toHaveLength(before);
  });
  it("approval retains persistent intent and never falls back to manual", async () => {
    const f = fixture();
    f.live.approval = true;
    const status = (await request(f, "service.start", {
      ...start,
      mode: "persistent",
    })) as NativeStatus;
    expect(status.transition?.phase).toBe("awaiting-approval");
    expect(f.calls).toEqual(["start:persistent"]);
  });
  it("stale revisions and foreign local owners cannot mutate managers", async () => {
    const f = fixture();
    await request(f, "service.start", start);
    await expect(
      f.coordinator.execute({
        v: 1,
        id: 1,
        cmd: "service.stop",
        args: { expect: { revision: null, runtime: f.live.local!.process } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.live.local!.process.computerFp = "b".repeat(26);
    await expect(request(f, "service.stop")).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls).toEqual(["start:manual"]);
  });
  it("recovers a destination failure only after explicit continuation", async () => {
    const f = fixture();
    f.live.fail = "start:manual";
    await expect(request(f, "service.start", start)).rejects.toMatchObject({
      code: "operation-failed",
    });
    expect(f.store.inspect()?.transition?.phase).toBe("recovery-required");
    f.live.fail = undefined;
    await request(f, "service.recover", {
      action: "continue",
      restartPrevious: false,
      consent: true,
    });
    expect(f.store.inspect()?.transition).toBeNull();
    expect(f.live.local?.process.serviceInstance).toBe(
      f.store.inspect()?.selection?.serviceInstance,
    );
  });
  it("validates every setting before saving the batch", async () => {
    const f = fixture();
    const get = () =>
      f.coordinator.execute({ v: 1, id: 1, cmd: "settings.get" }) as Promise<{
        savedRevision: string;
      }>;
    const settings = await get();
    await expect(
      request(f, "settings.set", {
        configRevision: settings.savedRevision,
        changes: [
          { key: "name", value: "changed" },
          { key: "accent", value: "invalid" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-config" });
    expect(existsSync(f.p.config)).toBe(false);
  });
  it("rejects unsafe identity permissions without repairing them", async () => {
    const f = fixture();
    writeFileSync(f.p.identity, "{}", { mode: 0o600 });
    await expect(request(f, "service.start", start)).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(f.calls).toEqual([]);
  });
  function legacy(f: ReturnType<typeof fixture>) {
    f.live.legacy = {
      installed: true,
      loaded: true,
      raw: Buffer.from("exact original legacy bytes\n"),
      definition: {
        nodePath: "/fixture/node",
        cliPath: "/fixture/cli",
        stateDir: f.stateDir,
        serviceInstance: f.selection.serviceInstance,
        environment: f.selection.environment,
        logPath: f.p.log,
      },
    };
    f.live.local = f.live.runtime(f.selection, 123);
  }
  it("migration removes active legacy definition only after stop and retains exact recovery bytes", async () => {
    const f = fixture();
    legacy(f);
    writeFileSync(f.p.pairings, '{"v":1,"phones":[]}\n', { mode: 0o600 });
    const identity = readFileSync(f.p.identity),
      pairings = readFileSync(f.p.pairings);
    await request(f, "service.start", { ...start, migrateLegacy: true });
    expect(f.calls).toEqual(["legacy:unload", "legacy:remove", "start:manual"]);
    expect(f.phases[0]).toMatchObject({ transition: { phase: "source-stop-requested" } });
    expect(f.phases[1]).toMatchObject({ transition: { phase: "source-stopped" } });
    expect(Buffer.from(f.store.inspect()!.recovery!.rawBase64, "base64")).toEqual(
      Buffer.from("exact original legacy bytes\n"),
    );
    expect(readFileSync(f.p.identity)).toEqual(identity);
    expect(readFileSync(f.p.pairings)).toEqual(pairings);
    expect(f.live.legacy.installed).toBe(false);
    await request(f, "service.remove");
    expect(f.store.inspect()?.recovery).not.toBeNull();
  });
  it("older admitted recover intent without restoreLegacy stays read-only and fails closed on Continue", async () => {
    const f = fixture();
    legacy(f);
    writeFileSync(f.p.pairings, '{"v":1,"phones":[]}\n', { mode: 0o600 });
    const identity = readFileSync(f.p.identity),
      pairings = readFileSync(f.p.pairings);
    await request(f, "service.start", { ...start, migrateLegacy: true });
    const record = f.store.inspect()!;
    await f.store.mutate(record.revision, async (tx) => {
      tx.publish({
        ...record,
        transition: {
          id: record.recovery!.id,
          action: "recover",
          phase: "recovery-required",
          source: record.selection,
          destination: null,
          recoveryId: record.recovery!.id,
        },
      });
    });
    const admitted = f.store.inspect()!,
      bytes = readFileSync(join(f.root, "controller.json"));
    const calls = [...f.calls],
      legacyBytes = f.live.legacy.raw;
    const status = await f.coordinator.status();
    expect(status.revision).toBe(admitted.revision);
    expect(status.transition?.phase).toBe("recovery-required");
    expect(f.store.inspect()).toEqual(admitted);
    expect(readFileSync(join(f.root, "controller.json"))).toEqual(bytes);
    await expect(
      f.coordinator.execute({
        v: 1,
        id: 1,
        cmd: "service.recover",
        args: {
          expect: { revision: status.revision, runtime: status.local.status?.process ?? null },
          action: "continue",
          restartPrevious: false,
          consent: true,
        },
      }),
    ).rejects.toMatchObject({ code: "recovery-required" });
    expect(f.store.inspect()).toEqual(admitted);
    expect(readFileSync(join(f.root, "controller.json"))).toEqual(bytes);
    expect(f.calls).toEqual(calls);
    expect(f.live.legacy.raw).toEqual(legacyBytes);
    expect(readFileSync(f.p.identity)).toEqual(identity);
    expect(readFileSync(f.p.pairings)).toEqual(pairings);
  });
  it("restore validates retained hash before any side effect", async () => {
    const f = fixture();
    legacy(f);
    await request(f, "service.start", { ...start, migrateLegacy: true });
    const record = f.store.inspect()!;
    await f.store.mutate(record.revision, async (tx) => {
      tx.publish({ ...record, recovery: { ...record.recovery!, sha256: "0".repeat(64) } });
    });
    const before = f.calls.length;
    await expect(
      request(f, "service.recover", {
        action: "restore-legacy",
        restartPrevious: false,
        consent: true,
      }),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(f.calls).toHaveLength(before);
  });
  it("restore stops native execution and never restarts legacy without separate consent", async () => {
    const f = fixture();
    legacy(f);
    await request(f, "service.start", { ...start, migrateLegacy: true });
    await request(f, "service.recover", {
      action: "restore-legacy",
      restartPrevious: false,
      consent: true,
    });
    expect(f.calls).toEqual([
      "legacy:unload",
      "legacy:remove",
      "start:manual",
      "stop:manual",
      "legacy:restore",
    ]);
    expect(f.live.legacy.raw).toEqual(Buffer.from("exact original legacy bytes\n"));
    expect(f.live.legacy.loaded).toBe(false);
    expect(f.store.inspect()?.selection).toBeNull();
    expect(f.store.inspect()?.recovery).not.toBeNull();
  });
  it("a completed migration discards its backup only on explicit request", async () => {
    const f = fixture();
    legacy(f);
    await request(f, "service.start", { ...start, migrateLegacy: true });
    await request(f, "service.recover", {
      action: "discard-backup",
      restartPrevious: false,
      consent: true,
    });
    expect(f.store.inspect()?.recovery).toBeNull();
    expect(f.live.local?.process.computerFp).toBe(f.identity.fp);
  });
  it("PID changes around the local probe invalidate ownership", async () => {
    const f = fixture();
    await request(f, "service.start", start);
    const inspect = f.platform.inspect;
    let reads = 0;
    f.platform.inspect = async (mode, bundle) => {
      const job = await inspect(mode, bundle);
      if (mode === "manual" && ++reads === 2) return { ...job, pid: 999 };
      return job;
    };
    expect((await f.coordinator.status()).local.kind).toBe("unverified");
  });
  it("missing old bundle blocks relocation before stopping its manager", async () => {
    const f = fixture();
    await request(f, "service.start", start);
    const record = f.store.inspect()!;
    await f.store.mutate(record.revision, async (tx) => {
      tx.publish({
        ...record,
        selection: { ...record.selection!, bundlePath: `${f.dir}/missing/Shellbell.app` },
      });
    });
    const next = new NativeCoordinator({
      store: f.store,
      platform: f.platform,
      bundlePath: f.bundle,
      uid: process.getuid!(),
      homeDir: f.dir,
      agentVersion: "1.0.0",
      defaultStateDir: f.stateDir,
      readiness: f.readiness,
      inspectBundle: async (path) => {
        if (path !== f.bundle) throw new Error("missing");
        return f.inspectBundle();
      },
    });
    const status = await next.status();
    await expect(
      next.execute({
        v: 1,
        id: 1,
        cmd: "service.start",
        args: {
          ...start,
          mode: "manual",
          consent: true,
          expect: { revision: status.revision, runtime: status.local.status!.process },
        },
      }),
    ).rejects.toMatchObject({ code: "recovery-required" });
    expect(f.calls).toEqual(["start:manual"]);
    expect(f.store.inspect()?.transition?.phase).toBe("recovery-required");
  });
});

it("real local control routes encrypted native consent, refreshes devices and revokes the exact fingerprint", async () => {
  const f = fixture();
  const log = createLogger({ stdout: false }),
    routing: { server: ControlServer | null } = { server: null };
  const agent = new Agent({
    paths: f.p,
    config: loadConfig(f.p),
    identity: f.identity.identity,
    fp: f.identity.fp,
    registry: new BackendRegistry(log),
    log,
    appVersion: "1.0.0",
    serviceInstance: f.selection.serviceInstance,
    confirm: chooseConfirm(
      routing,
      false,
      async () => {
        throw new Error("unexpected terminal consent");
      },
      false,
    ),
    onPairingClosed: () => routing.server?.notifyClosed(),
  });
  const server = new ControlServer(f.p.sock, agent, log, f.p.pid);
  routing.server = server;
  await server.start();
  await f.store.mutate(null, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  f.jobs.manual = { registration: "enabled", loaded: true, pid: process.pid, bundlePath: f.bundle };
  const coordinator = new NativeCoordinator({
    store: f.store,
    platform: f.platform,
    bundlePath: f.bundle,
    uid: process.getuid!(),
    homeDir: f.dir,
    agentVersion: "1.0.0",
    defaultStateDir: f.stateDir,
    readiness: new ServiceReadiness(),
    inspectBundle: f.inspectBundle,
  });
  const events: unknown[] = [];
  coordinator.onEvent((event) => events.push(event));
  const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    const status = await coordinator.status();
    return coordinator.execute({
      v: 1,
      id: 1,
      cmd,
      args: {
        expect: { revision: status.revision, runtime: status.local.status?.process ?? null },
        ...args,
      },
    } as Exclude<NativeRequest, { cmd: "hello" }>);
  };
  try {
    const settings = await coordinator.execute({ v: 1, id: 1, cmd: "settings.get" });
    expect(settings).toMatchObject({ applied: "matches" });
    const opened = (await invoke("pairing.open")) as { qrText: string; flowId: string };
    const phone = generateIdentity(),
      qr = parseQr(opened.qrText),
      phoneFp = fingerprint(phone.ed25519.pub);
    const paired = agent.pairing.handleRequest({
      type: "pairing-request",
      phoneFp,
      box: seal(
        derivePskKey(fromBase64Url(qr.p), qr.c),
        encodeCbor({
          ed25519Pub: phone.ed25519.pub,
          x25519Pub: phone.x25519.pub,
          name: "Fixture phone",
          platform: "ios",
        }),
        pairingAd("request", qr.c, phoneFp),
      ),
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const event = events[0] as { flowId: string; challengeId: string; phoneFp: string };
    await invoke("pairing.confirm", {
      flowId: event.flowId,
      challengeId: event.challengeId,
      phoneFp: event.phoneFp,
      accept: true,
    });
    await paired;
    expect(loadPairings(f.p).map((phone) => phone.phoneFp)).toEqual([phoneFp]);
    expect(await coordinator.execute({ v: 1, id: 1, cmd: "devices" })).toMatchObject([{ phoneFp }]);
    expect(await invoke("devices.revoke", { phoneFp })).toEqual({ removed: true });
    expect(loadPairings(f.p)).toEqual([]);
  } finally {
    coordinator.close();
    await server.stop();
    agent.stop();
  }
});

it("preserves uncertain revoke delivery through the private transaction without retries", async () => {
  const f = fixture();
  await request(f, "service.start", start);
  let revokes = 0;
  const coordinator = new NativeCoordinator({
    store: f.store,
    platform: f.platform,
    bundlePath: f.bundle,
    uid: process.getuid!(),
    homeDir: f.dir,
    agentVersion: "1.0.0",
    defaultStateDir: f.stateDir,
    readiness: f.readiness,
    inspectBundle: f.inspectBundle,
    connect: async () => ({
      runtime: f.live.local!.process,
      status: async () => f.live.local!,
      configurationRevision: async () => null,
      devices: async () => [],
      revoke: async () => {
        revokes++;
        throw new ControlV2ClientError("delivery-unknown");
      },
      openPairing: async () => {
        throw new Error("unused");
      },
      closePairing: async () => {},
      confirm: async () => {},
      close() {},
    }),
  });
  const status = await coordinator.status();
  await expect(
    coordinator.execute({
      v: 1,
      id: 1,
      cmd: "devices.revoke",
      args: {
        expect: { revision: status.revision, runtime: status.local.status!.process },
        phoneFp: "b".repeat(26),
      },
    }),
  ).rejects.toMatchObject({ code: "delivery-unknown" });
  expect(revokes).toBe(1);
  coordinator.close();
});

it.each([false, true])(
  "only unparseable owned null-instance legacy status qualifies for migration (foreign=%s)",
  async (foreign) => {
    const f = fixture();
    f.live.legacy = {
      installed: true,
      loaded: true,
      raw: Buffer.from("legacy null instance"),
      definition: {
        nodePath: `${f.dir}/node`,
        cliPath: `${f.dir}/cli`,
        stateDir: f.stateDir,
        serviceInstance: null,
        environment: {},
        logPath: f.p.log,
      },
    };
    const readiness = new ServiceReadiness({
      probe: async () => {
        if (f.live.legacy.loaded)
          return foreign
            ? {
                ...f.live.runtime(f.selection),
                process: { ...f.live.runtime(f.selection).process, computerFp: "b".repeat(26) },
              }
            : { oldStatus: true };
        if (f.live.local) return f.live.local;
        throw Object.assign(new Error(), { code: "ENOENT" });
      },
    });
    const coordinator = new NativeCoordinator({
      store: f.store,
      platform: f.platform,
      bundlePath: f.bundle,
      uid: process.getuid!(),
      homeDir: f.dir,
      agentVersion: "1.0.0",
      defaultStateDir: f.stateDir,
      readiness,
      inspectBundle: f.inspectBundle,
    });
    const status = await coordinator.status();
    const pending = coordinator.execute({
      v: 1,
      id: 1,
      cmd: "service.start",
      args: {
        mode: "manual",
        consent: true,
        migrateLegacy: true,
        expect: { revision: status.revision, runtime: status.local.status?.process ?? null },
      },
    });
    if (foreign) {
      await expect(pending).rejects.toMatchObject({ code: "conflict" });
      expect(f.calls).toEqual([]);
    } else {
      await expect(pending).resolves.toMatchObject({ local: { kind: "verified" } });
      expect(f.calls).toEqual(["legacy:unload", "legacy:remove", "start:manual"]);
    }
  },
);

it("continuation refuses replaced legacy bytes before touching its manager", async () => {
  const f = fixture();
  f.live.legacy = {
    installed: true,
    loaded: true,
    raw: Buffer.from("original"),
    definition: {
      nodePath: `${f.dir}/node`,
      cliPath: `${f.dir}/cli`,
      stateDir: f.stateDir,
      serviceInstance: f.selection.serviceInstance,
      environment: {},
      logPath: f.p.log,
    },
  };
  f.live.local = f.live.runtime(f.selection);
  f.live.fail = "legacy:unload";
  await expect(
    request(f, "service.start", { ...start, migrateLegacy: true }),
  ).rejects.toMatchObject({ code: "operation-failed" });
  f.live.fail = undefined;
  f.live.legacy.raw = Buffer.from("changed bytes");
  const before = f.calls.length;
  await expect(
    request(f, "service.recover", { action: "continue", restartPrevious: false, consent: true }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.calls).toHaveLength(before);
});

it.each([false, true])(
  "crash after legacy restore preserves restart consent (%s) for explicit continuation",
  async (restartPrevious) => {
    const f = fixture();
    f.live.legacy = {
      installed: true,
      loaded: true,
      raw: Buffer.from("original legacy"),
      definition: {
        nodePath: `${f.dir}/node`,
        cliPath: `${f.dir}/cli`,
        stateDir: f.stateDir,
        serviceInstance: f.selection.serviceInstance,
        environment: {},
        logPath: f.p.log,
      },
    };
    f.live.local = f.live.runtime(f.selection);
    await request(f, "service.start", { ...start, migrateLegacy: true });
    const guard = f.platform.withLegacyGuard;
    let fail = true;
    f.platform.withLegacyGuard = (action) =>
      guard((manager) =>
        action({
          ...manager,
          async restore(raw) {
            await manager.restore(raw);
            if (raw && fail) {
              fail = false;
              throw new Error("crash after restore");
            }
          },
          async load() {
            const pid = await manager.load();
            f.live.local = f.live.runtime(f.selection, pid);
            return pid;
          },
        }),
      );
    await expect(
      request(f, "service.recover", { action: "restore-legacy", restartPrevious, consent: true }),
    ).rejects.toMatchObject({ code: "operation-failed" });
    expect(f.store.inspect()?.transition).toMatchObject({
      action: "recover",
      restoreLegacy: { restartPrevious },
    });
    await request(f, "service.recover", {
      action: "continue",
      restartPrevious: false,
      consent: true,
    });
    expect(f.store.inspect()?.transition).toBeNull();
    expect(f.calls.filter((call) => call === "legacy:load")).toHaveLength(restartPrevious ? 1 : 0);
    expect(f.live.legacy.raw).toEqual(Buffer.from("original legacy"));
  },
);
it("ambiguous legacy load is observed on continuation rather than loaded twice", async () => {
  const f = fixture();
  f.live.legacy = {
    installed: true,
    loaded: true,
    raw: Buffer.from("original legacy"),
    definition: {
      nodePath: `${f.dir}/node`,
      cliPath: `${f.dir}/cli`,
      stateDir: f.stateDir,
      serviceInstance: f.selection.serviceInstance,
      environment: {},
      logPath: f.p.log,
    },
  };
  f.live.local = f.live.runtime(f.selection);
  await request(f, "service.start", { ...start, migrateLegacy: true });
  const guard = f.platform.withLegacyGuard;
  f.platform.withLegacyGuard = (action) =>
    guard((manager) =>
      action({
        ...manager,
        async load() {
          const pid = await manager.load();
          f.live.local = f.live.runtime(f.selection, pid);
          throw new Error("lost load response");
        },
      }),
    );
  await expect(
    request(f, "service.recover", {
      action: "restore-legacy",
      restartPrevious: true,
      consent: true,
    }),
  ).rejects.toMatchObject({ code: "operation-failed" });
  await request(f, "service.recover", {
    action: "continue",
    restartPrevious: false,
    consent: true,
  });
  expect(f.store.inspect()?.transition).toBeNull();
  expect(f.calls.filter((call) => call === "legacy:load")).toHaveLength(1);
});

it.each([
  "prepared",
  "source-stop-requested",
  "source-stopped",
  "destination-start-requested",
  "destination-ready",
])("explicitly resumes a crash after durable %s without changing identity", async (phase) => {
  const f = fixture();
  await request(f, "service.start", start);
  const before = readFileSync(f.p.identity);
  const mutate = f.store.mutate.bind(f.store);
  let crash = true;
  vi.spyOn(f.store, "mutate").mockImplementation((revision, action) =>
    mutate(revision, (tx) =>
      action({
        get current() {
          return tx.current;
        },
        publish(next) {
          const record = tx.publish(next);
          if (crash && next.transition?.phase === phase) {
            crash = false;
            throw new Error("crash after durable publication");
          }
          return record;
        },
      }),
    ),
  );
  await expect(request(f, "service.restart")).rejects.toMatchObject({ code: "operation-failed" });
  const calls = f.calls.length;
  await f.coordinator.status();
  expect(f.calls).toHaveLength(calls);
  await request(f, "service.recover", {
    action: "continue",
    restartPrevious: false,
    consent: true,
  });
  expect(f.store.inspect()?.transition).toBeNull();
  expect(readFileSync(f.p.identity)).toEqual(before);
  expect(f.calls.filter((call) => call === "start:manual")).toHaveLength(2);
});
