import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { ConfigEditError, editConfig, paths, readConfig } from "../config.js";
import { configRevision, resolveConfigSet } from "../config-values.js";
import {
  type ControlV2Client,
  ControlV2ClientError,
  connectControlV2,
} from "../control-v2-client.js";
import type { ControlRuntime } from "../control-v2-protocol.js";
import type { Check } from "../doctor.js";
import { optionalStat } from "../host-files.js";
import type { ServiceDefinition, ServiceManager, ServiceSnapshot } from "../service-manager.js";
import {
  type OwnershipIntent,
  type OwnerTransaction,
  ServiceOwnerStore,
} from "../service-ownership.js";
import { ServiceReadiness } from "../service-readiness.js";
import { inspectBundleRuntime } from "./bundle-runtime.js";
import { DesktopSupervisor } from "./desktop-supervisor.js";
import { runOwnershipTransition } from "./ownership-transition.js";
import type { NativePlatform } from "./platform.js";
import {
  NativeControllerError,
  NativeDataSchemas,
  type NativeEvent,
  type NativeExpected,
  type NativeRecord,
  type NativeRecordTransaction,
  type NativeRequest,
  NativeRequestSchema,
  type NativeSelection,
  NativeSelectionSchema,
  type NativeStatus,
  NativeStatusSchema,
  type NativeTransition,
  requireNativeManagerMode,
} from "./protocol.js";
import type { NativeRecordStore } from "./record-store.js";
import { admitNativeState } from "./service-entry.js";
export interface NativeCoordinatorOptions {
  desktop?: Pick<DesktopSupervisor, "start" | "stop" | "inspect" | "close">;
  store: NativeRecordStore;
  platform: NativePlatform;
  bundlePath: string;
  uid: number;
  homeDir: string;
  agentVersion: string;
  defaultStateDir: string;
  readiness?: ServiceReadiness;
  connect?: typeof connectControlV2;
  newId?: () => string;
  diagnose?: (stateDir: string) => Promise<Check[]>;
  inspectBundle?: typeof inspectBundleRuntime;
}
export class NativeCoordinator {
  private readonly desktop;
  private readonly readiness: ServiceReadiness;
  private readonly newId: () => string;
  private client: ControlV2Client | undefined;
  private readonly listeners = new Set<(event: NativeEvent) => void>();
  private closed = false;
  constructor(private readonly options: NativeCoordinatorOptions) {
    this.desktop =
      options.desktop ??
      new DesktopSupervisor({
        uid: options.uid,
        homeDir: options.homeDir,
        readiness: options.readiness,
        admitBundle: options.inspectBundle,
      });
    this.readiness = options.readiness ?? new ServiceReadiness();
    this.newId = options.newId ?? randomUUID;
  }
  async status(): Promise<NativeStatus> {
    try {
      return await this.observe(
        this.options.store.inspect(),
        await this.options.platform.inspectLegacy(),
      );
    } catch (e) {
      throw this.error(e);
    }
  }
  private stateDirectory(record: NativeRecord | null, legacyStateDir?: string | null): string {
    return (
      record?.selection?.stateDir ??
      record?.transition?.destination?.stateDir ??
      record?.transition?.source?.stateDir ??
      legacyStateDir ??
      record?.recovery?.stateDir ??
      this.options.defaultStateDir
    );
  }
  private async observe(
    record: NativeRecord | null,
    legacy: ServiceSnapshot,
  ): Promise<NativeStatus> {
    const selection = record?.selection ?? null,
      bundle =
        selection?.bundlePath ?? record?.transition?.source?.bundlePath ?? this.options.bundlePath;
    const [manual, persistent, desktopLogin] = await Promise.all([
      this.options.platform.inspect("manual", bundle),
      this.options.platform.inspect("persistent", bundle),
      this.options.platform.loginStatus(this.options.bundlePath).catch(() => "unknown" as const),
    ]);
    const stateDir = this.stateDirectory(record, legacy.definition?.stateDir);
    const identity = admitNativeState(stateDir, this.options.uid);
    const desktop =
      selection?.mode === "desktop"
        ? await this.desktop.inspect(selection)
        : { registration: "not-registered" as const, loaded: false, pid: null, bundlePath: null };
    const job = selection
      ? selection.mode === "desktop"
        ? desktop
        : requireNativeManagerMode(selection.mode) === "manual"
          ? manual
          : persistent
      : null;
    const expected = identity
      ? {
          stateDir,
          computerFp: identity.fp,
          serviceInstance: selection?.serviceInstance ?? legacy.definition?.serviceInstance ?? null,
          ...(job?.pid ? { pid: job.pid } : {}),
        }
      : undefined;
    const observed = await this.readiness.observe(paths(stateDir).sock, expected);
    if (
      observed.kind === "verified" &&
      (!identity ||
        (selection && (!job?.loaded || !job.pid || identity.fp !== selection.computerFp)))
    )
      observed.kind = "foreign";
    if (selection) {
      const after =
        selection.mode === "desktop"
          ? await this.desktop.inspect(selection)
          : await this.options.platform.inspect(requireNativeManagerMode(selection.mode), bundle);
      if (JSON.stringify(after) !== JSON.stringify(job)) {
        observed.kind = "unverified";
        observed.local = null;
      }
    }
    const owner = new ServiceOwnerStore({ stateDir, uid: this.options.uid }).inspect();
    return NativeStatusSchema.parse({
      desktopLogin,
      desktop,
      ownership: {
        revision: owner?.revision ?? null,
        mode:
          owner?.mode ??
          (selection || record?.transition
            ? "legacy-native"
            : legacy.installed || legacy.loaded
              ? "headless"
              : null),
        consented: owner?.consented ?? false,
        startupEnabled: owner?.startupEnabled ?? null,
        transition: owner?.transition ?? null,
      },
      revision: record?.revision ?? null,
      selection,
      transition: record?.transition
        ? {
            id: record.transition.id,
            action: record.transition.action,
            phase: record.transition.phase,
          }
        : null,
      recoveryAvailable: !!record?.recovery,
      manualRecoveryAvailable:
        ((record?.transition?.destination?.mode === "persistent" &&
          selection?.serviceInstance === record.transition.destination.serviceInstance &&
          ["start", "restart"].includes(record.transition.action) &&
          !record.transition.restoreLegacy) ||
          (this.isManualRecovery(record) &&
            selection?.serviceInstance === record?.transition?.source?.serviceInstance)) &&
        !manual.loaded &&
        !persistent.loaded &&
        observed.kind === "absent" &&
        !legacy.installed &&
        !legacy.loaded,
      legacy: {
        installed: legacy.installed,
        loaded: legacy.loaded,
        stateDir: legacy.definition?.stateDir ?? null,
      },
      manual,
      persistent,
      local: { kind: observed.kind, status: observed.local },
    });
  }
  private error(e: unknown): NativeControllerError {
    if (e instanceof NativeControllerError) return e;
    if (e instanceof ConfigEditError)
      return new NativeControllerError(
        e.code === "busy" ? "busy" : e.code === "invalid" ? "invalid-config" : "unsafe-state",
      );
    if (e instanceof ControlV2ClientError) {
      if (e.code === "server-error")
        return new NativeControllerError(
          e.serverCode === "runtime-mismatch"
            ? "conflict"
            : e.serverCode === "pairing-busy"
              ? "busy"
              : "operation-failed",
        );
      return new NativeControllerError(
        e.code === "protocol-error" || e.code === "closed" ? "unavailable" : e.code,
      );
    }
    return new NativeControllerError("operation-failed");
  }
  private exact(a: ControlRuntime | null, b: ControlRuntime | null): boolean {
    return a === null || b === null
      ? a === b
      : ["pid", "agentVersion", "computerFp", "stateDir", "serviceInstance"].every(
          (key) => a[key as keyof ControlRuntime] === b[key as keyof ControlRuntime],
        );
  }
  private expect(status: NativeStatus, expected: NativeExpected, allowLegacy = false): void {
    if (
      status.revision !== expected.revision ||
      !this.exact(status.local.status?.process ?? null, expected.runtime)
    )
      throw new NativeControllerError("conflict");
    if (status.local.kind === "foreign" || (status.local.kind === "unverified" && !allowLegacy))
      throw new NativeControllerError("conflict");
  }
  private async control(status: NativeStatus): Promise<ControlV2Client> {
    const runtime = status.local.status?.process;
    if (status.local.kind !== "verified" || !runtime)
      throw new NativeControllerError("unavailable");
    if (this.client && !this.exact(this.client.runtime, runtime)) {
      this.client.close();
      this.client = undefined;
    }
    if (!this.client) {
      const client = await (this.options.connect ?? connectControlV2)(
        paths(runtime.stateDir).sock,
        {
          onPairingRequest: (event) => this.emit({ ...event, v: 1 }),
          onPairingClosed: (event) => this.emit({ ...event, v: 1 }),
          onDisconnect: () => {
            this.client = undefined;
          },
        },
      );
      if (this.closed) {
        client.close();
        throw new NativeControllerError("unavailable");
      }
      if (!this.exact(client.runtime, runtime)) {
        client.close();
        throw new NativeControllerError("conflict");
      }
      this.client = client;
    }
    return this.client;
  }
  private async settings(status: NativeStatus) {
    const stateDir =
        status.selection?.stateDir ?? status.legacy.stateDir ?? this.options.defaultStateDir,
      config = readConfig(paths(stateDir)),
      savedRevision = configRevision(config);
    const appliedRevision =
      status.local.kind === "verified"
        ? await (await this.control(status)).configurationRevision()
        : null;
    return {
      saved: config,
      savedRevision,
      appliedRevision,
      applied:
        status.local.kind === "absent"
          ? "not-running"
          : appliedRevision === null
            ? "unknown"
            : appliedRevision === savedRevision
              ? "matches"
              : "restart-required",
    };
  }
  async execute(input: Exclude<NativeRequest, { cmd: "hello" }>): Promise<unknown> {
    try {
      if (this.closed) throw new NativeControllerError("unavailable");
      const parsed = NativeRequestSchema.safeParse(input);
      if (!parsed.success || parsed.data.cmd === "hello")
        throw new NativeControllerError("bad-request");
      const request = parsed.data;
      let result: unknown;
      if (!("args" in request)) {
        const status = await this.status();
        if (request.cmd === "status") result = status;
        else if (request.cmd === "settings.get") result = await this.settings(status);
        else if (request.cmd === "devices") result = await (await this.control(status)).devices();
        else result = { checks: await this.diagnose(status) };
      } else if ("ownerRevision" in request.args) {
        result = await this.ownership(
          request as Extract<NativeRequest, { cmd: `desktop.${string}` | `ownership.${string}` }>,
        );
      } else
        result = await this.guardLegacy(request, () =>
          this.options.store.mutate(request.args.expect.revision, async (tx) =>
            this.options.platform
              .withLegacyGuard(async (manager) => {
                const legacy = await manager.inspect(),
                  status = await this.observe(tx.current, legacy);
                if (
                  request.cmd.startsWith("service.") &&
                  (status.ownership?.mode === "desktop" || status.ownership?.transition)
                )
                  throw new NativeControllerError("conflict");
                const legacyException =
                  ((request.cmd === "service.start" && request.args.migrateLegacy) ||
                    (request.cmd === "service.recover" &&
                      request.args.action === "continue" &&
                      tx.current?.transition?.source === null &&
                      tx.current?.transition?.destination !== null &&
                      !!tx.current?.recovery)) &&
                  legacy.loaded &&
                  legacy.definition?.serviceInstance === null &&
                  status.local.kind === "unverified";
                this.expect(status, request.args.expect, legacyException);
                if (request.cmd.startsWith("service."))
                  return this.lifecycle(
                    request as Extract<NativeRequest, { cmd: `service.${string}` }>,
                    tx,
                    manager,
                    legacy,
                    status,
                  );
                if (request.cmd === "settings.set") {
                  const p = paths(
                    status.selection?.stateDir ??
                      status.legacy.stateDir ??
                      this.options.defaultStateDir,
                  );
                  editConfig(p, (current) => {
                    if (configRevision(current) !== request.args.configRevision)
                      throw new NativeControllerError("conflict");
                    let next = current;
                    for (const change of request.args.changes) {
                      const changeResult = resolveConfigSet(next, change.key, change.value, false);
                      if ("error" in changeResult)
                        throw new NativeControllerError("invalid-config");
                      next = changeResult.next;
                    }
                    return next;
                  });
                  return this.settings(status);
                }
                const client = await this.control(status);
                if (request.cmd === "devices.revoke") return client.revoke(request.args.phoneFp);
                if (request.cmd === "pairing.open") return client.openPairing();
                if (request.cmd === "pairing.close") {
                  await client.closePairing(request.args.flowId);
                  return {};
                }
                if (request.cmd === "pairing.confirm") {
                  await client.confirm(
                    request.args.flowId,
                    request.args.challengeId,
                    request.args.phoneFp,
                    request.args.accept,
                  );
                  return {};
                }
                throw new NativeControllerError("bad-request");
              })
              .catch((error) => {
                throw this.error(error);
              }),
          ),
        );
      const valid = NativeDataSchemas[request.cmd].safeParse(result);
      if (!valid.success)
        throw new NativeControllerError(
          "args" in request ? "delivery-unknown" : "operation-failed",
        );
      return valid.data;
    } catch (e) {
      throw this.error(e);
    }
  }
  private async guardLegacy<T>(request: NativeRequest, action: () => Promise<T>): Promise<T> {
    const status = await this.status();
    const stateDir =
      status.selection?.stateDir ??
      status.legacy.stateDir ??
      (request.cmd === "service.start" ? request.args.stateDir : undefined) ??
      this.options.defaultStateDir;
    if (request.cmd === "service.start" && !status.selection && !status.legacy.installed) {
      admitNativeState(stateDir, this.options.uid);
      await this.requireAbsentDestination(stateDir);
    }
    const owner = new ServiceOwnerStore({ stateDir, uid: this.options.uid });
    return owner.mutate(owner.inspect()?.revision ?? null, async (tx) => {
      if (
        request.cmd.startsWith("service.") &&
        (tx.current?.mode === "desktop" || tx.current?.transition)
      )
        throw new NativeControllerError("conflict");
      return action();
    });
  }
  private async ownership(
    request: Extract<NativeRequest, { cmd: `desktop.${string}` | `ownership.${string}` }>,
  ): Promise<NativeStatus> {
    const initial = await this.status();
    this.expect(initial, request.args.expect);
    const record = this.options.store.inspect();
    if ((record?.revision ?? null) !== initial.revision)
      throw new NativeControllerError("conflict");
    const stateDir = this.stateDirectory(record, initial.legacy.stateDir);
    const store = new ServiceOwnerStore({ stateDir, uid: this.options.uid });
    if (
      (request.cmd === "desktop.start" || request.cmd === "desktop.stop") &&
      (initial.ownership?.mode !== "desktop" || !initial.ownership.consented)
    )
      throw new NativeControllerError("conflict");
    return store.mutate(request.args.ownerRevision, async (owner) =>
      this.options.store.mutate(request.args.expect.revision, async (tx) =>
        this.options.platform.withLegacyGuard(async (manager) => {
          const legacy = await manager.inspect(),
            status = await this.observe(tx.current, legacy);
          this.expect(status, request.args.expect);
          if (request.cmd === "desktop.login.set") {
            if (owner.current?.mode !== "desktop" || !owner.current.consented)
              throw new NativeControllerError("conflict");
            if (owner.current.transition || tx.current?.transition)
              throw new NativeControllerError("recovery-required");
            await this.options.platform.setLogin(this.options.bundlePath, request.args.enabled);
            owner.publish({ ...owner.current, startupEnabled: request.args.enabled });
            return this.observe(tx.current, await manager.inspect());
          }
          if (request.cmd === "desktop.stop") {
            if (status.selection?.mode !== "desktop") throw new NativeControllerError("conflict");
            if (status.local.kind === "absent" && !status.desktop?.loaded) return status;
            if (status.local.kind !== "verified") throw new NativeControllerError("conflict");
            await this.desktop.stop(request.args.expect);
            await this.readiness.waitStopped(paths(stateDir).sock);
            return this.observe(tx.current, await manager.inspect());
          }
          if (request.cmd === "desktop.setup") {
            if (
              owner.current ||
              tx.current?.selection ||
              tx.current?.transition ||
              legacy.installed ||
              legacy.loaded ||
              status.manual.loaded ||
              status.persistent.loaded ||
              status.local.kind !== "absent"
            )
              throw new NativeControllerError("conflict");
          } else if (request.cmd === "desktop.start") {
            if (owner.current?.transition || tx.current?.transition)
              throw new NativeControllerError("recovery-required");
            if (
              owner.current?.mode !== "desktop" ||
              !owner.current.consented ||
              legacy.installed ||
              legacy.loaded ||
              status.manual.loaded ||
              status.persistent.loaded
            )
              throw new NativeControllerError("conflict");
            if (
              status.local.kind === "verified" &&
              status.selection?.mode === "desktop" &&
              status.desktop?.loaded
            )
              return status;
            if (status.local.kind !== "absent") throw new NativeControllerError("conflict");
          } else if (request.cmd === "ownership.recover") {
            if (!owner.current?.transition || owner.current.transition.id !== request.args.intentId)
              throw new NativeControllerError("conflict");
          } else if (owner.current?.transition)
            throw new NativeControllerError("recovery-required");
          const recovering = request.cmd === "ownership.recover";
          const target = recovering
            ? owner.current!.transition!.target
            : request.cmd === "ownership.convert"
              ? request.args.target
              : "desktop";
          if (target === "headless")
            return this.convertToHeadless(owner, tx, manager, legacy, status, stateDir, recovering);
          await this.admitBundle(this.options.bundlePath);
          if (["foreign", "unverified"].includes(status.local.kind))
            throw new NativeControllerError("conflict");
          const identity = admitNativeState(
            stateDir,
            this.options.uid,
            request.cmd === "desktop.setup",
          );
          if (!identity) throw new NativeControllerError("unsafe-state");
          const prior =
            recovering && tx.current?.transition?.id === owner.current?.transition?.id
              ? tx.current!.transition
              : null;
          const completed =
            recovering && !tx.current?.transition && tx.current?.selection?.mode === "desktop"
              ? tx.current.selection
              : null;
          const source = completed ? null : prior ? prior.source : (tx.current?.selection ?? null);
          const intent: OwnershipIntent = recovering
            ? owner.current!.transition!
            : {
                id: this.newId(),
                source: status.ownership?.mode ?? null,
                target,
                sourceManager: source
                  ? source.mode === "desktop"
                    ? "desktop-child"
                    : source.mode === "manual"
                      ? "native-manual"
                      : "native-persistent"
                  : legacy.installed || legacy.loaded
                    ? "launchd"
                    : null,
                sourceInstance:
                  source?.serviceInstance ?? legacy.definition?.serviceInstance ?? null,
                stateDir,
                computerFp: identity.fp,
                targetBundlePath: this.options.bundlePath,
                targetVersion: this.options.agentVersion,
                phase: "prepared",
              };
          if (
            intent.stateDir !== stateDir ||
            intent.computerFp !== identity.fp ||
            intent.targetBundlePath !== this.options.bundlePath ||
            intent.targetVersion !== this.options.agentVersion
          )
            throw new NativeControllerError("conflict");
          const instance = this.newId();
          const environment = source?.environment ?? legacy.definition?.environment;
          const destination: NativeSelection = completed ??
            prior?.destination ?? {
              mode: "desktop",
              stateDir,
              computerFp: identity.fp,
              serviceInstance: instance,
              bundlePath: this.options.bundlePath,
              bundleId: "sh.bilal.shellbell.host",
              agentVersion: this.options.agentVersion,
              environment: {
                PATH: environment?.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                ...(environment?.HERDR_SOCKET_PATH
                  ? { HERDR_SOCKET_PATH: environment.HERDR_SOCKET_PATH }
                  : {}),
                ...(environment?.XDG_CONFIG_HOME
                  ? { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME }
                  : {}),
                SHELLBELL_DIR: stateDir,
                SHELLBELL_SERVICE_INSTANCE: instance,
              },
            };
          if (
            destination.mode !== "desktop" ||
            destination.computerFp !== identity.fp ||
            destination.stateDir !== stateDir ||
            destination.bundlePath !== intent.targetBundlePath ||
            destination.agentVersion !== intent.targetVersion
          )
            throw new NativeControllerError("conflict");
          const readyDestination = async () => {
            const observed = await this.observe(tx.current, await manager.inspect());
            return (
              observed.selection?.serviceInstance === destination.serviceInstance &&
              observed.local.kind === "verified" &&
              !!observed.desktop?.loaded &&
              !observed.manual.loaded &&
              !observed.persistent.loaded &&
              !observed.legacy.installed &&
              !observed.legacy.loaded
            );
          };
          await runOwnershipTransition(owner, intent, {
            preflight: async () => {
              if (!NativeSelectionSchema.safeParse(destination).success)
                throw new NativeControllerError("unsafe-state");
              await this.admitBundle(destination.bundlePath);
            },
            stopSource: async () => {
              if (intent.source === "headless" && owner.current?.startupEnabled)
                await this.options.platform.setLogin(this.options.bundlePath, true);
              if (!prior) {
                let recovery = tx.current?.recovery ?? null;
                if (legacy.installed) {
                  if (!legacy.raw || !legacy.definition || (recovery && recovering))
                    throw new NativeControllerError("recovery-required");
                  recovery = {
                    id: this.newId(),
                    definitionPath: manager.definitionPath,
                    rawBase64: legacy.raw.toString("base64"),
                    sha256: createHash("sha256").update(legacy.raw).digest("hex"),
                    wasLoaded: legacy.loaded,
                    stateDir,
                    computerFp: identity.fp,
                  };
                }
                this.publish(tx, {
                  recovery,
                  transition: {
                    id: intent.id,
                    action: "start",
                    phase: "prepared",
                    source,
                    destination,
                    recoveryId: recovery?.id ?? null,
                  },
                });
              }
              if (await readyDestination()) return;
              if (source) {
                if (source.stateDir !== stateDir || source.computerFp !== identity.fp)
                  throw new NativeControllerError("conflict");
                if (source.mode === "desktop") {
                  const observed = await this.observe(tx.current, await manager.inspect());
                  if (observed.desktop?.loaded) {
                    if (observed.local.kind !== "verified")
                      throw new NativeControllerError("conflict");
                    await this.desktop.stop({
                      revision: observed.revision,
                      runtime: observed.local.status!.process,
                    });
                  }
                } else {
                  const job = await this.options.platform.inspect(source.mode, source.bundlePath);
                  const disabledPersistent = source.mode === "persistent" && !job.loaded;
                  if (disabledPersistent) await this.options.platform.prepareManualRecovery(source);
                  else if (job.loaded || job.registration !== "not-registered")
                    await this.options.platform.stop(source, job);
                  await this.readiness.waitStopped(paths(stateDir).sock);
                  // A verified disabled/not-found legacy helper has no removable
                  // manual definition; do not require its broken registration to
                  // report not-registered after guarded recovery already disarmed it.
                  if (!disabledPersistent) await this.options.platform.remove(source);
                }
              }
              const currentLegacy = await manager.inspect();
              if (currentLegacy.installed || currentLegacy.loaded) {
                const backup = tx.current?.recovery;
                if (
                  !backup ||
                  !currentLegacy.raw ||
                  createHash("sha256").update(currentLegacy.raw).digest("hex") !== backup.sha256
                )
                  throw new NativeControllerError("conflict");
                if (currentLegacy.loaded) await manager.unload();
                await this.readiness.waitStopped(paths(stateDir).sock);
                const unloaded = await manager.inspect();
                if (unloaded.loaded || !unloaded.raw?.equals(currentLegacy.raw))
                  throw new NativeControllerError("conflict");
                await manager.restore(null);
              }
            },
            verifyAbsent: async () => {
              if (await readyDestination()) return;
              const observed = await this.observe(tx.current, await manager.inspect());
              if (
                observed.manual.loaded ||
                observed.persistent.loaded ||
                observed.legacy.installed ||
                observed.legacy.loaded ||
                observed.desktop?.loaded ||
                observed.local.kind !== "absent"
              )
                throw new NativeControllerError("conflict");
              this.phase(tx, "source-stopped", { selection: null });
            },
            startDestination: async () => {
              if (await readyDestination()) return;
              this.phase(tx, "destination-start-requested", { selection: destination });
              await this.desktop.start(destination);
              await this.certify(destination);
              this.phase(tx, "destination-ready");
            },
            complete: async () => {
              this.publish(tx, { selection: destination, transition: null });
            },
          });
          return this.observe(tx.current, await manager.inspect());
        }),
      ),
    );
  }
  private async convertToHeadless(
    owner: OwnerTransaction,
    tx: NativeRecordTransaction,
    manager: ServiceManager,
    legacy: ServiceSnapshot,
    status: NativeStatus,
    stateDir: string,
    recovering: boolean,
  ): Promise<NativeStatus> {
    if (
      !recovering &&
      owner.current?.mode === "headless" &&
      !tx.current?.selection &&
      !tx.current?.transition
    )
      return status;
    if (["foreign", "unverified"].includes(status.local.kind))
      throw new NativeControllerError("conflict");
    await this.admitBundle(this.options.bundlePath);
    const runtime = await (this.options.inspectBundle ?? inspectBundleRuntime)(
      this.options.bundlePath,
    );
    const identity = admitNativeState(stateDir, this.options.uid);
    if (!identity) throw new NativeControllerError("unsafe-state");
    const prior =
      recovering && tx.current?.transition?.id === owner.current?.transition?.id
        ? tx.current!.transition
        : null;
    const source = prior ? prior.source : (tx.current?.selection ?? null);
    const intent: OwnershipIntent = recovering
      ? owner.current!.transition!
      : {
          id: this.newId(),
          source: status.ownership?.mode ?? null,
          target: "headless",
          sourceManager:
            source?.mode === "desktop"
              ? "desktop-child"
              : source?.mode === "manual"
                ? "native-manual"
                : source?.mode === "persistent"
                  ? "native-persistent"
                  : null,
          sourceInstance: source?.serviceInstance ?? null,
          stateDir,
          computerFp: identity.fp,
          targetBundlePath: this.options.bundlePath,
          targetVersion: this.options.agentVersion,
          phase: "prepared",
        };
    if (
      intent.target !== "headless" ||
      intent.stateDir !== stateDir ||
      intent.computerFp !== identity.fp ||
      intent.targetBundlePath !== this.options.bundlePath ||
      intent.targetVersion !== this.options.agentVersion
    )
      throw new NativeControllerError("conflict");
    const environment =
      source?.environment ??
      (recovering && legacy.definition?.serviceInstance === intent.id
        ? legacy.definition.environment
        : undefined);
    const definition: ServiceDefinition = {
      nodePath: runtime.nodePath,
      cliPath: join(this.options.bundlePath, "Contents/Resources/agent/dist/cli.js"),
      stateDir,
      serviceInstance: intent.id,
      logPath: paths(stateDir).log,
      environment: {
        PATH: environment?.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        SHELLBELL_DIR: stateDir,
        SHELLBELL_SERVICE_INSTANCE: intent.id,
        ...(environment?.HERDR_SOCKET_PATH
          ? { HERDR_SOCKET_PATH: environment.HERDR_SOCKET_PATH }
          : {}),
        ...(environment?.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME } : {}),
      },
    };
    const isDestination = (snapshot: ServiceSnapshot) => {
      const d = snapshot.definition;
      return (
        snapshot.installed &&
        !!d &&
        d.serviceInstance === intent.id &&
        d.stateDir === stateDir &&
        d.nodePath === definition.nodePath &&
        d.cliPath === definition.cliPath &&
        d.logPath === definition.logPath &&
        JSON.stringify(Object.entries(d.environment).sort()) ===
          JSON.stringify(Object.entries(definition.environment).sort())
      );
    };
    const expected = { stateDir, computerFp: identity.fp, serviceInstance: intent.id };
    const destinationReady = async () => {
      const snapshot = await manager.inspect();
      if (!isDestination(snapshot) || !snapshot.loaded) return false;
      const observed = await this.readiness.observe(paths(stateDir).sock, expected);
      if (observed.kind !== "verified") return false;
      const after = await manager.inspect();
      return isDestination(after) && after.loaded;
    };
    await runOwnershipTransition(owner, intent, {
      preflight: async () => {
        if (legacy.installed || legacy.loaded) {
          if (!recovering || !isDestination(legacy)) throw new NativeControllerError("conflict");
        }
        if (
          legacy.loaded &&
          (status.manual.loaded ||
            status.persistent.loaded ||
            (source?.mode === "desktop" && (await this.desktop.inspect(source)).loaded))
        )
          throw new NativeControllerError("conflict");
        if (source && (source.stateDir !== stateDir || source.computerFp !== identity.fp))
          throw new NativeControllerError("conflict");
        if (
          (status.manual.loaded && source?.mode !== "manual") ||
          (status.persistent.loaded && source?.mode !== "persistent")
        )
          throw new NativeControllerError("conflict");
      },
      stopSource: async () => {
        this.publish(tx, {
          transition: {
            id: intent.id,
            action: "recover",
            phase: "prepared",
            source,
            destination: null,
            recoveryId: tx.current?.recovery?.id ?? null,
          },
        });
        // Headless startup belongs to launchd, never the desktop main-app item.
        const login = await this.options.platform.loginStatus(this.options.bundlePath);
        if (login === "unknown") throw new NativeControllerError("unavailable");
        if (login === "enabled" || login === "requires-approval")
          await this.options.platform.setLogin(this.options.bundlePath, false);
        if (await destinationReady()) return;
        if (source?.mode === "desktop") {
          const job = await this.desktop.inspect(source);
          if (job.loaded) {
            const local = await this.readiness.observe(paths(stateDir).sock, {
              stateDir,
              computerFp: identity.fp,
              serviceInstance: source.serviceInstance,
              ...(job.pid ? { pid: job.pid } : {}),
            });
            if (local.kind !== "verified") throw new NativeControllerError("conflict");
            await this.desktop.stop({
              revision: tx.current?.revision ?? null,
              runtime: local.local!.process,
            });
          }
        } else if (source) {
          const job = await this.options.platform.inspect(source.mode, source.bundlePath);
          const disabledPersistent = source.mode === "persistent" && !job.loaded;
          if (disabledPersistent) await this.options.platform.prepareManualRecovery(source);
          if (job.loaded || job.registration !== "not-registered")
            await this.options.platform.stop(source, job);
          await this.readiness.waitStopped(paths(stateDir).sock);
          if (!disabledPersistent) await this.options.platform.remove(source);
        }
      },
      verifyAbsent: async () => {
        if (await destinationReady()) return;
        const observed = await this.observe(tx.current, await manager.inspect());
        const current = await manager.inspect();
        if (
          observed.manual.loaded ||
          observed.persistent.loaded ||
          observed.desktop?.loaded ||
          current.loaded ||
          (current.installed && !isDestination(current)) ||
          observed.local.kind !== "absent"
        )
          throw new NativeControllerError("conflict");
        this.phase(tx, "source-stopped", { selection: null });
      },
      startDestination: async () => {
        if (await destinationReady()) return;
        await this.admitBundle(this.options.bundlePath);
        if (admitNativeState(stateDir, this.options.uid)?.fp !== identity.fp)
          throw new NativeControllerError("unsafe-state");
        // launchd opens its output before the CLI starts. Pre-create a private
        // leaf exclusively; never follow, truncate, or repair a replacement.
        if (!optionalStat(definition.logPath))
          closeSync(
            openSync(
              definition.logPath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            ),
          );
        this.phase(tx, "destination-start-requested", { selection: null });
        const current = await manager.inspect();
        if (!isDestination(current)) {
          if (current.installed || current.loaded) throw new NativeControllerError("conflict");
          await manager.write(definition);
        }
        await manager.setStartupEnabled(owner.current!.startupEnabled);
        const pid = await manager.load();
        await this.readiness.waitReady(paths(stateDir).sock, { ...expected, pid });
        if (!(await destinationReady())) throw new NativeControllerError("conflict");
        this.phase(tx, "destination-ready");
      },
      complete: async () => {
        this.publish(tx, { selection: null, transition: null });
      },
    });
    return this.observe(tx.current, await manager.inspect());
  }

  private async diagnose(status: NativeStatus): Promise<Check[]> {
    if (this.options.diagnose)
      return this.options.diagnose(
        status.selection?.stateDir ?? status.legacy.stateDir ?? this.options.defaultStateDir,
      );
    return [
      {
        name: "local-owner",
        ok: status.local.kind === "verified",
        severity:
          status.local.kind === "foreign"
            ? "error"
            : status.local.kind === "verified"
              ? "pass"
              : "warning",
        detail: status.local.kind,
      },
      {
        name: "legacy-service",
        ok: !status.legacy.loaded,
        severity: status.legacy.loaded ? "warning" : "pass",
        detail: status.legacy.loaded ? "Legacy service loaded" : "Legacy service stopped",
      },
    ];
  }
  private publish(
    tx: NativeRecordTransaction,
    patch: Partial<Omit<NativeRecord, "revision">>,
  ): NativeRecord {
    return tx.publish({
      v: 1,
      selection: null,
      transition: null,
      recovery: null,
      ...tx.current,
      ...patch,
    });
  }
  private phase(
    tx: NativeRecordTransaction,
    phase: NativeTransition["phase"],
    patch: Partial<Omit<NativeRecord, "revision">> = {},
  ) {
    const transition = tx.current?.transition;
    if (!transition) throw new NativeControllerError("recovery-required");
    return this.publish(tx, { ...patch, transition: { ...transition, phase } });
  }
  private async admitBundle(path: string, version = this.options.agentVersion) {
    const runtime = await (this.options.inspectBundle ?? inspectBundleRuntime)(path);
    if (runtime.agentVersion !== version) throw new NativeControllerError("upgrade-required");
    return runtime;
  }
  private async lifecycle(
    request: Extract<NativeRequest, { cmd: `service.${string}` }>,
    tx: NativeRecordTransaction,
    manager: ServiceManager,
    legacy: ServiceSnapshot,
    status: NativeStatus,
  ): Promise<NativeStatus> {
    if (request.cmd === "service.recover")
      return this.recover(request, tx, manager, legacy, status);
    if (tx.current?.transition) throw new NativeControllerError("recovery-required");
    const source = tx.current?.selection ?? null;
    if (
      (status.manual.loaded && source?.mode !== "manual") ||
      (status.persistent.loaded && source?.mode !== "persistent") ||
      (source && legacy.loaded)
    )
      throw new NativeControllerError("conflict");
    if (request.cmd !== "service.start" && !source) throw new NativeControllerError("conflict");
    if (
      request.cmd === "service.start" &&
      source &&
      requireNativeManagerMode(source.mode) === request.args.mode &&
      source.bundlePath === this.options.bundlePath &&
      status[requireNativeManagerMode(source.mode)].loaded
    )
      throw new NativeControllerError("conflict");
    if (legacy.installed && (request.cmd !== "service.start" || !request.args.migrateLegacy))
      throw new NativeControllerError("conflict");
    let destination: NativeSelection | null = null;
    if (request.cmd === "service.start" || request.cmd === "service.restart") {
      await this.admitBundle(this.options.bundlePath);
      await this.options.platform.preflight(
        request.cmd === "service.start"
          ? request.args.mode
          : requireNativeManagerMode(source!.mode),
        this.options.bundlePath,
      );
      const stateDir =
        source?.stateDir ??
        legacy.definition?.stateDir ??
        (request.cmd === "service.start" ? request.args.stateDir : undefined) ??
        this.options.defaultStateDir;
      if (
        request.cmd === "service.start" &&
        request.args.stateDir &&
        request.args.stateDir !== stateDir
      )
        throw new NativeControllerError("conflict");
      // The initial status can describe the default directory while this request
      // selects a different destination. Admit its endpoint before creating keys.
      if (!source && !legacy.installed) {
        admitNativeState(stateDir, this.options.uid);
        await this.requireAbsentDestination(stateDir);
      }
      const identity = admitNativeState(stateDir, this.options.uid, true)!;
      const serviceInstance = this.newId();
      destination = {
        mode: request.cmd === "service.start" ? request.args.mode : source!.mode,
        stateDir,
        computerFp: identity.fp,
        serviceInstance,
        bundlePath: this.options.bundlePath,
        bundleId: "sh.bilal.shellbell.host",
        agentVersion: this.options.agentVersion,
        environment: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          SHELLBELL_DIR: stateDir,
          SHELLBELL_SERVICE_INSTANCE: serviceInstance,
        },
      };
    }
    let recovery = tx.current?.recovery ?? null;
    if (legacy.installed) {
      if (!legacy.raw || !legacy.definition || recovery)
        throw new NativeControllerError("recovery-required");
      const identity = admitNativeState(legacy.definition.stateDir, this.options.uid);
      if (!identity) throw new NativeControllerError("unsafe-state");
      recovery = {
        id: this.newId(),
        definitionPath: manager.definitionPath,
        rawBase64: legacy.raw.toString("base64"),
        sha256: createHash("sha256").update(legacy.raw).digest("hex"),
        wasLoaded: legacy.loaded,
        stateDir: legacy.definition.stateDir,
        computerFp: identity.fp,
      };
    }
    this.publish(tx, {
      recovery,
      transition: {
        id: this.newId(),
        action: request.cmd.slice(8) as NativeTransition["action"],
        phase: "prepared",
        source,
        destination,
        recoveryId: recovery?.id ?? null,
      },
    });
    try {
      return await this.advance(tx, manager, legacy, status);
    } catch (e) {
      this.phase(tx, "recovery-required");
      throw e;
    }
  }
  private async stopSource(
    tx: NativeRecordTransaction,
    manager: ServiceManager,
    legacy: ServiceSnapshot,
    status: NativeStatus,
  ) {
    const transition = tx.current!.transition!,
      source = transition.source;
    this.phase(tx, "source-stop-requested");
    if (source) {
      try {
        await this.admitBundle(source.bundlePath, source.agentVersion);
      } catch {
        throw new NativeControllerError("recovery-required");
      }
      const job = status[requireNativeManagerMode(source.mode)];
      if (job.loaded || job.registration !== "not-registered")
        await this.options.platform.stop(source, job);
      await this.readiness.waitStopped(paths(source.stateDir).sock);
      const after = await this.options.platform.inspect(
        requireNativeManagerMode(source.mode),
        source.bundlePath,
      );
      if (
        after.loaded ||
        (requireNativeManagerMode(source.mode) === "persistent" &&
          after.registration !== "not-registered")
      )
        throw new NativeControllerError("operation-failed");
    } else if (legacy.installed) {
      if (legacy.loaded) await manager.unload();
      await this.readiness.waitStopped(paths(legacy.definition!.stateDir).sock);
      const after = await manager.inspect();
      if (after.loaded || !after.raw?.equals(legacy.raw!))
        throw new NativeControllerError("conflict");
    } else if (status.local.kind !== "absent") throw new NativeControllerError("conflict");
    // Stop retains the selection; handoff/removal releases it only after verified absence.
    this.phase(tx, "source-stopped", { selection: transition.action === "stop" ? source : null });
    if (
      source &&
      transition.destination &&
      (requireNativeManagerMode(source.mode) !==
        requireNativeManagerMode(transition.destination.mode) ||
        source.bundlePath !== transition.destination.bundlePath)
    )
      await this.options.platform.remove(source);
    if (legacy.installed) {
      await manager.restore(null);
      const after = await manager.inspect();
      if (after.installed || after.loaded) throw new NativeControllerError("operation-failed");
    }
  }
  private async advance(
    tx: NativeRecordTransaction,
    manager: ServiceManager,
    legacy: ServiceSnapshot,
    status: NativeStatus,
  ): Promise<NativeStatus> {
    const transition = tx.current!.transition!;
    await this.stopSource(tx, manager, legacy, status);
    if (transition.destination) await this.startDestination(tx, transition.destination);
    else if (transition.action === "remove" && transition.source) {
      await this.options.platform.remove(transition.source);
      this.publish(tx, { selection: null });
    }
    if (tx.current!.transition?.phase !== "awaiting-approval")
      this.publish(tx, { transition: null });
    return this.observe(tx.current, await manager.inspect());
  }
  private async startDestination(tx: NativeRecordTransaction, destination: NativeSelection) {
    await this.admitBundle(destination.bundlePath);
    const identity = admitNativeState(destination.stateDir, this.options.uid);
    if (identity?.fp !== destination.computerFp) throw new NativeControllerError("unsafe-state");
    // Recheck after source release, immediately before publication and launch.
    await this.requireAbsentDestination(destination.stateDir);
    this.phase(tx, "destination-start-requested", { selection: destination });
    const job = await this.options.platform.start(destination);
    if (job.registration === "requires-approval") {
      this.phase(tx, "awaiting-approval");
      return;
    }
    await this.certify(destination);
    this.phase(tx, "destination-ready");
  }
  private async requireAbsentDestination(stateDir: string): Promise<void> {
    const observed = await this.readiness.observe(paths(stateDir).sock);
    if (observed.kind !== "absent") throw new NativeControllerError("conflict");
  }
  private async certify(selection: NativeSelection) {
    const before =
      selection.mode === "desktop"
        ? await this.desktop.inspect(selection)
        : await this.options.platform.inspect(
            requireNativeManagerMode(selection.mode),
            selection.bundlePath,
          );
    if (!before.loaded || !before.pid) throw new NativeControllerError("operation-failed");
    const local = await this.readiness.waitReady(paths(selection.stateDir).sock, {
      computerFp: selection.computerFp,
      stateDir: selection.stateDir,
      serviceInstance: selection.serviceInstance,
      pid: before.pid,
    });
    const after =
      selection.mode === "desktop"
        ? await this.desktop.inspect(selection)
        : await this.options.platform.inspect(
            requireNativeManagerMode(selection.mode),
            selection.bundlePath,
          );
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      local.process.agentVersion !== selection.agentVersion
    )
      throw new NativeControllerError("conflict");
  }
  private isManualRecovery(record: NativeRecord | null): boolean {
    const transition = record?.transition;
    return (
      transition?.action === "recover" &&
      !transition.restoreLegacy &&
      transition.source?.mode === "persistent" &&
      transition.destination?.mode === "manual" &&
      transition.source.stateDir === transition.destination.stateDir &&
      transition.source.computerFp === transition.destination.computerFp
    );
  }
  private async recover(
    request: Extract<NativeRequest, { cmd: "service.recover" }>,
    tx: NativeRecordTransaction,
    manager: ServiceManager,
    legacy: ServiceSnapshot,
    status: NativeStatus,
  ): Promise<NativeStatus> {
    const record = tx.current;
    if (!record) throw new NativeControllerError("conflict");
    if (
      (status.manual.loaded && status.persistent.loaded) ||
      (record.selection && legacy.loaded) ||
      (record.selection &&
        status[
          requireNativeManagerMode(record.selection.mode) === "manual" ? "persistent" : "manual"
        ].loaded)
    )
      throw new NativeControllerError("conflict");
    if (request.args.action === "discard-backup") {
      if (
        record.transition ||
        !record.recovery ||
        (legacy.installed && legacy.raw?.toString("base64") !== record.recovery.rawBase64)
      )
        throw new NativeControllerError("conflict");
      this.publish(tx, { recovery: null });
      return this.observe(tx.current, legacy);
    }
    // Validate retained bytes before publishing any new intent or mutating a manager.
    const backup = record.recovery;
    const raw = backup ? Buffer.from(backup.rawBase64, "base64") : null;
    if (backup && (!raw || createHash("sha256").update(raw).digest("hex") !== backup.sha256))
      throw new NativeControllerError("unsafe-state");
    if (
      backup &&
      (backup.definitionPath !== manager.definitionPath ||
        admitNativeState(backup.stateDir, this.options.uid)?.fp !== backup.computerFp)
    )
      throw new NativeControllerError("unsafe-state");
    if (backup && legacy.installed && !legacy.raw?.equals(raw!))
      throw new NativeControllerError("conflict");
    const manualIntent = this.isManualRecovery(record);
    if (
      request.args.action === "use-manual" ||
      (request.args.action === "continue" && manualIntent)
    ) {
      const failed = manualIntent ? record.transition?.source : record.transition?.destination;
      if (
        failed?.mode !== "persistent" ||
        record.transition?.restoreLegacy ||
        (!manualIntent && !["start", "restart"].includes(record.transition!.action)) ||
        record.selection?.serviceInstance !== failed.serviceInstance ||
        status.manual.loaded ||
        status.persistent.loaded ||
        status.local.kind !== "absent" ||
        legacy.installed ||
        legacy.loaded
      )
        throw new NativeControllerError("conflict");
      await this.admitBundle(this.options.bundlePath);
      await this.options.platform.preflight("manual", this.options.bundlePath);
      if (admitNativeState(failed.stateDir, this.options.uid)?.fp !== failed.computerFp)
        throw new NativeControllerError("unsafe-state");
      const serviceInstance = this.newId();
      const destination: NativeSelection = manualIntent
        ? record.transition!.destination!
        : {
            ...failed,
            mode: "manual",
            bundlePath: this.options.bundlePath,
            agentVersion: this.options.agentVersion,
            serviceInstance,
            environment: { ...failed.environment, SHELLBELL_SERVICE_INSTANCE: serviceInstance },
          };
      // Persist the user's manual choice BEFORE any OS mutation. An interruption
      // must never make Continue retry the original automatic-start destination.
      if (!manualIntent)
        this.publish(tx, {
          transition: {
            id: this.newId(),
            action: "recover",
            phase: "prepared",
            source: failed,
            destination,
            recoveryId: record.recovery?.id ?? null,
          },
        });
      try {
        await this.options.platform.prepareManualRecovery(failed);
        await this.requireAbsentDestination(failed.stateDir);
        const fresh = await this.observe(tx.current, await manager.inspect());
        if (
          fresh.manual.loaded ||
          fresh.persistent.loaded ||
          fresh.legacy.installed ||
          fresh.legacy.loaded ||
          fresh.local.kind !== "absent"
        )
          throw new NativeControllerError("conflict");
        this.publish(tx, {
          selection: null,
          transition: {
            id: this.newId(),
            action: "start",
            phase: "source-stopped",
            source: null,
            destination,
            recoveryId: record.recovery?.id ?? null,
          },
        });
        await this.startDestination(tx, destination);
        this.publish(tx, { transition: null });
        return this.observe(tx.current, await manager.inspect());
      } catch (error) {
        this.phase(tx, "recovery-required");
        throw error;
      }
    }
    if (
      request.args.action === "continue" &&
      record.transition?.action === "recover" &&
      !record.transition.restoreLegacy
    )
      throw new NativeControllerError("recovery-required");
    try {
      if (request.args.action === "restore-legacy" || record.transition?.restoreLegacy) {
        if (!backup || !raw) throw new NativeControllerError("conflict");
        if (request.args.action === "restore-legacy") {
          if (legacy.loaded) throw new NativeControllerError("conflict");
          this.publish(tx, {
            transition: {
              id: this.newId(),
              action: "recover",
              phase: "prepared",
              source: record.selection,
              destination: null,
              recoveryId: backup.id,
              restoreLegacy: { restartPrevious: request.args.restartPrevious },
            },
          });
        }
        return await this.restoreLegacy(tx, manager, legacy, status, raw);
      }
      const transition = record.transition;
      if (!transition) throw new NativeControllerError("conflict");
      const destination = transition.destination;
      if (destination && record.selection?.serviceInstance === destination.serviceInstance) {
        const job = status[requireNativeManagerMode(destination.mode)];
        if (
          legacy.loaded ||
          status[requireNativeManagerMode(destination.mode) === "manual" ? "persistent" : "manual"]
            .loaded
        )
          throw new NativeControllerError("conflict");
        if (job.registration === "requires-approval") {
          this.phase(tx, "awaiting-approval");
          return this.observe(tx.current, legacy);
        }
        if (job.loaded) {
          await this.certify(destination);
          this.phase(tx, "destination-ready");
        } else {
          if (status.local.kind !== "absent") throw new NativeControllerError("conflict");
          await this.startDestination(tx, destination);
        }
        if (tx.current!.transition?.phase !== "awaiting-approval")
          this.publish(tx, { transition: null });
        return this.observe(tx.current, await manager.inspect());
      }
      return await this.advance(tx, manager, legacy, status);
    } catch (e) {
      if (tx.current?.transition) this.phase(tx, "recovery-required");
      throw e;
    }
  }
  private async restoreLegacy(
    tx: NativeRecordTransaction,
    manager: ServiceManager,
    legacy: ServiceSnapshot,
    status: NativeStatus,
    raw: Buffer,
  ): Promise<NativeStatus> {
    const record = tx.current!,
      backup = record.recovery!,
      consent = record.transition!.restoreLegacy!;
    if (legacy.loaded) {
      if (
        !consent.restartPrevious ||
        record.selection ||
        status.manual.loaded ||
        status.persistent.loaded ||
        status.local.kind !== "verified" ||
        !legacy.raw?.equals(raw)
      )
        throw new NativeControllerError("conflict");
      const fresh = await manager.inspect();
      if (!fresh.loaded || !fresh.raw?.equals(raw)) throw new NativeControllerError("conflict");
      this.publish(tx, { selection: null, transition: null });
      return this.observe(tx.current, fresh);
    }
    if (record.selection)
      await this.stopSource(
        tx,
        manager,
        { installed: false, loaded: false, raw: null, definition: null },
        status,
      );
    else if (status.manual.loaded || status.persistent.loaded || status.local.kind !== "absent")
      throw new NativeControllerError("conflict");
    await this.readiness.waitStopped(paths(backup.stateDir).sock);
    this.phase(tx, "source-stopped", { selection: null });
    if (!legacy.installed) await manager.restore(raw);
    const restored = await manager.inspect();
    if (!restored.raw?.equals(raw) || restored.loaded)
      throw new NativeControllerError("operation-failed");
    if (consent.restartPrevious) {
      this.phase(tx, "destination-start-requested");
      const pid = await manager.load();
      await this.readiness.waitReady(paths(backup.stateDir).sock, {
        computerFp: backup.computerFp,
        stateDir: backup.stateDir,
        serviceInstance: restored.definition?.serviceInstance ?? null,
        pid,
      });
      const after = await manager.inspect();
      if (!after.loaded || !after.raw?.equals(raw)) throw new NativeControllerError("conflict");
    }
    this.publish(tx, { selection: null, transition: null });
    return this.observe(tx.current, await manager.inspect());
  }
  private emit(event: NativeEvent) {
    for (const listener of this.listeners) listener(event);
  }
  onEvent(listener: (event: NativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.client?.close();
    this.client = undefined;
    this.listeners.clear();
    await this.desktop.close();
  }
}
