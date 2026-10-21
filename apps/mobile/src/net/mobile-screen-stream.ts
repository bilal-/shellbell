import {
  acceptsContinuation,
  applyStreamScreen,
  CONTINUATION_EXTENSIONS,
  decodeStreamHistory,
  decodeStreamScreen,
  type ScreenSnapshot,
  SidSchema,
  STREAM_LIMITS,
  StreamIdSchema,
  type StreamMessage,
  StreamMessageSchema,
  StreamReceiver,
  type StreamTransferMeta,
} from "@shellbell/protocol";
import {
  BoundedHistoryWindow,
  type HistoryAnchor,
  type HistoryWindowSnapshot,
} from "../store/bounded-history";

import { VtReplayLog } from "../terminal/vt-replay-log";
import type { VtRenderError } from "../terminal/vt-wire";
import type { RetainedTerminal, TerminalReplacement } from "./retained-terminal";

export type TerminalOutputState = "live" | "catching-up" | "paused" | "ended";
export interface TerminalOutput {
  readonly state: TerminalOutputState;
  readonly reason?: MobileStreamError | "source" | "applying" | "renderer" | "route";
  readonly replacement?: TerminalReplacement;
}
const SOURCE_PAUSE_MS = 10_000;
const SOURCE_REFRESH_MS = 20_000;
const APPLIED_REPORT_MS = 50;

export type MobileStreamError =
  | "stalled"
  | "invalid-transfer"
  | "screen-too-large"
  | "unsupported"
  | "session-gone";
export type MobileHistoryStatus =
  | "waiting"
  | "ready"
  | "loading"
  | "unavailable"
  | "limited"
  | "oversized"
  | "end"
  | "truncated"
  | "reset";
/** Loading may retain another page request; UI callers suppress duplicate presses separately. */
export function historyAcceptsOlder(status: MobileHistoryStatus): boolean {
  return (
    status === "waiting" || status === "ready" || status === "loading" || status === "unavailable"
  );
}

/** Most raw bytes kept after one starting point; past it the phone asks for a fresh one. */
export const VT_LOG_BYTES = 4 * 1024 * 1024;

/**
 * A raw terminal stream since its latest starting point: the bytes that recreate the terminal,
 * then everything it wrote after. Append-only, so a terminal view that mounts later (or reloads)
 * replays it from the start and stays in step with one that was there all along.
 */
export class VtLog {
  readonly chunks: Uint8Array[] = [];
  private size = 0;
  constructor(
    readonly generation: number,
    readonly cols: number,
    readonly rows: number,
    readonly seed: Uint8Array,
  ) {}
  get bytes(): number {
    return this.size;
  }
  append(data: Uint8Array): boolean {
    if (this.size + data.length > VT_LOG_BYTES) return false;
    this.chunks.push(data);
    this.size += data.length;
    return true;
  }
}

export interface MobileStreamSnapshot {
  readonly status: "idle" | "loading" | "live" | "closed";
  /** Present while the computer streams the terminal's own bytes instead of snapshots. */
  readonly vt?: { readonly log: VtLog | VtReplayLog; readonly length: number };
  readonly continuation?: boolean;
  readonly output?: TerminalOutput;
  readonly error?: MobileStreamError;
  readonly screen?: Readonly<ScreenSnapshot>;
  readonly history?: HistoryWindowSnapshot;
  readonly historyStatus: MobileHistoryStatus;
  /** A fresh capture is replacing retained rows; a temporary failure remains retryable. */
  readonly historyRefreshPending?: boolean;
}
export interface MobileScreenStreamOptions {
  subscriptionId: string;
  sessionId: string;
  now: () => number;
  sendControl: (message: StreamMessage) => boolean;
  retainedHistory?: BoundedHistoryWindow;
  refreshHistory?: boolean;
  /** Ask for the terminal's own bytes; a computer that cannot stream them sends snapshots. */
  vt?: boolean;
  /** One focused computer/session owner, retained only across its safe reconnects. */
  terminal?: RetainedTerminal;
  /** Parser progress arrives independently of incoming transport records. */
  onChange?: () => void;
}

interface Baseline {
  readonly anchor: HistoryAnchor;
  readonly sequence: number;
  acknowledged: boolean;
}

interface PendingHistory {
  readonly requestId: string;
  readonly generation: number;
  readonly before: number;
  firstDeadline: number | null;
  completionSequence: number | null;
}

type SendResult = "admitted" | "refused" | "unknown";

