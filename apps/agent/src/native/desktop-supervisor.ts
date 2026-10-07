import { type ChildProcess, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";
import { paths } from "../config.js";
import { ServiceReadiness } from "../service-readiness.js";
import { inspectBundleRuntime } from "./bundle-runtime.js";
import {
  NativeControllerError,
  type NativeExpected,
  type NativeJob,
  type NativeSelection,
  NativeSelectionSchema,
} from "./protocol.js";
import { sanitizeNativeEnvironment } from "./service-entry.js";

interface OwnedChild {
  child: ChildProcess;
  pipe: Writable;
  selection: NativeSelection;
  exited: boolean;
  stopping?: Promise<void>;
}
export class DesktopSupervisor {
  private owned?: OwnedChild;
  private starting?: Promise<NativeJob>;
  private closed = false;
  private readonly readiness: ServiceReadiness;
  private readonly clock;
  constructor(
    private readonly options: {
      uid: number;
      homeDir: string;
      admitBundle?: typeof inspectBundleRuntime;
      readiness?: ServiceReadiness;
      clock?: { now(): number; sleep(ms: number): Promise<void> };
      stopTimeoutMs?: number;
    },
  ) {
    this.readiness = options.readiness ?? new ServiceReadiness();
    this.clock = options.clock ?? {
      now: () => performance.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
  }
  async inspect(selection: NativeSelection): Promise<NativeJob> {
    if (this.owned?.exited) await this.stopOwned(this.owned);
    const owned = this.owned;
    if (
      owned &&
      (owned.selection.serviceInstance !== selection.serviceInstance ||
        owned.selection.bundlePath !== selection.bundlePath)
    )
      throw new NativeControllerError("conflict");
    return {
      registration: "not-registered",
      loaded: !!owned && !owned.exited,
      pid: owned && !owned.exited ? (owned.child.pid ?? null) : null,
      bundlePath: selection.bundlePath,
    };
  }
  start(selection: NativeSelection): Promise<NativeJob> {
    if (this.closed || this.starting || (this.owned && !this.owned.exited))
      return Promise.reject(new NativeControllerError("busy"));
    if (!NativeSelectionSchema.safeParse(selection).success || selection.mode !== "desktop")
      return Promise.reject(new NativeControllerError("conflict"));
    this.starting = this.launch(structuredClone(selection)).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async launch(selection: NativeSelection): Promise<NativeJob> {
    if (this.owned) await this.stopOwned(this.owned);
    const runtime = await (this.options.admitBundle ?? inspectBundleRuntime)(selection.bundlePath);
    if (runtime.agentVersion !== selection.agentVersion || this.closed)
      throw new NativeControllerError("conflict");
    const before = await this.readiness.observe(paths(selection.stateDir).sock);
    if (before.kind !== "absent" || this.closed) throw new NativeControllerError("conflict");
    const child = spawn(runtime.nodePath, [runtime.servicePath, "desktop"], {
      cwd: this.options.homeDir,
      env: sanitizeNativeEnvironment(selection, this.options.homeDir, process.env),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const owned: OwnedChild = { child, pipe: child.stdio[3] as Writable, selection, exited: false };
    this.owned = owned;
    child.once("exit", () => {
      owned.exited = true;
    });
    child.once("error", () => {
      owned.exited = true;
    });
    // Drain without retaining or forwarding child output/terminal content.
    child.stdout?.resume();
    child.stderr?.resume();
    owned.pipe.on("error", () => {});
    try {
      owned.pipe.write(`${JSON.stringify({ v: 1, instance: selection.serviceInstance })}\n`);
      const deadline = this.clock.now() + 10000;
      while (this.clock.now() < deadline) {
        if (owned.exited || this.closed || !child.pid)
          throw new NativeControllerError("unavailable");
        const observed = await this.readiness.observe(
          paths(selection.stateDir).sock,
          {
            stateDir: selection.stateDir,
            computerFp: selection.computerFp,
            serviceInstance: selection.serviceInstance,
            pid: child.pid,
          },
          Math.min(500, deadline - this.clock.now()),
        );
        if (
          observed.kind === "verified" &&
          observed.local?.process.agentVersion === selection.agentVersion &&
          !owned.exited &&
          !this.closed
        )
          return this.inspect(selection);
        if (observed.kind === "foreign") throw new NativeControllerError("conflict");
        await this.clock.sleep(Math.min(25, Math.max(0, deadline - this.clock.now())));
      }
      throw new NativeControllerError("unavailable");
    } catch (error) {
      await this.stopOwned(owned);
      throw error;
    }
  }
  async stop(expect: NativeExpected): Promise<void> {
    const owned = this.owned;
    if (!owned) {
      if (expect.runtime) throw new NativeControllerError("conflict");
      return;
    }
    const runtime = expect.runtime,
      selection = owned.selection;
    if (
      !runtime ||
      runtime.pid !== owned.child.pid ||
      runtime.stateDir !== selection.stateDir ||
      runtime.computerFp !== selection.computerFp ||
      runtime.serviceInstance !== selection.serviceInstance ||
      runtime.agentVersion !== selection.agentVersion
    )
      throw new NativeControllerError("conflict");
    await this.stopOwned(owned);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.owned) await this.stopOwned(this.owned);
    await this.starting?.catch(() => {});
    if (this.owned) await this.stopOwned(this.owned);
  }
  private stopOwned(owned: OwnedChild): Promise<void> {
    if (owned.stopping) return owned.stopping;
    owned.stopping = this.finishStop(owned).finally(() => {
      owned.stopping = undefined;
    });
    return owned.stopping;
  }
  private async finishStop(owned: OwnedChild): Promise<void> {
    owned.pipe.end();
    const budget = this.options.stopTimeoutMs ?? 10000;
    const deadline = this.clock.now() + budget,
      escalation = deadline - budget / 2;
    let signalled = false;
    while (!owned.exited && this.clock.now() < deadline) {
      if (!signalled && this.clock.now() >= escalation) {
        const selected = owned.selection;
        const observed = await this.readiness.observe(
          paths(selected.stateDir).sock,
          {
            pid: owned.child.pid,
            stateDir: selected.stateDir,
            computerFp: selected.computerFp,
            serviceInstance: selected.serviceInstance,
          },
          Math.min(500, Math.max(1, deadline - this.clock.now())),
        );
        if (observed.kind === "foreign") throw new NativeControllerError("conflict");
        if (
          observed.kind === "verified" &&
          observed.local?.process.agentVersion === selected.agentVersion &&
          this.owned === owned &&
          !owned.exited
        ) {
          owned.child.kill("SIGTERM");
          signalled = true;
        }
      }
      await this.clock.sleep(Math.min(25, Math.max(0, deadline - this.clock.now())));
    }
    if (!owned.exited) throw new NativeControllerError("unavailable");
    const endpoint = await this.readiness.observe(paths(owned.selection.stateDir).sock);
    if (endpoint.kind !== "absent") throw new NativeControllerError("conflict");
    owned.pipe.destroy();
    if (this.owned === owned) this.owned = undefined;
  }
}
