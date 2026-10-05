import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import type { LocalStatus } from "../src/local-status.js";
import type { NativePlatform } from "../src/native/platform.js";
import type { NativeJob, NativeMode, NativeSelection } from "../src/native/protocol.js";
import { requireNativeManagerMode } from "../src/native/protocol.js";
import { NativeRecordStore } from "../src/native/record-store.js";
import type { ServiceDefinition, ServiceSnapshot } from "../src/service-manager.js";
import { ServiceReadiness } from "../src/service-readiness.js";
export function nativeFixture() {
  const definitions = new Map<string, ServiceDefinition>();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-native-"))),
    root = join(dir, "native"),
    stateDir = join(dir, "state"),
    bundle = join(dir, "Shellbell.app");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(bundle, { mode: 0o755 });
  const p = paths(stateDir),
    identity = loadOrCreateIdentity(p),
    store = new NativeRecordStore({ root, uid: process.getuid!() });
  const selection: NativeSelection = {
    mode: "manual",
    stateDir,
    computerFp: identity.fp,
    serviceInstance: randomUUID(),
    bundlePath: bundle,
    bundleId: "sh.bilal.shellbell.host",
    agentVersion: "1.0.0",
    environment: { PATH: "/usr/bin:/bin", SHELLBELL_DIR: stateDir, SHELLBELL_SERVICE_INSTANCE: "" },
  };
  selection.environment.SHELLBELL_SERVICE_INSTANCE = selection.serviceInstance;
  const absent = (): NativeJob => ({
    registration: "not-registered",
    loaded: false,
    pid: null,
    bundlePath: null,
  });
  const jobs: Record<NativeMode, NativeJob> = { manual: absent(), persistent: absent() };
  const f = {
    dir,
    root,
    stateDir,
    bundle,
    p,
    identity,
    store,
    selection,
    jobs,
    local: null as LocalStatus | null,
    calls: [] as string[],
    phases: [] as unknown[],
    legacy: { installed: false, loaded: false, raw: null, definition: null } as ServiceSnapshot,
    approval: false,
    login: "not-registered" as NativeJob["registration"],
    fail: undefined as string | undefined,
    platform: undefined as unknown as NativePlatform,
    readiness: undefined as unknown as ServiceReadiness,
    inspectBundle: async () => ({
      executable: join(bundle, "Contents/MacOS/Shellbell"),
      nodePath: join(bundle, "Contents/Helpers/node"),
      controllerPath: join(bundle, "Contents/Resources/agent/dist/native-controller.js"),
      servicePath: join(bundle, "Contents/Resources/agent/dist/native-service.js"),
      agentVersion: "1.0.0",
    }),
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
    runtime(s: NativeSelection, pid = 321): LocalStatus {
      return {
        controlVersion: 1,
        process: {
          pid,
          agentVersion: s.agentVersion,
          computerFp: s.computerFp,
          stateDir: s.stateDir,
          serviceInstance: s.serviceInstance,
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
      };
    },
  };
  const record = (call: string) => {
    f.calls.push(call);
    f.phases.push(f.store.inspect());
    if (f.fail === call) throw new Error("injected failure");
  };
  const snapshot = (): ServiceSnapshot => ({
    ...structuredClone(f.legacy),
    raw: f.legacy.raw ? Buffer.from(f.legacy.raw) : null,
  });
  f.platform = {
    async loginStatus() {
      return f.login;
    },
    async setLogin(_bundle, enabled) {
      record(enabled ? "login:register" : "login:unregister");
      f.login = enabled
        ? f.login === "requires-approval"
          ? "requires-approval"
          : "enabled"
        : "not-registered";
      return f.login;
    },
    async preflight() {},
    async prepareManualRecovery() {
      record("recover:manual");
      jobs.persistent = absent();
    },
    async inspectLegacy() {
      return snapshot();
    },
    async inspect(mode) {
      return { ...jobs[mode] };
    },
    async start(s) {
      record(`start:${requireNativeManagerMode(s.mode)}`);
      jobs[requireNativeManagerMode(s.mode)] = {
        registration: f.approval ? "requires-approval" : "enabled",
        loaded: !f.approval,
        pid: f.approval ? null : 321,
        bundlePath: s.bundlePath,
      };
      if (!f.approval) f.local = f.runtime(s);
      return { ...jobs[requireNativeManagerMode(s.mode)] };
    },
    async stop(s) {
      record(`stop:${requireNativeManagerMode(s.mode)}`);
      jobs[requireNativeManagerMode(s.mode)] = absent();
      f.local = null;
    },
    async remove(s) {
      record(`remove:${requireNativeManagerMode(s.mode)}`);
      jobs[requireNativeManagerMode(s.mode)] = absent();
    },
    async withLegacyGuard(action) {
      return action({
        kind: "launchd",
        definitionPath: join(dir, "legacy.plist"),
        async inspect() {
          return snapshot();
        },
        async write(definition) {
          record("legacy:write");
          f.legacy.definition = structuredClone(definition);
          f.legacy.raw = Buffer.from(JSON.stringify(definition));
          f.legacy.installed = true;
          f.legacy.startupEnabled ??= true;
        },
        async restore(raw) {
          record(raw ? "legacy:restore" : "legacy:remove");
          if (f.legacy.raw && f.legacy.definition)
            definitions.set(f.legacy.raw.toString("base64"), structuredClone(f.legacy.definition));
          f.legacy.raw = raw;
          f.legacy.installed = raw !== null;
          f.legacy.definition = raw
            ? (definitions.get(raw.toString("base64")) ?? f.legacy.definition)
            : null;
        },
        async load() {
          record("legacy:load");
          f.legacy.loaded = true;
          if (f.legacy.definition) {
            const d = f.legacy.definition;
            f.local = f.runtime(
              {
                ...selection,
                stateDir: d.stateDir,
                serviceInstance: d.serviceInstance!,
                environment: d.environment,
              },
              123,
            );
          }
          return 123;
        },
        async unload() {
          record("legacy:unload");
          f.legacy.loaded = false;
          f.local = null;
        },
        async setStartupEnabled(enabled) {
          record(enabled ? "legacy:enable" : "legacy:disable");
          f.legacy.startupEnabled = enabled;
        },
      });
    },
  };
  let now = 0;
  f.readiness = new ServiceReadiness({
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    probe: async () => {
      if (f.local) return f.local;
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  });
  return f;
}