function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Timer-free owner for one bounded subscription; the connection manager drives its clock. */
export class MobileScreenStream {
  private readonly subscriptionId: string;
  private readonly sessionId: string;
  private readonly nowSource: () => number;
  private readonly sendControl: (message: StreamMessage) => boolean;
  private readonly explicitRefresh: boolean;
  private receiver: StreamReceiver | null = null;
  private current: MobileStreamSnapshot;
  private window: BoundedHistoryWindow | undefined;
  private lastNow: number | null = null;
  private firstScreenDeadline: number | null = null;
  private recoveryDeadline: number | null = null;
  private recoveryRequested = false;
  private refreshIntent = false;
  private intent = false;
  private baseline: Baseline | null = null;
  private pending: PendingHistory | null = null;
  private requestCounter = 0;
  private skippedRefreshRows = 0;
  private refreshReplaced = false;
  private oversizedBefore: number | null = null;
  private processing = false;
  private draining = false;
  private acceptingSequence: number | null = null;
  private epoch = 0;
  private cancelSent = false;
  private readonly vt: boolean;
  private vtLog: VtLog | VtReplayLog | null = null;
  private readonly terminal?: RetainedTerminal;
  private readonly changed: () => void;
  private readonly requestedExtensions: readonly string[];
  private acceptedExtensions: readonly string[] | null = null;
  private negotiated = false;
  private receivedChunk = false;
  private advertisedRetained = false;
  private lastHealthyAt = 0;
  private lastAppliedAt = 0;
  private sourceStatus: Extract<StreamMessage, { type: "stream.status" }> | null = null;
  private reportAt: number | null = null;
  private waitingForRestore = false;
  private routePaused = false;
  /** Bytes after the starting point; a gap or an oversized log asks for a fresh one. */
  private vtOffset = 0;
  private vtStale = false;

  constructor(options: MobileScreenStreamOptions) {
    try {
      const subscriptionId = options.subscriptionId;
      const sessionId = options.sessionId;
      const now = options.now;
      const sendControl = options.sendControl;
      const retainedHistory = options.retainedHistory;
      const refreshHistory = options.refreshHistory;
      if (
        !StreamIdSchema.safeParse(subscriptionId).success ||
        !SidSchema.safeParse(sessionId).success ||
        typeof now !== "function" ||
        typeof sendControl !== "function" ||
        (retainedHistory !== undefined &&
          (!(retainedHistory instanceof BoundedHistoryWindow) ||
            retainedHistory.snapshot.anchor.subscriptionId === subscriptionId))
      ) {
        throw new TypeError("Invalid mobile stream options");
      }
      this.subscriptionId = subscriptionId;
      this.sessionId = sessionId;
      this.nowSource = now;
      this.sendControl = sendControl;
      // An empty cache has no reading position to preserve across subscriptions.
      // Keep explicit gaps (skipped oversized rows) even when no rows were retained.
      this.window =
        retainedHistory &&
        (retainedHistory.snapshot.rows.length > 0 || retainedHistory.snapshot.gaps.length > 0)
          ? retainedHistory
          : undefined;
      this.explicitRefresh = refreshHistory === true;
      this.vt = options.vt === true;
      this.terminal = options.terminal;
      if (this.terminal && this.terminal.session !== sessionId)
        throw new TypeError("Wrong terminal owner");
      this.changed = options.onChange ?? (() => {});
      this.requestedExtensions = this.vt && this.terminal ? CONTINUATION_EXTENSIONS : [];
      this.vtLog = this.vt ? (this.terminal?.log ?? null) : null;
      this.current = Object.freeze({
        status: "idle",
        historyStatus: "waiting",
        ...(this.terminal ? { output: { state: "catching-up" as const } } : {}),
        ...(this.vtLog
          ? {
              vt: {
                log: this.vtLog,
                length: this.vtLog.receivedOffset,
              },
            }
          : {}),
        ...(this.window ? { history: this.window.snapshot } : {}),
      });
    } catch {
      throw new TypeError("Invalid mobile stream options");
    }
  }

  get snapshot(): MobileStreamSnapshot {
    return this.current;
  }

  get historyWindow(): BoundedHistoryWindow | undefined {
    return this.window;
  }
  get awaitingMaterialization(): boolean {
    return this.waitingForRestore;
  }

  private isClosed(): boolean {
    return this.current.status === "closed";
  }

