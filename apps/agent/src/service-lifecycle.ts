import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Paths, paths } from "./config.js";
import { acquireControlGuard } from "./control-guard.js";
import { canonicalDestination } from "./host-files.js";
import { loadOrCreateIdentity, readIdentity } from "./identity.js";
import { prepareLogFile } from "./launchd.js";
import type { LocalStatus } from "./local-status.js";
import { serviceEnvironment, validateServiceText } from "./service-environment.js";
import type { ServiceDefinition, ServiceManager, ServiceSnapshot } from "./service-manager.js";
import { withHeadlessOwnership } from "./service-ownership.js";
import {
  canonicalStateDir,
  type ExpectedLocalService,
  type LocalObservation,
  type ReadinessOptions,
  ServiceReadiness,
} from "./service-readiness.js";
import { resolveServiceRuntime } from "./service-runtime.js";

export interface ServiceStatus {
  startupEnabled: boolean | null;
  manager: "launchd";
  definitionPath: string;
  installed: boolean;
  loaded: boolean;
  autostartConfigured: boolean;
  managedPid: number | null;
  ownership: "verified" | "legacy" | "foreign" | "none";
  local: LocalStatus | null;
  ready: boolean;
  diagnostic?: string;
}
export interface ServiceLifecycleOptions extends ReadinessOptions {
  manager: ServiceManager;
  requestedStateDir?: string;
  defaultStateDir: string;
  env: NodeJS.ProcessEnv;
}
export class ServiceLifecycleError extends Error {
  rollback: "not-needed" | "restored" | "failed" = "not-needed";
  rollbackDiagnostic?: string;
  recoveryPath?: string;
}

export function selectServicePaths(
  snapshot: ServiceSnapshot,
  requestedStateDir: string | undefined,
  defaultStateDir: string,
): Paths {
  const installedDir = snapshot.definition?.stateDir;
  const selected = canonicalStateDir(installedDir ?? (requestedStateDir || defaultStateDir));
  if (installedDir && requestedStateDir && canonicalStateDir(requestedStateDir) !== selected) {
    throw new ServiceLifecycleError(
      "SHELLBELL_DIR conflicts with the installed service state directory; state migration is not an implicit install operation",
    );
  }
  return paths(selected);
}

function operationError(error: unknown): ServiceLifecycleError {
  if (error instanceof ServiceLifecycleError) return error;
  return new ServiceLifecycleError(
    error instanceof Error ? error.message.slice(0, 600) : "Service operation failed",
  );
}

/** Definition guard only; callers must not invoke public lifecycle mutations inside it. */
export async function withServiceDefinitionGuard<T>(
  manager: ServiceManager,
  install: boolean,
  action: (manager: ServiceManager) => Promise<T>,
): Promise<T> {
  const parent = dirname(manager.definitionPath);
  let release: (() => void) | undefined;
  try {
    if (install) mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(parent)) return await action(manager);
    release = acquireControlGuard(manager.definitionPath);
    return await action(manager);
  } finally {
    release?.();
  }
}

export class ServiceLifecycle {
  private readonly manager: ServiceManager;
  private readonly readiness: ServiceReadiness;
  constructor(private readonly options: ServiceLifecycleOptions) {
    this.manager = options.manager;
    this.readiness = new ServiceReadiness(options);
  }

  private selected(snapshot: ServiceSnapshot): Paths {
    return selectServicePaths(
      snapshot,
      this.options.requestedStateDir,
      this.options.defaultStateDir,
    );
  }

  private definitionFor(
    runtime: Pick<ServiceDefinition, "nodePath" | "cliPath">,
    p: Paths,
    serviceInstance: string,
  ): ServiceDefinition {
    const environment = serviceEnvironment({
      stateDir: p.dir,
      serviceInstance,
      nodePath: runtime.nodePath,
      env: this.options.env,
    });
    const definition: ServiceDefinition = {
      nodePath: runtime.nodePath,
      cliPath: runtime.cliPath,
      stateDir: p.dir,
      serviceInstance,
      environment,
      logPath: p.log,
    };
    // Validate all serialized text, including runtime fields that are not part
    // of the environment, before creating state, logs, guards, or changing jobs.
    for (const value of Object.values(definition)) {
      if (typeof value === "string") validateServiceText(value);
    }
    for (const [key, value] of Object.entries(environment)) {
      validateServiceText(key);
      validateServiceText(value);
    }
    return definition;
  }

  private expected(snapshot: ServiceSnapshot, p: Paths): ExpectedLocalService | undefined {
    const identity = readIdentity(p);
    return identity
      ? {
          computerFp: identity.fp,
          stateDir: p.dir,
          serviceInstance: snapshot.definition?.serviceInstance ?? null,
        }
      : undefined;
  }

