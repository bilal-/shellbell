import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { acquireControlGuard } from "./control-guard.js";
import { canonicalDestination } from "./host-files.js";
import { type LinuxMachineOptions, readLinuxMachineIdentity } from "./host-machine.js";
import { type LinuxPaths, prepareLinuxRuntime, resolveLinuxPaths } from "./host-paths.js";
import { readLinuxIdentity } from "./host-state.js";
import type { LocalStatus } from "./local-status.js";
import { withHeadlessOwnership } from "./service-ownership.js";
import {
  type ExpectedLocalService,
  type LocalObservation,
  matchesLocalService,
  type ReadinessOptions,
  ServiceReadiness,
} from "./service-readiness.js";
import { resolveServiceRuntime, type ServiceRuntime } from "./service-runtime.js";
import { type SystemdFileSnapshot, SystemdFiles } from "./systemd-files.js";
import {
  createSystemdManager,
  type SystemdManagerApi,
  type SystemdObservation,
  type SystemdVerb,
} from "./systemd-manager.js";
import {
  renderSystemdUnit,
  type SystemdUnitDefinition,
  selectSystemdLocation,
} from "./systemd-unit.js";

export interface LinuxServiceStatus {
  manager: "systemd";
  unitName: string;
  definitionPath: string;
  installed: boolean;
  enabled: boolean;
  startupEnabled: boolean | null;
  autostartConfigured: boolean;
  activeState: string;
  managedPid: number | null;
  ownership: "verified" | "foreign" | "none" | "degraded";
  ready: boolean;
  local: LocalStatus | null;
  linger: "yes" | "no" | "unknown";
  diagnostic?: string;
}
export interface SystemdLifecycleOptions extends ReadinessOptions {
  env: NodeJS.ProcessEnv;
  home?: string;
  machine?: LinuxMachineOptions;
  manager?: SystemdManagerApi;
  selectPaths?: (env: NodeJS.ProcessEnv) => LinuxPaths;
  resolveRuntime?: () => ServiceRuntime;
  runtimeFsType?: (path: string) => number | bigint;
}
type Selection = { paths?: LinuxPaths; expected?: ExpectedLocalService; degraded: boolean };
type StartedJob = { pid?: number };
const inactive = (observation: SystemdObservation) =>
  observation.activeState === "inactive" || observation.activeState === "failed";
const enabled = (observation: SystemdObservation) =>
  ["enabled", "enabled-runtime"].includes(observation.unitFileState);
function failure(message: string): never {
  throw new Error(`shellbell: ${message}`);
}

export class SystemdServiceLifecycle {
  private readonly machine;
  private readonly location;
  private readonly files: SystemdFiles;
  private readonly manager: SystemdManagerApi;
  private readonly readiness: ServiceReadiness;
  private readonly clock;