  start(): boolean {
    if (this.isClosed()) return false;
    if (this.current.status !== "idle") return true;
    const now = this.sampleNow();
    if (now === null || this.isClosed()) return false;
    if (this.terminal && !this.terminal.bind(this.subscriptionId, (log) => this.applied(log))) {
      this.close("session-gone");
      return false;
    }
    this.advertisedRetained = this.vt && this.terminal?.log?.hasRetained === true;
    this.lastHealthyAt = this.lastAppliedAt = now;
    this.receiver = new StreamReceiver({
      subscriptionId: this.subscriptionId,
      sessionId: this.sessionId,
      now: () => this.receiverNow(),
      accept: (meta, bytes) => this.accept(meta, bytes),
      acknowledge: (through) => this.acknowledge(through),
    });
    this.firstScreenDeadline = now + STREAM_LIMITS.progressMs;
    if (this.explicitRefresh) this.intent = true;
    this.publish({ status: "loading" });
    if (this.isClosed()) return false;
    const epoch = this.epoch;
    const result = this.send({
      type: "stream.subscribe",
      subscriptionId: this.subscriptionId,
      sessionId: this.sessionId,
      ...(this.vt ? { mode: "vt" as const } : {}),
      ...(this.requestedExtensions.length
        ? {
            extensions: [...this.requestedExtensions],
            retained: this.advertisedRetained,
          }
        : {}),
    });
    if (this.epoch !== epoch) return false;
    if (result !== "admitted") {
      this.close(result === "refused" ? "stalled" : "invalid-transfer");
      return false;
    }
    return true;
  }

  receive(message: StreamMessage, envelopeBytes: number): void {
    if (this.current.status === "closed" || this.current.status === "idle") return;
    if (this.terminal && !this.terminal.isBound(this.subscriptionId)) return;
    if (this.processing) {
      this.close("invalid-transfer");
      return;
    }
    this.processing = true;
    try {
      const now = this.sampleNow();
      if (now === null || this.isClosed()) return;
      if (
        (this.firstScreenDeadline !== null && now >= this.firstScreenDeadline) ||
        (this.recoveryDeadline !== null && now >= this.recoveryDeadline)
      ) {
        this.close("stalled");
        return;
      }
      if (
        this.pending?.firstDeadline !== null &&
        this.pending &&
        now >= this.pending.firstDeadline
      ) {
        this.pending = null;
        this.intent = false;
        this.publish({ historyStatus: "unavailable" });
        if (this.isClosed()) return;
      }
      let parsed: ReturnType<typeof StreamMessageSchema.safeParse>;
      try {
        parsed = StreamMessageSchema.safeParse(message);
      } catch {
        this.close("invalid-transfer");
        return;
      }
      if (!parsed.success) {
        this.close("invalid-transfer");
        return;
      }
      const incoming = parsed.data;
      if (incoming.subscriptionId !== this.subscriptionId) return;
      if (incoming.type === "stream.chunk" && incoming.sessionId !== this.sessionId) return;
      if (
        !Number.isSafeInteger(envelopeBytes) ||
        envelopeBytes < 1 ||
        envelopeBytes > STREAM_LIMITS.envelopeBytes
      ) {
        this.close("invalid-transfer");
        return;
      }
      if (incoming.type === "stream.accepted") {
        if (
          !this.requestedExtensions.length ||
          incoming.extensions.some((name) => !this.requestedExtensions.includes(name))
        ) {
          this.close("invalid-transfer");
          return;
        }
        if (this.acceptedExtensions) {
          if (JSON.stringify(this.acceptedExtensions) !== JSON.stringify(incoming.extensions))
            this.close("invalid-transfer");
          return;
        }
        if (this.receivedChunk) {
          this.close("invalid-transfer");
          return;
        }
        this.acceptedExtensions = incoming.extensions;
        this.negotiated = acceptsContinuation(this.requestedExtensions, incoming.extensions);
        this.publish({ continuation: this.negotiated });
        return;
      }
      if (incoming.type === "stream.status") {
        if (!this.negotiated) {
          this.close("invalid-transfer");
          return;
        }
        const log = this.vtLog;
        if (
          !(log instanceof VtReplayLog) ||
          !this.terminal?.owns(this.subscriptionId, log) ||
          incoming.capture !== log.meta.capture ||
          incoming.generation !== log.generation
        )
          return;
        if (
          incoming.offset < log.receivedOffset ||
          incoming.offset < (this.sourceStatus?.offset ?? 0)
        )
          return;
        this.sourceStatus = incoming;
        if (incoming.state === "quiescent" && incoming.offset === log.receivedOffset)
          this.lastHealthyAt = now;
        this.publish({});
        return;
      }
      if (incoming.type === "stream.error") {
        this.receiveError(incoming);
        return;
      }
      if (incoming.type !== "stream.chunk") {
        this.close("invalid-transfer");
        return;
      }
      this.receivedChunk = true;
      this.acceptingSequence = incoming.sequence;
      const result = this.receiver?.receive(incoming, envelopeBytes);
      this.acceptingSequence = null;
      if (result === "invalid") this.close("invalid-transfer");
      else if (result === "stalled") this.close("stalled");
      else if (result === "accepted" && !this.isClosed()) {
        if (incoming.meta.kind !== "history") this.firstScreenDeadline = null;
        // The first chunk of the answer ends the wait for one; the receiver's own progress and
        // total deadlines cover the rest of a transfer that spans several chunks.
        if (
          this.recoveryRequested &&
          ((incoming.meta.kind === "snapshot" &&
            incoming.meta.generation >= (this.current.screen?.gen ?? 0)) ||
            ((incoming.meta.kind === "vt-state" || incoming.meta.kind === "vt-seed") &&
              incoming.meta.generation > (this.vtLog?.generation ?? 0)))
        ) {
          this.recoveryDeadline = null;
        }
        const pending = this.pending;
        if (
          pending &&
          incoming.meta.kind === "history" &&
          incoming.meta.requestId === pending.requestId &&
          incoming.meta.before === pending.before &&
          incoming.meta.generation === pending.generation
        ) {
          pending.firstDeadline = null;
        }
      }
    } catch {
      this.close("invalid-transfer");
    } finally {
      this.acceptingSequence = null;
      this.processing = false;
      this.drain();
    }
  }