  private result(
    snapshot: ServiceSnapshot,
    observed: LocalObservation,
    expected?: ExpectedLocalService,
    managedPid: number | null = null,
    identityDiagnostic?: string,
  ): ServiceStatus {
    const legacy = snapshot.installed && snapshot.definition?.serviceInstance === null;
    const ready =
      snapshot.installed &&
      snapshot.loaded &&
      !!expected &&
      observed.kind === "verified" &&
      (!legacy || managedPid !== null);
    const diagnostic =
      identityDiagnostic ??
      (!expected
        ? "Local identity is missing; no keys were created"
        : legacy && managedPid === null
          ? "Legacy service cannot be verified by read-only status; run service install to upgrade"
          : undefined);
    const assumedState =
      snapshot.definition && !snapshot.definition.environment.SHELLBELL_DIR
        ? "Legacy definition assumes the historical ~/.shellbell state directory"
        : undefined;
    return {
      manager: this.manager.kind,
      definitionPath: this.manager.definitionPath,
      installed: snapshot.installed,
      loaded: snapshot.loaded,
      startupEnabled: snapshot.startupEnabled ?? null,
      autostartConfigured: snapshot.installed,
      managedPid,
      ownership:
        observed.kind === "foreign"
          ? "foreign"
          : legacy && !ready
            ? "legacy"
            : ready
              ? "verified"
              : "none",
      local: observed.local,
      ready,
      ...(observed.diagnostic || diagnostic || assumedState
        ? { diagnostic: [observed.diagnostic, diagnostic, assumedState].filter(Boolean).join("; ") }
        : {}),
    };
  }

  async status(): Promise<ServiceStatus> {
    const snapshot = await this.manager.inspect();
    const p = this.selected(snapshot);
    const expected = this.expected(snapshot, p);
    return this.result(snapshot, await this.readiness.observe(p.sock, expected), expected);
  }

