import { isRepositoryInputRejection } from "./storage/input-validation.js";

interface LifecycleOptions {
  report(): void;
  probeStorage(): void;
  recoverComputer(fp: string): Promise<void>;
  recovered(fp: string): void;
}

/** Owns readiness, recovery and asynchronous work across the runtime's shutdown fence. */
export class RelayRuntimeLifecycle {
  private phase: "starting" | "running" | "stopping" | "closed" = "starting";
  private readonly degraded = new Set<string>();
  private failureEpoch = 0;
  private recoveryDelay = 1000;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recovering = false;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly cancellations = new Set<() => void>();

  constructor(private readonly options: LifecycleOptions) {}
  get ready(): boolean {
    return this.phase === "running" && this.degraded.size === 0;
  }
  get stopping(): boolean {
    return this.phase === "stopping" || this.phase === "closed";
  }
  get closed(): boolean {
    return this.phase === "closed";
  }
  started(): void {
    if (this.phase === "starting") this.phase = "running";
  }
  stop(): void {
    if (this.stopping) return;
    this.phase = "stopping";
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.cancelProviders();
  }
  finish(): void {
    this.stop();
    this.phase = "closed";
    this.cancelProviders();
  }
  private cancelProviders(): void {
    for (const cancel of this.cancellations) cancel();
  }
  report(): void {
    if (!this.stopping) this.options.report();
  }
  hasStorageFailure(fp: string): boolean {
    return this.degraded.has(fp);
  }
  storageFailed(fp: string): void {
    if (this.stopping) return;
    this.failureEpoch++;
    this.degraded.add(fp);
    this.armRecovery();
  }
  // Observe persistence failures before core classification or provider orchestration.
  observeStore<T extends object>(fp: string, store: T): T {
    return new Proxy(store, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          try {
            return await Reflect.apply(value, target, args);
          } catch (error) {
            // Only explicitly tagged pure caller validation is a client rejection.
            if (!isRepositoryInputRejection(error)) this.storageFailed(fp);
            throw error;
          }
        };
      },
    });
  }
  track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
    return tracked;
  }
  trackDelivery(task: Promise<void>, holdComputer: () => Promise<void>): void {
    // Security wakeups may join the same delivery; hold its computer exactly once.
    if (this.deliveries.has(task)) return;
    this.deliveries.add(task);
    void holdComputer().finally(() => this.deliveries.delete(task));
  }
  async drain(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
  providerCall<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("Relay closed"));
    let cancel!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Relay shutting down"));
    });
    this.cancellations.add(cancel);
    // Observe the underlying operation even if it outlives shutdown. Its late result
    // cannot reach the notification service after cancellation wins the race.
    return Promise.race([Promise.resolve().then(action), cancellation]).finally(() =>
      this.cancellations.delete(cancel),
    );
  }
  private armRecovery(): void {
    if (this.stopping || this.recovering || this.recoveryTimer || !this.degraded.size) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recovering = true;
      const epoch = this.failureEpoch;
      const task = (async () => {
        this.options.probeStorage();
        for (const fp of [...this.degraded]) {
          if (this.stopping) return;
          await this.options.recoverComputer(fp);
        }
        if (!this.stopping && epoch === this.failureEpoch) {
          const recovered = [...this.degraded];
          this.degraded.clear();
          this.recoveryDelay = 1000;
          for (const fp of recovered) this.options.recovered(fp);
        }
      })()
        .catch(() => this.report())
        .finally(() => {
          this.recovering = false;
          if (this.degraded.size) this.recoveryDelay = Math.min(30_000, this.recoveryDelay * 2);
          this.armRecovery();
        });
      void this.track(task);
    }, this.recoveryDelay);
    this.recoveryTimer.unref();
  }
}