  requestOlder(): boolean {
    if (
      this.current.status === "idle" ||
      this.current.status === "closed" ||
      !historyAcceptsOlder(this.current.historyStatus) ||
      (this.window && !this.explicitRefresh && this.window.snapshot.readOnly)
    ) {
      return false;
    }
    this.intent = true;
    if (!this.processing) this.drain();
    return true;
  }

  skipOversized(): boolean {
    if (
      this.current.status === "closed" ||
      this.current.historyStatus !== "oversized" ||
      this.pending !== null ||
      this.oversizedBefore === null ||
      this.oversizedBefore === 0
    ) {
      return false;
    }
    const before = this.oversizedBefore;
    if (
      this.explicitRefresh &&
      this.window &&
      !this.refreshReplaced &&
      this.window.snapshot.anchor.subscriptionId !== this.subscriptionId
    ) {
      this.skippedRefreshRows++;
    } else if (!this.window?.skip(this.subscriptionId, before)) {
      return false;
    }
    this.oversizedBefore = null;
    this.publish({ historyStatus: "ready" });
    return true;
  }

  protectHistory(key: string | null): boolean {
    if (!this.window?.protect(key)) return false;
    return true;
  }

  tick(): void {
    if (this.current.status === "closed" || this.current.status === "idle") return;
    if (this.processing) {
      this.close("invalid-transfer");
      return;
    }
    this.processing = true;
    try {
      const now = this.sampleNow();
      if (now === null || this.isClosed()) return;
      const receiverState = this.receiver?.tick();
      if (receiverState === "stalled") {
        this.close("stalled");
        return;
      }
      if (
        (this.firstScreenDeadline !== null && now >= this.firstScreenDeadline) ||
        (this.recoveryDeadline !== null && now >= this.recoveryDeadline)
      ) {
        this.close("stalled");
        return;
      }
      const stalledAt = this.progressDeadline();
      if (stalledAt !== null && now >= stalledAt + SOURCE_REFRESH_MS && !this.recoveryRequested)
        this.refreshIntent = true;
      this.flushApplied(now);
      if (!this.isClosed()) this.publish({});
      if (
        this.pending?.firstDeadline !== null &&
        this.pending &&
        now >= this.pending.firstDeadline
      ) {
        this.pending = null;
        this.intent = false;
        this.publish({ historyStatus: "unavailable" });
      }
    } catch {
      this.close("invalid-transfer");
    } finally {
      this.processing = false;
      this.drain();
    }
  }