  constructor(private readonly options: SystemdLifecycleOptions) {
    this.machine = readLinuxMachineIdentity(options.machine);
    this.location = selectSystemdLocation({
      identity: this.machine,
      env: options.env,
      home: options.home ?? homedir(),
    });
    this.files = new SystemdFiles(this.location, this.machine.machineId);
    this.manager =
      options.manager ??
      createSystemdManager({ location: this.location, runtimeFsType: options.runtimeFsType });
    this.readiness = new ServiceReadiness(options);
    this.clock = options.clock ?? {
      now: () => performance.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
  }

  private select(snapshot: SystemdFileSnapshot, full: boolean, installing = false): Selection {
    const definition = snapshot.unit?.definition;
    if (
      definition &&
      this.options.env.SHELLBELL_DIR !== undefined &&
      canonicalDestination(this.options.env.SHELLBELL_DIR) !== definition.stateDir
    )
      failure(
        "SHELLBELL_DIR conflicts with installed service state; explicit migration is required",
      );
    let paths: LinuxPaths;
    try {
      const env = {
        ...this.options.env,
        ...(definition
          ? {
              SHELLBELL_DIR: definition.stateDir,
              ...(!installing ? { XDG_RUNTIME_DIR: definition.runtimeRoot } : {}),
            }
          : {}),
      };
      paths = (
        this.options.selectPaths ??
        ((selectedEnv) =>
          resolveLinuxPaths({
            ...this.options.machine,
            env: selectedEnv,
            home: this.options.home,
            runtimeFsType: this.options.runtimeFsType,
          }))
      )(env);
      if (
        paths.linuxHost.uid !== this.machine.uid ||
        paths.linuxHost.hostDigest !== this.machine.hostDigest ||
        (definition && paths.dir !== definition.stateDir)
      )
        failure("selected Linux paths do not match owned service");
    } catch {
      if (full) failure("Linux service runtime/state selection is unsafe or unavailable");
      return { degraded: true };
    }
    try {
      const identity = readLinuxIdentity(paths);
      return {
        paths,
        degraded: false,
        expected: {
          computerFp: identity.fp,
          stateDir: paths.dir,
          ...(definition ? { serviceInstance: definition.serviceInstance } : {}),
        },
      };
    } catch {
      if (full)
        failure(
          "Linux host state is not ready; restore initialized credentials before granting service access",
        );
      return { paths, degraded: true };
    }
  }

  private ownedManager(
    snapshot: SystemdFileSnapshot,
    observed: SystemdObservation,
    allowAbsent = false,
  ): boolean {
    if (!observed.available || observed.dropInPaths !== "" || observed.needDaemonReload)
      return false;
    if (
      allowAbsent &&
      !snapshot.unit &&
      ["", "disabled", "enabled", "enabled-runtime"].includes(observed.unitFileState) &&
      observed.loadState === "not-found" &&
      observed.fragmentPath === "" &&
      inactive(observed) &&
      observed.mainPid === null
    )
      return true;
    if (
      !["disabled", "enabled", "enabled-runtime", "linked", "linked-runtime"].includes(
        observed.unitFileState,
      )
    )
      return false;
    if (
      !["inactive", "failed", "active", "activating", "deactivating"].includes(observed.activeState)
    )
      return false;
    return (
      !!snapshot.unit &&
      observed.loadState === "loaded" &&
      this.files.matchesFragment(observed.fragmentPath)
    );
  }

  private assertManager(
    snapshot: SystemdFileSnapshot,
    observed: SystemdObservation,
    allowAbsent = false,
  ): void {
    this.files.assertUnchanged(snapshot);
    if (!this.ownedManager(snapshot, observed, allowAbsent))
      failure(
        "systemd manager ownership is unavailable, foreign or unresolved; inspect exact unit discovery and overrides",
      );
  }

  private async local(
    snapshot: SystemdFileSnapshot,
    selection: Selection,
    manager: SystemdObservation,
    timeout = 500,
  ): Promise<LocalObservation> {
    if (!selection.paths)
      return {
        kind: "unverified",
        local: null,
        diagnostic: "Local certification degraded; runtime is unsafe or unavailable",
      };
    const observed = await this.readiness.observe(
      selection.paths.sock,
      selection.expected
        ? { ...selection.expected, ...(manager.mainPid ? { pid: manager.mainPid } : {}) }
        : undefined,
      timeout,
    );
    // Corrupt/missing credentials prevent fingerprint certification, but a
    // responsive endpoint can still positively contradict the owned job.
    if (
      observed.local &&
      snapshot.unit &&
      (observed.local.process.pid !== manager.mainPid ||
        !matchesLocalService(observed.local, {
          computerFp: selection.expected?.computerFp ?? observed.local.process.computerFp,
          stateDir: snapshot.unit.definition.stateDir,
          serviceInstance: snapshot.unit.definition.serviceInstance,
        }))
    )
      return {
        kind: "foreign",
        local: observed.local,
        diagnostic: "Local endpoint contradicts owned manager job",
      };
    return observed;
  }

  private async result(
    snapshot: SystemdFileSnapshot,
    selection: Selection,
    diagnostic?: string,
    requireStopped = false,
  ): Promise<LinuxServiceStatus> {
    const manager = await this.manager.observe();
    const owned = this.ownedManager(snapshot, manager, true);
    const local = await this.local(snapshot, selection, manager);
    // Readiness certifies a current manager job, including after the local probe.
    const after = await this.manager.observe();
    let sameFiles = true;
    try {
      this.files.assertUnchanged(snapshot);
    } catch {
      sameFiles = false;
    }
    const current =
      sameFiles &&
      owned &&
      this.ownedManager(snapshot, after, true) &&
      manager.mainPid === after.mainPid &&
      manager.activeState === after.activeState;
    const ready =
      !!snapshot.unit &&
      current &&
      !selection.degraded &&
      manager.activeState === "active" &&
      manager.mainPid !== null &&
      manager.conditionResult &&
      after.conditionResult &&
      local.kind === "verified";
    if (
      requireStopped &&
      (!current ||
        !inactive(after) ||
        after.mainPid !== null ||
        (selection.paths && local.kind !== "absent"))
    )
      failure(
        "service stop final confirmation is unresolved; current job or endpoint is not verified stopped",
      );
    const external =
      (enabled(after) && !snapshot.link?.owned) || (snapshot.link && !snapshot.link.owned);
    return {
      manager: "systemd",
      unitName: this.location.unitName,
      definitionPath: this.location.definitionPath,
      installed: !!snapshot.unit,
      enabled: enabled(after),
      startupEnabled: after.available ? enabled(after) : null,
      autostartConfigured: !!snapshot.link?.owned,
      activeState: after.activeState,
      managedPid: after.mainPid,
      ownership:
        !current || local.kind === "foreign"
          ? "foreign"
          : selection.degraded
            ? "degraded"
            : snapshot.unit
              ? "verified"
              : "none",
      ready,
      local: local.local,
      linger: await this.manager.linger(),
      ...(diagnostic || external || selection.degraded || !current || local.diagnostic
        ? {
            diagnostic: [
              diagnostic,
              external
                ? "Remaining external enablement is outside Shellbell's owned link"
                : undefined,
              selection.degraded
                ? "Local identity/runtime certification degraded; credentials were not repaired"
                : undefined,
              !current ? "Manager ownership is unresolved" : undefined,
              local.diagnostic,
            ]
              .filter(Boolean)
              .join("; "),
          }
        : {}),
    };
  }

  async status(): Promise<LinuxServiceStatus> {
    const snapshot = this.files.inspect();
    return this.result(snapshot, this.select(snapshot, false));
  }

  private async serialized(
    full: boolean,
    installing: boolean,
    action: (
      snapshot: SystemdFileSnapshot,
      selection: Selection,
      guarded: boolean,
    ) => Promise<LinuxServiceStatus>,
  ): Promise<LinuxServiceStatus> {
    const before = this.files.inspect();
    const selection = this.select(before, full, installing);
    const actionWithManagerGuard = async () => {
      let release: (() => void) | undefined;
      try {
        if (selection.paths) {
          prepareLinuxRuntime(selection.paths);
          release = acquireControlGuard(join(selection.paths.runtimeDir, "service"));
        }
        this.files.assertUnchanged(before);
        // Retain the very same admitted LinuxPaths object through the operation.
        if (full) readLinuxIdentity(selection.paths!);
        return await action(before, selection, !!release);
      } finally {
        release?.();
      }
    };
    const stateDir = selection.paths?.dir ?? before.unit?.definition.stateDir;
    if (!stateDir) return actionWithManagerGuard();
    return withHeadlessOwnership(
      {
        stateDir,
        uid: this.machine.uid,
        create: installing,
        startupPreference: (result) => result.autostartConfigured,
      },
      actionWithManagerGuard,
    );
  }

  private async execute(verb: SystemdVerb, snapshot: SystemdFileSnapshot): Promise<void> {
    this.files.assertUnchanged(snapshot);
    try {
      await this.manager.execute(verb);
    } catch {
      failure(`systemd ${verb} failed or timed out; manager effect may be unresolved`);
    }
  }

  async install(): Promise<LinuxServiceStatus> {
    const runtime = (this.options.resolveRuntime ?? resolveServiceRuntime)();
    const defaults = ["/usr/local/bin", "/usr/bin", "/bin"];
    const callerPath = (this.options.env.PATH ?? "")
      .split(":")
      .filter((entry) => isAbsolute(entry) && !defaults.includes(entry));
    return this.serialized(true, true, async (before, selection) => {
      const old = before.unit?.definition;
      const definition: SystemdUnitDefinition = {
        v: 1,
        machineId: this.machine.machineId,
        nodePath: runtime.nodePath,
        cliPath: runtime.cliPath,
        stateDir: selection.paths!.dir,
        runtimeRoot: dirname(dirname(selection.paths!.runtimeDir)),
        serviceInstance: old?.serviceInstance ?? randomUUID(),
        path: [...new Set([dirname(runtime.nodePath), ...callerPath, ...defaults])].join(":"),
      };
      const raw = renderSystemdUnit(definition);
      const observed = await this.manager.observe();
      this.assertManager(before, observed, !before.unit);
      if (before.unit?.raw.equals(raw)) return this.result(before, selection);
      if (!inactive(observed) || observed.mainPid !== null)
        failure(
          "active service definition cannot be updated; stop, install, then start explicitly",
        );
      const local = await this.local(before, selection, observed);
      if (local.kind !== "absent")
        failure(
          "local endpoint ownership is foreign or unverified; stop foreground owner before install",
        );
      const current = await this.manager.observe();
      this.assertManager(before, current, !before.unit);
      if (!inactive(current) || current.mainPid !== null)
        failure("active service job changed during install admission; stop before updating");
      if (old) definition.serviceInstance = randomUUID();
      let changed: SystemdFileSnapshot | undefined;
      try {
        changed = this.files.publish(before, definition);
        await this.execute("daemon-reload", changed);
        this.assertManager(changed, await this.manager.observe());
        return await this.result(changed, selection);
      } catch {
        if (changed) {
          this.files.restore(before, changed);
          try {
            await this.manager.execute("daemon-reload");
          } catch {
            failure(
              "systemd install failed; definition restored but manager reload remains unresolved",
            );
          }
        }
        failure(
          "systemd install failed; owned definition restored where possible, inspect manager discovery",
        );
      }
    });
  }

  enable(): Promise<LinuxServiceStatus> {
    return this.link(true);
  }
  disable(): Promise<LinuxServiceStatus> {
    return this.link(false);
  }
  private link(wanted: boolean): Promise<LinuxServiceStatus> {
    return this.serialized(wanted, false, async (before, selection, guarded) => {
      const observed = await this.manager.observe();
      this.assertManager(before, observed, !before.unit && !wanted);
      if (!before.unit && wanted) failure("service is not installed; run service install first");
      if (before.link && !before.link.owned) {
        if (wanted) failure("foreign autostart leaf prevents service enablement");
        return this.result(
          before,
          selection,
          "Foreign autostart artifact remains; inspect it explicitly",
        );
      }
      if (!guarded)
        return this.result(
          before,
          selection,
          "Owned autostart cleanup remains; restore a safe local runtime before changing files",
        );
      if (!!before.link === wanted) return this.result(before, selection);
      const changed = this.files.setEnabled(before, wanted);
      try {
        await this.execute("daemon-reload", changed);
        this.assertManager(changed, await this.manager.observe(), !changed.unit);
      } catch {
        // Explicit revocation is never undone after an uncertain reload.
        if (wanted) this.files.restore(before, changed);
        failure(
          `systemd ${wanted ? "enable" : "disable"} reload failed; inspect remaining manager state`,
        );
      }
      return this.result(changed, selection);
    });
  }

  start(): Promise<LinuxServiceStatus> {
    return this.run("start");
  }
  restart(): Promise<LinuxServiceStatus> {
    return this.run("restart");
  }
  stop(): Promise<LinuxServiceStatus> {
    return this.run("stop");
  }
  uninstall(): Promise<LinuxServiceStatus> {
    return this.run("uninstall");
  }

  private async stopped(
    snapshot: SystemdFileSnapshot,
    selection: Selection,
    stoppingPid: number | null,
  ): Promise<void> {
    const deadline = this.clock.now() + 10_000;
    while (this.clock.now() < deadline) {
      const observed = await this.manager.observe();
      this.assertManager(snapshot, observed);
      if (observed.mainPid !== null && observed.mainPid !== stoppingPid)
        failure("service stop manager job changed; ownership unresolved");
      const local = await this.local(
        snapshot,
        selection,
        { ...observed, mainPid: stoppingPid },
        Math.min(500, deadline - this.clock.now()),
      );
      if (local.kind === "foreign") failure("service stop ownership changed; endpoint is foreign");
      const after = await this.manager.observe();
      this.assertManager(snapshot, after);
      if (
        (after.mainPid !== null && after.mainPid !== stoppingPid) ||
        (inactive(observed) && !inactive(after))
      )
        failure("service stop manager job changed during local probe; ownership unresolved");
      if (
        inactive(after) &&
        after.mainPid === null &&
        (!selection.paths || local.kind === "absent")
      )
        return;
      await this.clock.sleep(Math.min(100, Math.max(0, deadline - this.clock.now())));
    }
    failure("service stop timed out; stopped state remains unresolved");
  }

  private async stopOwned(snapshot: SystemdFileSnapshot, selection: Selection): Promise<void> {
    const observed = await this.manager.observe();
    this.assertManager(snapshot, observed);
    const local = await this.local(snapshot, selection, observed);
    if (local.kind === "foreign")
      failure("local endpoint ownership is foreign; refusing service stop");
    const current = await this.manager.observe();
    this.assertManager(snapshot, current);
    if (current.mainPid !== observed.mainPid || (inactive(observed) && !inactive(current)))
      failure("service stop ownership changed during local probe");
    if (
      inactive(current) &&
      current.mainPid === null &&
      (!selection.paths || local.kind === "absent")
    )
      return;
    await this.execute("stop", snapshot);
    await this.stopped(snapshot, selection, observed.mainPid);
  }

  private async ready(
    snapshot: SystemdFileSnapshot,
    selection: Selection,
    job: StartedJob = {},
  ): Promise<LocalStatus> {
    const deadline = this.clock.now() + 10_000;
    while (this.clock.now() < deadline) {
      const observed = await this.manager.observe();
      this.assertManager(snapshot, observed);
      if (job.pid !== undefined && observed.mainPid !== job.pid)
        failure("service readiness manager job changed");
      if (observed.mainPid !== null) job.pid ??= observed.mainPid;
      const local = await this.local(
        snapshot,
        selection,
        observed,
        Math.min(500, deadline - this.clock.now()),
      );
      if (local.kind === "foreign") failure("service readiness ownership is foreign");
      const after = await this.manager.observe();
      this.assertManager(snapshot, after);
      if (after.mainPid !== observed.mainPid) failure("service readiness manager job changed");
      if (
        after.activeState === "active" &&
        after.conditionResult &&
        after.mainPid !== null &&
        local.kind === "verified"
      )
        return local.local!;
      await this.clock.sleep(Math.min(100, Math.max(0, deadline - this.clock.now())));
    }
    failure("service readiness timed out");
  }

  private async cleanupStart(
    snapshot: SystemdFileSnapshot,
    selection: Selection,
    job: StartedJob,
  ): Promise<void> {
    const observed = await this.manager.observe();
    this.assertManager(snapshot, observed);
    const local = await this.local(snapshot, selection, observed);
    const current = await this.manager.observe();
    this.assertManager(snapshot, current);
    if (current.mainPid !== observed.mainPid || (inactive(observed) && !inactive(current)))
      failure("start ownership changed during local probe; cleanup unresolved");
    if (inactive(current) && current.mainPid === null && local.kind === "absent") return;
    if (
      observed.mainPid === null ||
      (job.pid !== undefined && job.pid !== observed.mainPid) ||
      !["verified", "absent"].includes(local.kind)
    )
      failure("start ownership unresolved; no cleanup stop was attempted");
    await this.execute("stop", snapshot);
    await this.stopped(snapshot, selection, observed.mainPid);
  }

  private run(command: "start" | "restart" | "stop" | "uninstall"): Promise<LinuxServiceStatus> {
    const revoking = command === "stop" || command === "uninstall";
    return this.serialized(!revoking, false, async (before, selection, guarded) => {
      const observed = await this.manager.observe();
      this.assertManager(before, observed, !before.unit && revoking);
      if (!before.unit) {
        if (!revoking) failure("service is not installed; run service install first");
        return this.result(before, selection);
      }
      const local = await this.local(before, selection, observed);
      if (local.kind === "foreign") failure("local endpoint ownership is foreign");
      if (command !== "start") await this.stopOwned(before, selection);
      if (revoking) {
        let current = before;
        if (command === "uninstall" && guarded) {
          if (!current.link || current.link.owned) current = this.files.setEnabled(current, false);
          current = this.files.remove(current);
          await this.execute("daemon-reload", current);
          this.assertManager(current, await this.manager.observe(), true);
        }
        const diagnostic =
          command === "uninstall"
            ? guarded
              ? "Service uninstalled; credentials remain unchanged"
              : "Service stopped; owned definition and autostart cleanup remain until runtime is safe"
            : "Service stopped; if enabled, it may start after a later user-manager restart";
        return this.result(current, selection, diagnostic, true);
      }
      if (command === "start" && observed.activeState === "active") {
        await this.ready(before, selection);
        const result = await this.result(before, selection);
        if (!result.ready) failure("service start readiness changed during final confirmation");
        return result;
      }
      if (
        command === "start" &&
        (!inactive(observed) || observed.mainPid !== null || local.kind !== "absent")
      )
        failure(
          "service start ownership is unresolved; stop the foreground or pending owner first",
        );
      const current = await this.manager.observe();
      this.assertManager(before, current);
      if (!inactive(current) || current.mainPid !== null)
        failure("service start manager job changed before command; ownership unresolved");
      const job: StartedJob = {};
      try {
        await this.execute("start", before);
        await this.ready(before, selection, job);
        const result = await this.result(before, selection);
        if (!result.ready) failure("service start readiness changed during final confirmation");
        return result;
      } catch {
        try {
          await this.cleanupStart(before, selection, job);
        } catch {
          failure("service start failed; ownership or cleanup remains unresolved");
        }
        failure("service start failed; newly started owned job was stopped");
      }
    });
  }
}
