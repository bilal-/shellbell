import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeCoordinator } from "../src/native/coordinator.js";
import { runOwnershipTransition } from "../src/native/ownership-transition.js";
import type {
  NativeExpected,
  NativeRequest,
  NativeSelection,
  NativeStatus,
} from "../src/native/protocol.js";
import { ServiceOwnerStore } from "../src/service-ownership.js";
import { nativeFixture } from "./native-fixture.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
it("does not publish a native headless transition before durable owner intent exists", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  const before = f.store.inspect();
  const runtime = structuredClone(f.local);
  const mutate = ServiceOwnerStore.prototype.mutate;
  vi.spyOn(ServiceOwnerStore.prototype, "mutate").mockImplementation(function (
    this: ServiceOwnerStore,
    revision,
    action,
  ) {
    return mutate.call(this, revision, (tx) =>
      action({
        get current() {
          return tx.current;
        },
        publish(next) {
          if (next.transition?.target === "headless" && next.transition.phase === "prepared")
            throw new Error("owner publication interrupted");
          return tx.publish(next);
        },
      }),
    );
  });
  await expect(
    f.request("ownership.convert", { target: "headless", consent: true }),
  ).rejects.toThrow();
  expect(f.owner.inspect()?.transition).toBeNull();
  expect(f.store.inspect()).toEqual(before);
  expect(f.local).toEqual(runtime);
});
function fixture(customDefault = false) {
  const f = nativeFixture();
  fixtures.push(f);
  const owner = new ServiceOwnerStore({ stateDir: f.stateDir, uid: process.getuid!() });
  let running: NativeSelection | null = null;
  const desktop = {
    async inspect(s: NativeSelection) {
      return {
        registration: "not-registered" as const,
        loaded: !!running,
        pid: running ? 567 : null,
        bundlePath: s.bundlePath,
      };
    },
    async start(s: NativeSelection) {
      f.calls.push("desktop:start");
      running = s;
      f.local = f.runtime(s, 567);
      return this.inspect(s);
    },
    async stop(_expect: NativeExpected) {
      f.calls.push("desktop:stop");
      running = null;
      f.local = null;
    },
    async close() {
      if (running) {
        f.calls.push("desktop:close");
        running = null;
        f.local = null;
      }
    },
  };
  const createCoordinator = () =>
    new NativeCoordinator({
      store: f.store,
      platform: f.platform,
      bundlePath: f.bundle,
      uid: process.getuid!(),
      homeDir: f.dir,
      defaultStateDir: customDefault ? join(f.dir, "different-default") : f.stateDir,
      agentVersion: "1.0.0",
      readiness: f.readiness,
      inspectBundle: f.inspectBundle,
      desktop,
    });
  let coordinator = createCoordinator();
  async function request(cmd: string, extra: Record<string, unknown> = {}) {
    const status = await coordinator.status();
    return coordinator.execute({
      v: 1,
      id: 1,
      cmd,
      args: {
        expect: { revision: status.revision, runtime: status.local.status?.process ?? null },
        ownerRevision: status.ownership?.revision ?? null,
        ...extra,
      },
    } as Exclude<NativeRequest, { cmd: "hello" }>) as Promise<NativeStatus>;
  }
  return Object.assign(f, {
    owner,
    coordinator,
    request,
    reopen: () => {
      coordinator = createCoordinator();
    },
  });
}
it("recovers a custom state directory after clearing selection but before headless definition write", async () => {
  const f = fixture(true);
  await f.store.mutate(null, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  f.fail = "legacy:write";
  await expect(
    f.request("ownership.convert", { target: "headless", consent: true }),
  ).rejects.toThrow();
  const intent = f.owner.inspect()!.transition!;
  expect(f.store.inspect()?.selection).toBeNull();
  expect(f.legacy.installed).toBe(false);
  f.fail = undefined;
  const recovered = await f.request("ownership.recover", { intentId: intent.id });
  expect(recovered.ownership?.transition).toBeNull();
  expect(recovered.local.status?.process.stateDir).toBe(f.stateDir);
  expect(existsSync(join(f.dir, "different-default"))).toBe(false);
});

it.each(["legacy-native", "headless"])(
  "preserves admitted backend environment when converting %s to desktop",
  async (source) => {
    const f = fixture();
    const custom = {
      PATH: "/custom/bin:/usr/bin:/bin",
      HERDR_SOCKET_PATH: join(f.dir, "herdr.sock"),
      XDG_CONFIG_HOME: join(f.dir, "config"),
    };
    Object.assign(f.selection.environment, custom);
    await f.store.mutate(null, async (tx) => {
      tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
    });
    if (source === "headless")
      await f.request("ownership.convert", { target: "headless", consent: true });
    const result = await f.request("ownership.convert", { target: "desktop", consent: true });
    expect(result.selection?.environment).toMatchObject(custom);
    expect(result.selection?.environment.SHELLBELL_SERVICE_INSTANCE).toBe(
      result.selection?.serviceInstance,
    );
    expect(result.selection?.environment.SHELLBELL_DIR).toBe(f.stateDir);
  },
);

it("reads legacy and absent ownership without writing adoption records", async () => {
  const f = fixture();
  expect((await f.coordinator.status()).ownership?.mode).toBeNull();
  expect(existsSync(f.p.serviceOwner)).toBe(false);
  await f.store.mutate(null, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  expect((await f.coordinator.status()).ownership?.mode).toBe("legacy-native");
  expect(existsSync(f.p.serviceOwner)).toBe(false);
  expect(f.calls).toEqual([]);
});
it("requires explicit setup consent and leaves identity untouched", async () => {
  const f = fixture(),
    before = readFileSync(f.p.identity);
  await expect(f.request("desktop.setup", { consent: false })).rejects.toMatchObject({
    code: "bad-request",
  });
  await expect(f.request("desktop.start")).rejects.toMatchObject({ code: "conflict" });
  expect(f.calls).toEqual([]);
  expect(f.owner.inspect()).toBeNull();
  const status = await f.request("desktop.setup", { consent: true });
  expect(status.ownership).toMatchObject({
    mode: "desktop",
    consented: true,
    startupEnabled: false,
    transition: null,
  });
  expect(status.local.kind).toBe("verified");
  expect(readFileSync(f.p.identity)).toEqual(before);
});
it("keeps duplicate desktop launch idempotent and preserves preference through stop", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  await f.request("desktop.start");
  expect(f.calls.filter((x) => x === "desktop:start")).toHaveLength(1);
  await f.owner.mutate(f.owner.inspect()!.revision, async (tx) => {
    tx.publish({ ...tx.current!, startupEnabled: true });
  });
  await f.request("desktop.stop");
  expect(f.owner.inspect()?.startupEnabled).toBe(true);
  expect(f.local).toBeNull();
  await f.request("desktop.start");
  expect(f.calls.filter((x) => x === "desktop:start")).toHaveLength(2);
});
it("changes login preference without starting or stopping the current desktop session", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  const before = await f.coordinator.status();
  await f.request("desktop.login.set", { enabled: true });
  expect(f.owner.inspect()?.startupEnabled).toBe(true);
  expect((await f.coordinator.status()).local).toEqual(before.local);
  expect((await f.coordinator.status()).desktopLogin).toBe("enabled");
  await f.request("desktop.login.set", { enabled: false });
  expect(f.owner.inspect()?.startupEnabled).toBe(false);
  expect((await f.coordinator.status()).local).toEqual(before.local);
  expect(f.calls).toEqual(["desktop:start", "login:register", "login:unregister"]);
});
it("preserves desired login preference on rejected registration and exposes approval separately", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  f.fail = "login:register";
  await expect(f.request("desktop.login.set", { enabled: true })).rejects.toThrow();
  expect(f.owner.inspect()?.startupEnabled).toBe(false);
  f.fail = undefined;
  f.login = "requires-approval";
  const status = await f.request("desktop.login.set", { enabled: true });
  expect(status.ownership?.startupEnabled).toBe(true);
  expect(status.desktopLogin).toBe("requires-approval");
  await f.request("desktop.stop");
  await f.coordinator.close();
  expect(f.owner.inspect()?.startupEnabled).toBe(true);
  expect(f.calls).not.toContain("login:unregister");
});
it("refuses stale owner revision before any desktop mutation", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  const calls = [...f.calls];
  await expect(f.request("desktop.stop", { ownerRevision: null })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(f.calls).toEqual(calls);
});
it("never replaces missing paired identity during an ordinary desktop restart", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  await f.request("desktop.stop");
  unlinkSync(f.p.identity);
  await expect(f.request("desktop.start")).rejects.toMatchObject({ code: "unsafe-state" });
  expect(existsSync(f.p.identity)).toBe(false);
});
it("inspects headless ownership without takeover and closes only its UI", async () => {
  const f = fixture();
  await f.owner.mutate(null, async (tx) => {
    tx.publish({ v: 1, mode: "headless", consented: true, startupEnabled: true, transition: null });
  });
  expect((await f.coordinator.status()).ownership?.mode).toBe("headless");
  await expect(f.request("desktop.setup", { consent: true })).rejects.toMatchObject({
    code: "conflict",
  });
  await expect(f.request("desktop.start")).rejects.toMatchObject({ code: "conflict" });
  await f.coordinator.close();
  expect(f.calls).toEqual([]);
});
it("converts desktop to independent headless and back without replacing identity", async () => {
  const f = fixture();
  const identity = readFileSync(f.p.identity);
  await f.request("desktop.setup", { consent: true });
  await f.request("desktop.login.set", { enabled: true });
  const headless = await f.request("ownership.convert", { target: "headless", consent: true });
  expect(headless.ownership).toMatchObject({
    mode: "headless",
    transition: null,
    startupEnabled: true,
  });
  expect(headless.selection).toBeNull();
  expect(headless.local.kind).toBe("verified");
  expect(f.legacy).toMatchObject({ installed: true, loaded: true, startupEnabled: true });
  expect(statSync(f.p.log).mode & 0o777).toBe(0o600);
  expect(f.login).toBe("not-registered");
  const runtime = structuredClone(f.local);
  await f.coordinator.close();
  expect(f.local).toEqual(runtime);
  f.reopen();
  await expect(f.request("desktop.stop")).rejects.toMatchObject({ code: "conflict" });
  const desktop = await f.request("ownership.convert", { target: "desktop", consent: true });
  expect(desktop.ownership).toMatchObject({ mode: "desktop", transition: null });
  expect(desktop.local.kind).toBe("verified");
  expect(f.login).toBe("enabled");
  expect(f.legacy).toMatchObject({ installed: false, loaded: false });
  await f.request("ownership.convert", { target: "headless", consent: true });
  const again = await f.request("ownership.convert", { target: "desktop", consent: true });
  expect(again.ownership?.transition).toBeNull();
  expect(again.local.kind).toBe("verified");
  expect(readFileSync(f.p.identity)).toEqual(identity);
});
it.each(["login:unregister", "legacy:write", "legacy:disable", "legacy:load"])(
  "recovers a headless conversion interrupted at %s without losing identity",
  async (failure) => {
    const f = fixture();
    const identity = readFileSync(f.p.identity);
    await f.request("desktop.setup", { consent: true });
    if (failure === "login:unregister") await f.request("desktop.login.set", { enabled: true });
    f.fail = failure;
    await expect(
      f.request("ownership.convert", { target: "headless", consent: true }),
    ).rejects.toThrow();
    const intent = f.owner.inspect()!.transition!;
    expect(intent).toMatchObject({ target: "headless", phase: "recovery-required" });
    expect(readFileSync(f.p.identity)).toEqual(identity);
    f.fail = undefined;
    const status = await f.request("ownership.recover", { intentId: intent.id });
    expect(status.ownership).toMatchObject({ mode: "headless", transition: null });
    expect(status.local.kind).toBe("verified");
    expect(f.legacy.definition?.serviceInstance).toBe(intent.id);
    expect(readFileSync(f.p.identity)).toEqual(identity);
  },
);
it.each(["write", "setStartupEnabled", "load"] as const)(
  "observes a headless conversion whose %s took effect before failure",
  async (method) => {
    const f = fixture();
    await f.request("desktop.setup", { consent: true });
    const guard = f.platform.withLegacyGuard;
    let fail = true;
    f.platform.withLegacyGuard = (action) =>
      guard((manager) =>
        action({
          ...manager,
          [method]: async (...args: unknown[]) => {
            const result = await (manager[method] as (...args: unknown[]) => Promise<unknown>)(
              ...args,
            );
            if (fail) {
              fail = false;
              throw new Error("interrupted after effect");
            }
            return result;
          },
        }),
      );
    await expect(
      f.request("ownership.convert", { target: "headless", consent: true }),
    ).rejects.toThrow();
    const intent = f.owner.inspect()!.transition!;
    const pid = f.local?.process.pid;
    const result = await f.request("ownership.recover", { intentId: intent.id });
    expect(result.local.kind).toBe("verified");
    expect(result.ownership?.transition).toBeNull();
    if (method === "load") {
      expect(result.local.status?.process.pid).toBe(pid);
      expect(f.calls.filter((call) => call === "legacy:load")).toHaveLength(1);
    }
  },
);
it.each([false, true])(
  "reconciles headless completion and refuses a duplicate old manager (%s)",
  async (duplicate) => {
    const f = fixture();
    await f.store.mutate(null, async (tx) => {
      tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
    });
    await f.request("ownership.convert", { target: "headless", consent: true });
    const id = f.legacy.definition!.serviceInstance!;
    await f.owner.mutate(f.owner.inspect()!.revision, async (tx) => {
      tx.publish({
        ...tx.current!,
        transition: {
          id,
          source: "legacy-native",
          target: "headless",
          sourceManager: "native-manual",
          sourceInstance: f.selection.serviceInstance,
          stateDir: f.stateDir,
          computerFp: f.identity.fp,
          targetBundlePath: f.bundle,
          targetVersion: "1.0.0",
          phase: "recovery-required",
        },
      });
    });
    const calls = [...f.calls];
    if (duplicate) {
      await f.store.mutate(f.store.inspect()!.revision, async (tx) => {
        tx.publish({
          ...tx.current!,
          selection: null,
          transition: {
            id,
            action: "recover",
            phase: "destination-ready",
            source: f.selection,
            destination: null,
            recoveryId: null,
          },
        });
      });
      f.jobs.manual = { registration: "enabled", loaded: true, pid: 987, bundlePath: f.bundle };
      await expect(f.request("ownership.recover", { intentId: id })).rejects.toMatchObject({
        code: "conflict",
      });
      expect(f.owner.inspect()?.transition?.id).toBe(id);
      expect(f.calls).toEqual(calls);
      return;
    }
    const result = await f.request("ownership.recover", { intentId: id });
    expect(result.local.kind).toBe("verified");
    expect(result.ownership?.transition).toBeNull();
    expect(f.calls).toEqual(calls);
  },
);
it("records desktop conversion before disarming failed persistent startup and recovers only that destination", async () => {
  const f = fixture();
  f.selection.mode = "persistent";
  await f.store.mutate(null, async (tx) => {
    tx.publish({
      v: 1,
      selection: f.selection,
      transition: {
        id: "00000000-0000-4000-8000-000000000001",
        action: "start",
        phase: "recovery-required",
        source: null,
        destination: f.selection,
        recoveryId: null,
      },
      recovery: null,
    });
  });
  f.fail = "recover:manual";
  await expect(
    f.request("ownership.convert", { target: "desktop", consent: true }),
  ).rejects.toThrow();
  const intent = f.owner.inspect()?.transition;
  expect(intent).toMatchObject({
    target: "desktop",
    source: "legacy-native",
    phase: "recovery-required",
  });
  expect(f.store.inspect()?.transition?.destination?.mode).toBe("desktop");
  f.fail = undefined;
  const status = await f.request("ownership.recover", { intentId: intent!.id });
  expect(status.ownership?.transition).toBeNull();
  expect(status.selection?.mode).toBe("desktop");
  expect(f.calls).not.toContain("start:persistent");
  expect(f.calls).not.toContain("start:manual");
  expect(f.calls).not.toContain("remove:persistent");
});
it("never clears conversion intent merely by inspecting status", async () => {
  const f = fixture();
  await f.store.mutate(null, async (tx) => {
    tx.publish({ v: 1, selection: f.selection, transition: null, recovery: null });
  });
  f.fail = "remove:manual";
  await expect(
    f.request("ownership.convert", { target: "desktop", consent: true }),
  ).rejects.toThrow();
  const before = f.owner.inspect(),
    calls = [...f.calls];
  await f.coordinator.status();
  expect(f.owner.inspect()).toEqual(before);
  expect(f.calls).toEqual(calls);
});
it("allows Quit to stop an owned desktop destination while preserving pending recovery intent", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  const intent = {
    id: "00000000-0000-4000-8000-000000000002",
    source: null,
    target: "desktop" as const,
    sourceManager: null,
    sourceInstance: null,
    stateDir: f.stateDir,
    computerFp: f.identity.fp,
    targetBundlePath: f.bundle,
    targetVersion: "1.0.0",
    phase: "recovery-required" as const,
  };
  await f.owner.mutate(f.owner.inspect()!.revision, async (tx) => {
    tx.publish({ ...tx.current!, transition: intent });
  });
  await f.request("desktop.stop");
  expect(f.local).toBeNull();
  expect(f.owner.inspect()?.transition).toEqual(intent);
});
it("reconciles a completed native destination when the final owner publication was interrupted", async () => {
  const f = fixture();
  await f.request("desktop.setup", { consent: true });
  const selection = f.store.inspect()!.selection!;
  const intent = {
    id: "00000000-0000-4000-8000-000000000002",
    source: "legacy-native" as const,
    target: "desktop" as const,
    sourceManager: "native-manual" as const,
    sourceInstance: "00000000-0000-4000-8000-000000000003",
    stateDir: f.stateDir,
    computerFp: f.identity.fp,
    targetBundlePath: f.bundle,
    targetVersion: "1.0.0",
    phase: "recovery-required" as const,
  };
  await f.owner.mutate(f.owner.inspect()!.revision, async (tx) => {
    tx.publish({ ...tx.current!, transition: intent });
  });
  await f.request("ownership.recover", { intentId: intent.id });
  expect(f.store.inspect()!.selection!.serviceInstance).toBe(selection.serviceInstance);
  expect(f.calls).toEqual(["desktop:start"]);
  expect(f.owner.inspect()!.transition).toBeNull();
});
it.each(["preflight", "stopSource", "verifyAbsent", "startDestination", "complete"] as const)(
  "keeps durable recovery intent across failure at %s",
  async (failure) => {
    const f = fixture();
    const intent = {
      id: "00000000-0000-4000-8000-000000000002",
      source: "legacy-native" as const,
      target: "desktop" as const,
      sourceManager: "native-manual" as const,
      sourceInstance: f.selection.serviceInstance,
      stateDir: f.stateDir,
      computerFp: f.identity.fp,
      targetBundlePath: f.bundle,
      targetVersion: "1.0.0",
      phase: "prepared" as const,
    };
    const seen: string[] = [];
    const step = async (name: string) => {
      if (name !== "preflight") expect(f.owner.inspect()?.transition?.id).toBe(intent.id);
      seen.push(name);
      if (name === failure) throw new Error("injected boundary");
    };
    await expect(
      f.owner.mutate(null, async (tx) =>
        runOwnershipTransition(tx, intent, {
          preflight: () => step("preflight"),
          stopSource: () => step("stopSource"),
          verifyAbsent: () => step("verifyAbsent"),
          startDestination: () => step("startDestination"),
          complete: () => step("complete"),
        }),
      ),
    ).rejects.toThrow();
    expect(seen.at(-1)).toBe(failure);
    if (failure === "preflight") expect(f.owner.inspect()).toBeNull();
    else expect(f.owner.inspect()?.transition).toEqual({ ...intent, phase: "recovery-required" });
  },
);