  nextDeadline(): number | null {
    if (this.current.status === "closed" || this.current.status === "idle") return null;
    const candidates = [
      this.receiver?.nextDeadline(),
      this.firstScreenDeadline,
      this.recoveryDeadline,
      this.pending?.firstDeadline,
      this.reportAt,
      this.nextProgressDeadline(),
      this.intent &&
      this.baseline?.acknowledged &&
      !this.pending &&
      !this.processing &&
      !this.draining
        ? this.lastNow
        : null,
    ].filter((value): value is number => value !== null && value !== undefined);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  cancel(retainTerminal = false): void {
    this.close();
    this.terminal?.detach(this.subscriptionId, retainTerminal);
  }

  end(): void {
    this.close("session-gone");
  }

  pauseForRoute(): void {
    this.routePaused = true;
    this.publish({});
  }

  rendererError(log: VtReplayLog, reason: VtRenderError): boolean {
    if (!this.terminal?.contains(this.subscriptionId, log)) return false;
    if (reason === "checkpoint-missing") {
      this.terminal.clear("checkpoint-lost");
      this.vtLog = null;
      this.publish({ vt: undefined });
      return true;
    }
    if (reason === "invalid-transfer") {
      this.terminal.clear("checkpoint-lost");
      this.vtLog = null;
      if (this.isClosed()) this.publish({ error: "invalid-transfer", vt: undefined });
      else this.close("invalid-transfer");
      return false;
    }
    this.terminal.rendererBlocked = true;
    this.publish({});
    return false;
  }

  rendererReady(log: VtReplayLog): void {
    if (!this.terminal?.contains(this.subscriptionId, log)) return;
    this.terminal.rendererBlocked = false;
    this.applied(log);
  }

  private applied(log: VtReplayLog): void {
    if (!this.terminal?.contains(this.subscriptionId, log)) return;
    const now = this.sampleNow();
    if (now === null) return;
    this.lastAppliedAt = now;
    if (
      !this.isClosed() &&
      this.terminal.owns(this.subscriptionId, log) &&
      log.pendingApplied &&
      this.reportAt === null
    )
      this.reportAt = now + APPLIED_REPORT_MS;
    this.publish({});
    // A native parser callback must never be invalidated by a presentation listener.
    try {
      this.changed();
    } catch {
      /* the next owner tick still sees committed progress */
    }
  }

  private flushApplied(now: number): void {
    if (this.reportAt === null || now < this.reportAt) return;
    const log = this.vtLog;
    const progress =
      log instanceof VtReplayLog && this.terminal?.owns(this.subscriptionId, log)
        ? log.pendingApplied
        : null;
    this.reportAt = null;
    if (!progress || !(log instanceof VtReplayLog)) return;
    const epoch = this.epoch;
    const outcome = this.send({
      type: "stream.applied",
      subscriptionId: this.subscriptionId,
      ...progress,
    });
    if (this.isClosed() || this.epoch !== epoch || this.vtLog !== log) return;
    if (outcome === "admitted") log.didReport(progress.offset);
    else if (outcome === "unknown") this.close("invalid-transfer");
    if (!this.isClosed() && log.pendingApplied) this.reportAt = now + 250;
  }

  private progressDeadline(): number | null {
    if (
      !this.negotiated ||
      this.current.status !== "live" ||
      this.terminal?.rendererBlocked ||
      this.routePaused ||
      this.recoveryRequested
    )
      return null;
    const log = this.vtLog;
    if (!(log instanceof VtReplayLog) || !this.terminal?.owns(this.subscriptionId, log))
      return null;
    return log.renderedOffset < log.receivedOffset
      ? Math.min(this.lastHealthyAt, this.lastAppliedAt)
      : this.lastHealthyAt;
  }

  private nextProgressDeadline(): number | null {
    const start = this.progressDeadline();
    if (start === null) return null;
    return (
      start + ((this.lastNow ?? 0) < start + SOURCE_PAUSE_MS ? SOURCE_PAUSE_MS : SOURCE_REFRESH_MS)
    );
  }

  private output(snapshot: MobileStreamSnapshot): TerminalOutput {
    const replacement = this.terminal?.notice;
    const state = (
      value: TerminalOutputState,
      reason?: TerminalOutput["reason"],
    ): TerminalOutput => ({
      state: value,
      ...(reason ? { reason } : {}),
      ...(replacement ? { replacement } : {}),
    });
    if (snapshot.error === "session-gone" || this.terminal?.isEnded) return state("ended");
    if (this.terminal?.rendererBlocked) return state("paused", "renderer");
    if (snapshot.status === "closed")
      return state("paused", this.waitingForRestore ? "applying" : (snapshot.error ?? "stalled"));
    if (this.routePaused) return state("paused", "route");
    if (snapshot.status !== "live") return state("catching-up");
    const log = this.vtLog;
    if (!this.negotiated || !(log instanceof VtReplayLog)) return state("live");
    if (!this.terminal?.owns(this.subscriptionId, log)) return state("catching-up");
    const now = this.lastNow ?? 0;
    if (this.sourceStatus?.state === "paused" || now >= this.lastHealthyAt + SOURCE_PAUSE_MS)
      return state("paused", "source");
    if (log.renderedOffset < log.receivedOffset) {
      return state("catching-up");
    }
    if (
      this.sourceStatus?.state === "catching-up" ||
      (this.sourceStatus?.offset ?? 0) > log.renderedOffset
    )
      return state("catching-up");
    return state("live");
  }

  private sampleNow(): number | null {
    let raw: number;
    try {
      raw = this.nowSource();
    } catch {
      this.close("invalid-transfer");
      return null;
    }
    if (!Number.isFinite(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER - 21000) {
      this.close("invalid-transfer");
      return null;
    }
    const now = Math.max(this.lastNow ?? raw, raw);
    this.lastNow = now;
    return now;
  }

  private receiverNow(): number {
    const epoch = this.epoch;
    const now = this.sampleNow();
    if (now === null || this.epoch !== epoch || this.isClosed()) {
      throw new Error("Invalid stream clock");
    }
    return now;
  }

  private publish(change: Partial<MobileStreamSnapshot>): void {
    this.current = Object.freeze({
      ...this.current,
      ...change,
      ...(this.terminal ? { output: this.output({ ...this.current, ...change }) } : {}),
      historyRefreshPending:
        this.explicitRefresh &&
        !this.refreshReplaced &&
        this.window !== undefined &&
        this.window.snapshot.anchor.subscriptionId !== this.subscriptionId,
      ...(this.window ? { history: this.window.snapshot } : {}),
    });
  }

  private containThenable(result: unknown): void {
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      try {
        Promise.resolve(result).then(undefined, () => {});
      } catch {
        // A hostile thenable is an ignored control-sink failure.
      }
    }
  }

  private send(message: StreamMessage): SendResult {
    let result: unknown;
    try {
      result = this.sendControl(message);
    } catch {
      return "unknown";
    }
    if (result === true) return "admitted";
    if (result === false) return "refused";
    // A control sink declared synchronous must not leave a rejected Promise unobserved.
    this.containThenable(result);
    return "unknown";
  }

  private close(error?: MobileStreamError): void {
    if (this.current.status === "closed") return;
    this.epoch++;
    this.receiver?.cancel();
    this.firstScreenDeadline = null;
    this.recoveryDeadline = null;
    this.recoveryRequested = false;
    this.refreshIntent = false;
    this.pending = null;
    this.intent = false;
    this.oversizedBefore = null;
    this.window?.detach();
    this.reportAt = null;
    if (error === "session-gone") {
      this.terminal?.end();
      this.vtLog = null;
      this.window = undefined;
    }
    this.publish({
      status: "closed",
      ...(error === "session-gone" ? { vt: undefined, screen: undefined, history: undefined } : {}),
      historyStatus: "reset",
      ...(error ? { error } : {}),
    });
    if (!this.cancelSent) {
      this.cancelSent = true;
      this.send({ type: "stream.cancel", subscriptionId: this.subscriptionId });
    }
  }

  private acknowledge(through: number): boolean {
    const epoch = this.epoch;
    const outcome = this.send({ type: "stream.ack", subscriptionId: this.subscriptionId, through });
    if (this.epoch !== epoch || this.isClosed()) return false;
    if (outcome !== "admitted") {
      this.close(outcome === "refused" ? "stalled" : "invalid-transfer");
      return false;
    }
    const baseline = this.baseline;
    if (baseline && !baseline.acknowledged && through >= baseline.sequence) {
      baseline.acknowledged = true;
      if (!this.window) this.window = new BoundedHistoryWindow(baseline.anchor);
      if (
        this.window.snapshot.anchor.subscriptionId !== this.subscriptionId &&
        !this.explicitRefresh
      ) {
        this.intent = false;
        this.publish({ historyStatus: "reset" });
      } else {
        this.publish({ historyStatus: "ready" });
      }
    }
    const pending = this.pending;
    if (pending?.completionSequence !== null && pending && through >= pending.completionSequence) {
      this.pending = null;
    }
    return !this.isClosed();
  }

  private accept(meta: StreamTransferMeta, bytes: Uint8Array): void {
    if (this.current.status === "closed") return;
    if (meta.kind === "history") this.acceptHistory(meta, bytes);
    else if (meta.kind === "vt-state" || meta.kind === "vt-seed" || meta.kind === "vt")
      this.acceptVt(meta, bytes);
    else this.acceptScreen(meta, bytes);
  }

  private acceptScreen(meta: StreamTransferMeta, bytes: Uint8Array): void {
    if (this.negotiated) throw new Error("Snapshot after raw continuation acceptance");
    const record = decodeStreamScreen(meta, bytes);
    if (record.kind === "snapshot" && this.vtLog) {
      this.terminal?.clear("snapshots");
      this.vtLog = null;
      this.publish({ vt: undefined });
    }
    const previous = this.current.screen;
    if (record.kind === "diff" && previous && record.gen <= previous.gen) return;
    if (record.kind === "snapshot" && previous) {
      if (record.gen < previous.gen || (record.gen === previous.gen && !this.recoveryRequested)) {
        return;
      }
    }
    const applied = applyStreamScreen(previous, record);
    if (!applied.ok) {
      if (applied.code === "missing-baseline") {
        if (!this.recoveryRequested) this.refreshIntent = true;
        return;
      }
      throw new Error("Invalid screen transfer");
    }
    const first = this.baseline === null;
    if (first) {
      if (this.acceptingSequence === null) throw new Error("Missing screen sequence");
      this.baseline = {
        anchor: {
          subscriptionId: this.subscriptionId,
          generation: applied.screen.gen,
          before: applied.screen.scrollbackTotal,
        },
        sequence: this.acceptingSequence,
        acknowledged: false,
      };
    }
    if (record.kind === "snapshot" && this.recoveryRequested) {
      this.recoveryRequested = false;
      this.recoveryDeadline = null;
      this.refreshIntent = false;
    }
    if (record.kind === "snapshot" && record.reset === true && !first) {
      this.window?.detach();
      this.pending = null;
      this.intent = false;
      this.oversizedBefore = null;
      this.publish({
        status: "live",
        screen: freezeOwned(applied.screen),
        historyStatus: "reset",
      });
    } else {
      this.publish({ status: "live", screen: freezeOwned(applied.screen) });
    }
  }

  private acceptVt(
    meta: Extract<StreamTransferMeta, { kind: "vt-state" | "vt-seed" | "vt" }>,
    bytes: Uint8Array,
  ): void {
    if (!this.vt) throw new Error("Unrequested terminal stream");
    const now = this.lastNow!;
    if (meta.kind === "vt-seed") {
      if (!this.negotiated || !this.terminal) throw new Error("Unnegotiated terminal seed");
      const previous = this.vtLog;
      const current =
        previous instanceof VtReplayLog && this.terminal.owns(this.subscriptionId, previous);
      if (current && meta.generation <= previous.generation) return;
      if ((current || this.advertisedRetained) && meta.disposition === "initial")
        throw new Error("Unexpected empty-buffer seed");
      if (!current && !this.advertisedRetained && meta.disposition !== "initial")
        throw new Error("Missing retained terminal");
      if (meta.disposition === "replace" && meta.reason !== "herdr-idle")
        throw new Error("Unqualified terminal replacement");
      if (
        previous instanceof VtReplayLog &&
        (this.terminal.rendererBlocked ||
          !previous.hasRetained ||
          previous.isRestoring ||
          (!current && !this.advertisedRetained))
      ) {
        // Do not replace the only native copy while its renderer cannot capture it.
        // Cancel this seed promptly; retry after materialization advertises the checkpoint.
        this.waitingForRestore = true;
        this.close("stalled");
        return;
      }
      const log = this.terminal.install(this.subscriptionId, meta, bytes);
      if (!log) throw new Error("Obsolete terminal owner");
      this.vtLog = log;
      this.lastAppliedAt = now;
      this.reportAt = null;
    } else if (meta.kind === "vt-state") {
      if (this.negotiated) throw new Error("Legacy seed after continuation acceptance");
      if (this.vtLog instanceof VtLog && meta.generation <= this.vtLog.generation) return;
      if (this.terminal?.log) this.terminal.clear("legacy");
      this.vtLog = new VtLog(meta.generation, meta.cols, meta.rows, new Uint8Array(bytes));
    } else {
      const log = this.vtLog;
      if (
        !log ||
        (log instanceof VtReplayLog && !this.terminal?.owns(this.subscriptionId, log)) ||
        meta.generation !== log.generation ||
        this.vtStale
      )
        return;
      const caughtUp = log instanceof VtReplayLog && log.renderedOffset === log.receivedOffset;
      const admitted =
        log instanceof VtReplayLog
          ? log.append(meta.offset, bytes)
          : meta.offset === this.vtOffset && log.append(new Uint8Array(bytes))
            ? "ok"
            : "full";
      if (admitted !== "ok") {
        if (admitted === "invalid") throw new Error("Out-of-order terminal bytes");
        this.vtStale = true;
        if (!this.recoveryRequested) this.refreshIntent = true;
        return;
      }
      if (caughtUp) this.lastAppliedAt = now;
      this.vtOffset += bytes.length;
    }
    if (meta.kind !== "vt") {
      this.vtOffset = 0;
      this.vtStale = false;
      this.recoveryRequested = false;
      this.recoveryDeadline = null;
      this.refreshIntent = false;
    }
    this.lastHealthyAt = now;
    this.sourceStatus = null;
    const log = this.vtLog!;
    this.publish({
      status: "live",
      vt: { log, length: log instanceof VtReplayLog ? log.receivedOffset : log.chunks.length },
      historyStatus: "end",
    });
  }

  private acceptHistory(
    meta: Extract<StreamTransferMeta, { kind: "history" }>,
    bytes: Uint8Array,
  ): void {
    const record = decodeStreamHistory(meta, bytes);
    const pending = this.pending;
    if (
      !pending ||
      record.requestId !== pending.requestId ||
      record.generation !== pending.generation ||
      record.before !== pending.before
    ) {
      return;
    }
    if (record.status === "page" || (this.explicitRefresh && !this.refreshReplaced)) {
      const baseline = this.baseline;
      if (!baseline || !this.window) throw new Error("Missing history anchor");
      let accepted: boolean;
      if (
        this.explicitRefresh &&
        !this.refreshReplaced &&
        this.window.snapshot.anchor.subscriptionId !== this.subscriptionId
      ) {
        accepted = this.window.replace(baseline.anchor, record, this.skippedRefreshRows);
        if (accepted) this.refreshReplaced = true;
      } else if (record.status === "page") {
        accepted = this.window.prepend(this.subscriptionId, record);
      } else {
        accepted = true;
      }
      if (!accepted) throw new Error("Invalid history page");
      this.publish({ historyStatus: record.status === "page" ? "ready" : record.reason });
    } else {
      this.publish({ historyStatus: record.reason });
    }
    if (this.acceptingSequence === null) throw new Error("Missing history sequence");
    pending.completionSequence = this.acceptingSequence;
    pending.firstDeadline = null;
  }

  private receiveError(message: Extract<StreamMessage, { type: "stream.error" }>): void {
    if (
      message.code === "history-unavailable" ||
      message.code === "history-reset" ||
      message.code === "history-line-too-large"
    ) {
      if (!message.requestId) {
        this.close("invalid-transfer");
        return;
      }
      if (message.requestId !== this.pending?.requestId) return;
      // A completed logical page still owns its request until its final chunk is ACKed.
      if (this.pending.completionSequence !== null) return;
      const pending = this.pending;
      this.pending = null;
      this.intent = false;
      if (message.code === "history-reset") {
        this.window?.detach();
        this.oversizedBefore = null;
        this.publish({ historyStatus: "reset" });
      } else if (message.code === "history-line-too-large") {
        this.oversizedBefore = pending?.before ?? null;
        this.publish({ historyStatus: "oversized" });
      } else {
        this.oversizedBefore = null;
        this.publish({
          historyStatus: message.historyReason === "fetch-window" ? "limited" : "unavailable",
        });
      }
      return;
    }
    this.close(message.code);
  }

  private drain(): void {
    if (this.processing || this.draining || this.current.status === "closed") return;
    this.draining = true;
    try {
      if (this.refreshIntent && !this.recoveryRequested) {
        this.refreshIntent = false;
        const now = this.sampleNow();
        if (now === null || this.isClosed()) return;
        this.recoveryRequested = true;
        this.recoveryDeadline = now + STREAM_LIMITS.progressMs;
        const epoch = this.epoch;
        const outcome = this.send({ type: "stream.refresh", subscriptionId: this.subscriptionId });
        if (this.epoch !== epoch) return;
        if (outcome !== "admitted") {
          this.close(outcome === "refused" ? "stalled" : "invalid-transfer");
          return;
        }
      }
      if (!this.intent || !this.baseline?.acknowledged || this.pending) return;
      if (!historyAcceptsOlder(this.current.historyStatus)) {
        this.intent = false;
        return;
      }
      const anchor = this.baseline.anchor;
      const before =
        this.explicitRefresh && this.window?.snapshot.anchor.subscriptionId !== this.subscriptionId
          ? anchor.before - this.skippedRefreshRows
          : this.window?.snapshot.nextBefore;
      if (before === undefined) return;
      const now = this.sampleNow();
      if (now === null || this.isClosed()) return;
      if (this.requestCounter >= Number.MAX_SAFE_INTEGER) {
        this.intent = false;
        this.publish({ historyStatus: "unavailable" });
        return;
      }
      const requestId = (++this.requestCounter).toString(36).padStart(22, "0");
      this.pending = {
        requestId,
        generation: anchor.generation,
        before,
        firstDeadline:
          now + STREAM_LIMITS.totalMs + STREAM_LIMITS.progressMs + STREAM_LIMITS.ackDelayMs,
        completionSequence: null,
      };
      this.intent = false;
      this.publish({ historyStatus: "loading" });
      if (this.isClosed() || this.pending?.requestId !== requestId) return;
      const epoch = this.epoch;
      const outcome = this.send({
        type: "stream.history.get",
        subscriptionId: this.subscriptionId,
        requestId,
        before,
        count: STREAM_LIMITS.historyLines,
      });
      if (this.epoch !== epoch || this.pending?.requestId !== requestId) return;
      if (outcome === "refused") {
        this.pending = null;
        this.intent = false;
        this.publish({ historyStatus: "unavailable" });
      } else if (outcome === "unknown") {
        this.close("invalid-transfer");
      }
    } finally {
      this.draining = false;
    }
  }
}
