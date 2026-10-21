import { VtReplayLog, type VtSeed } from "../terminal/vt-replay-log";

export type TerminalReplacement = "herdr-idle" | "snapshots" | "checkpoint-lost" | "legacy";

/** One focused computer/session's memory. It is never persisted or shared with another view. */
export class RetainedTerminal {
  private readonly scope = Object.freeze({});
  private subscription: string | null = null;
  private applied: ((log: VtReplayLog) => void) | null = null;
  private current: VtReplayLog | null = null;
  private ended = false;
  rendererBlocked = false;
  notice?: TerminalReplacement;

  constructor(
    readonly computer: string,
    readonly session: string,
  ) {}

  get log(): VtReplayLog | null {
    return this.current;
  }
  get isEnded(): boolean {
    return this.ended;
  }
  bind(subscription: string, applied: (log: VtReplayLog) => void): boolean {
    if (this.ended) return false;
    this.subscription = subscription;
    this.applied = applied;
    return true;
  }
  isBound(subscription: string): boolean {
    return !this.ended && this.subscription === subscription;
  }
  owns(subscription: string, log: VtReplayLog | null = this.current): log is VtReplayLog {
    return this.contains(subscription, log) && log.owner?.subscriptionId === subscription;
  }
  /** Renderer lifetime spans subscriptions; only wire progress belongs to its installing one. */
  contains(subscription: string, log: VtReplayLog | null = this.current): log is VtReplayLog {
    return (
      !this.ended &&
      this.subscription === subscription &&
      log !== null &&
      log === this.current &&
      !log.isDisposed &&
      log.owner?.scope === this.scope
    );
  }
  install(subscription: string, meta: VtSeed, bytes: Uint8Array): VtReplayLog | null {
    if (this.ended || this.subscription !== subscription) return null;
    // Release the old allocation before reserving history/seed space for its replacement.
    this.current?.dispose();
    this.current = new VtReplayLog(meta, bytes, {
      scope: this.scope,
      subscriptionId: subscription,
      onApplied: (log) => {
        if (this.subscription && this.contains(this.subscription, log)) this.applied?.(log);
      },
    });
    if (meta.disposition === "replace") this.notice = "herdr-idle";
    return this.current;
  }
  clear(notice?: TerminalReplacement): void {
    this.current?.dispose();
    this.current = null;
    this.rendererBlocked = false;
    if (notice) this.notice = notice;
  }
  detach(subscription: string, retain: boolean): void {
    if (this.subscription !== subscription) return;
    this.subscription = null;
    this.applied = null;
    if (!retain) this.clear();
  }
  end(): void {
    this.ended = true;
    this.subscription = null;
    this.applied = null;
    this.clear();
  }
}