  /** The definition guard is separate from the running agent's endpoint guard. */
  private async serialized<T extends ServiceStatus>(
    install: boolean,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      const snapshot = await this.manager.inspect();
      const p = this.selected(snapshot);
      return await withHeadlessOwnership(
        { stateDir: canonicalDestination(p.dir), uid: process.getuid!(), create: install },
        () => withServiceDefinitionGuard(this.manager, install, action),
      );
    } catch (error) {
      throw operationError(error);
    }
  }

  private assertAvailable(
    snapshot: ServiceSnapshot,
    observed: LocalObservation,
    expected?: ExpectedLocalService,
  ): void {
    if (observed.kind === "absent") return;
    // An installed legacy executable may not expose v1 status. Its exact job can
    // still be unloaded, but its endpoint must disappear before any replacement.
    if (
      snapshot.loaded &&
      snapshot.definition?.serviceInstance === null &&
      observed.kind === "unverified"
    )
      return;
    if (snapshot.loaded && expected && observed.kind === "verified") return;
    throw new ServiceLifecycleError(
      "Local endpoint ownership is unverified or foreign; stop the foreground owner before retrying service changes",
    );
  }

  private async rollback(
    snapshot: ServiceSnapshot,
    p: Paths,
    expected: ExpectedLocalService | undefined,
    progress: { unloadAttempted: boolean; written: boolean; loaded: boolean },
    original: unknown,
  ): Promise<never> {
    const error = operationError(original);
    if (!progress.unloadAttempted && !progress.written && !progress.loaded) throw error;
    try {
      if (progress.loaded) await this.manager.unload();
      if (progress.unloadAttempted || progress.loaded) await this.readiness.waitStopped(p.sock);
      if (progress.written) await this.manager.restore(snapshot.raw);
      if (snapshot.loaded) {
        const pid = await this.manager.load();
        // Restoring a legacy executable is a manager-level recovery only.
        if (snapshot.definition?.serviceInstance && expected)
          await this.readiness.waitReady(p.sock, { ...expected, pid });
      }
      error.rollback = "restored";
    } catch (rollbackError) {
      error.rollback = "failed";
      error.rollbackDiagnostic = operationError(rollbackError).message;
      if (snapshot.raw) {
        const recoveryPath = `${this.manager.definitionPath}.recovery-${randomUUID()}`;
        try {
          writeFileSync(recoveryPath, snapshot.raw, { mode: 0o600, flag: "wx" });
          error.recoveryPath = recoveryPath;
        } catch {
          error.rollbackDiagnostic += "; could not save a private recovery definition";
        }
      }
    }
    throw error;
  }

  async install(): Promise<ServiceStatus> {
    try {
      // Admission and environment validation precede even creating LaunchAgents.
      const runtime = resolveServiceRuntime();
      const serviceInstance = randomUUID();
      this.definitionFor(
        runtime,
        paths(canonicalStateDir(this.options.requestedStateDir || this.options.defaultStateDir)),
        serviceInstance,
      );
      return await this.serialized(true, async () => {
        const snapshot = await this.manager.inspect();
        const p = this.selected(snapshot);
        const definition = this.definitionFor(runtime, p, serviceInstance);
        const priorExpected = this.expected(snapshot, p);
        if (snapshot.installed && !priorExpected)
          throw new ServiceLifecycleError(
            `Installed service identity is missing at ${p.identity}; restore it before upgrading`,
          );
        this.assertAvailable(
          snapshot,
          await this.readiness.observe(p.sock, priorExpected),
          priorExpected,
        );
        const identity = readIdentity(p) ?? loadOrCreateIdentity(p);
        prepareLogFile(p.log);
        const expected = { computerFp: identity.fp, stateDir: p.dir, serviceInstance };
        const progress = { unloadAttempted: false, written: false, loaded: false };
        try {
          if (snapshot.loaded) {
            // bootout can succeed before the adapter's loaded-state check fails.
            progress.unloadAttempted = true;
            await this.manager.unload();
            await this.readiness.waitStopped(p.sock);
          }
          progress.written = true;
          await this.manager.write(definition);
          progress.loaded = true;
          const pid = await this.manager.load();
          const local = await this.readiness.waitReady(p.sock, { ...expected, pid });
          const current = await this.manager.inspect();
          if (!current.loaded)
            throw new Error("Service unloaded before readiness could be confirmed");
          return this.result(current, { kind: "verified", local }, expected, pid);
        } catch (error) {
          return this.rollback(snapshot, p, priorExpected, progress, error);
        }
      });
    } catch (error) {
      throw operationError(error);
    }
  }

  start(): Promise<ServiceStatus> {
    return this.runInstalled("start");
  }
  restart(): Promise<ServiceStatus> {
    return this.runInstalled("restart");
  }
  stop(): Promise<ServiceStatus> {
    return this.runInstalled("stop");
  }
  enable(): Promise<ServiceStatus> {
    return this.setStartup(true);
  }
  disable(): Promise<ServiceStatus> {
    return this.setStartup(false);
  }
  private async setStartup(enabled: boolean): Promise<ServiceStatus> {
    return this.serialized(false, async () => {
      const before = await this.manager.inspect(),
        p = this.selected(before);
      if (!before.installed)
        throw new ServiceLifecycleError("Service is not installed; run service install first");
      await this.manager.setStartupEnabled(enabled);
      const after = await this.manager.inspect();
      if (after.startupEnabled !== enabled || after.loaded !== before.loaded)
        throw new ServiceLifecycleError(
          "Startup preference or current execution could not be verified",
        );
      const expected = this.expected(after, p);
      return this.result(after, await this.readiness.observe(p.sock, expected), expected);
    });
  }
  uninstall(): Promise<ServiceStatus> {
    return this.runInstalled("uninstall");
  }

  private runInstalled(
    command: "start" | "restart" | "stop" | "uninstall",
  ): Promise<ServiceStatus> {
    return this.serialized(false, async () => {
      const snapshot = await this.manager.inspect();
      const p = this.selected(snapshot);
      const stopping = command === "stop" || command === "uninstall";
      let expected: ExpectedLocalService | undefined;
      let identityDiagnostic: string | undefined;
      try {
        expected = this.expected(snapshot, p);
      } catch (error) {
        if (!stopping) throw error;
        // Damaged keys must not trap a crash-looping exact manager job. Without
        // identity certification, responsive endpoints still fail assertAvailable.
        identityDiagnostic = operationError(error).message;
      }
      const observed = await this.readiness.observe(p.sock, expected);
      if (!snapshot.installed) {
        if (!stopping)
          throw new ServiceLifecycleError("Service is not installed; run service install first");
        return this.result(snapshot, observed, expected, null, identityDiagnostic);
      }
      if (!stopping && !expected)
        throw new ServiceLifecycleError(
          `Local identity is missing at ${p.identity}; restore it before starting`,
        );
      // Stop addresses the validated manager job, so a silent endpoint cannot
      // prevent unloading it. Still require endpoint absence before removal.
      if (!(stopping && snapshot.loaded && observed.kind === "unverified"))
        this.assertAvailable(snapshot, observed, expected);
      const progress = { unloadAttempted: false, written: false, loaded: false };
      try {
        if (command !== "start" && snapshot.loaded) {
          progress.unloadAttempted = true;
          await this.manager.unload();
          await this.readiness.waitStopped(p.sock);
        }
        if (stopping) {
          // Do not undo an explicit stop on a later inspection/removal error.
          if (command === "uninstall") await this.manager.restore(null);
          const current = await this.manager.inspect();
          if (current.loaded) throw new Error("Service remains loaded after stop");
          return this.result(
            current,
            {
              kind: "absent",
              local: null,
              diagnostic:
                command === "stop"
                  ? "Service stopped; definition remains and it may start at next login"
                  : "Service uninstalled; identity and pairings remain",
            },
            expected,
            null,
            identityDiagnostic,
          );
        }
        progress.loaded = !snapshot.loaded || command === "restart";
        const pid = await this.manager.load();
        if (command === "restart" && observed.local?.process.pid === pid)
          throw new Error("Service restart did not produce a new manager-certified process");
        const local = await this.readiness.waitReady(p.sock, { ...expected!, pid });
        const current = await this.manager.inspect();
        if (!current.loaded)
          throw new Error("Service unloaded before readiness could be confirmed");
        return this.result(current, { kind: "verified", local }, expected, pid);
      } catch (error) {
        if (stopping) throw operationError(error);
        return this.rollback(snapshot, p, expected, progress, error);
      }
    });
  }
}
