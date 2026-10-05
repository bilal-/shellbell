import {
  applyStreamScreen,
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
  | "oversized"
  | "end"
  | "truncated"
  | "reset";
export interface MobileStreamSnapshot {
  readonly status: "idle" | "loading" | "live" | "closed";
  readonly error?: MobileStreamError;
  readonly screen?: Readonly<ScreenSnapshot>;
  readonly history?: HistoryWindowSnapshot;
  readonly historyStatus: MobileHistoryStatus;
}
export interface MobileScreenStreamOptions {
  subscriptionId: string;
  sessionId: string;
  now: () => number;
  sendControl: (message: StreamMessage) => boolean;
  retainedHistory?: BoundedHistoryWindow;
  refreshHistory?: boolean;
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

/** Timer-free owner for one negotiated bounded subscription. No production caller is installed here. */
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
      this.window = retainedHistory;
      this.explicitRefresh = refreshHistory === true;
      this.current = Object.freeze({
        status: "idle",
        historyStatus: "waiting",
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

  private isClosed(): boolean {
    return this.current.status === "closed";
  }

  start(): boolean {
    if (this.isClosed()) return false;
    if (this.current.status !== "idle") return true;
    const now = this.sampleNow();
    if (now === null || this.isClosed()) return false;
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
      if (incoming.type === "stream.error") {
        this.receiveError(incoming);
        return;
      }
      if (incoming.type !== "stream.chunk") {
        this.close("invalid-transfer");
        return;
      }
      this.acceptingSequence = incoming.sequence;
      const result = this.receiver?.receive(incoming, envelopeBytes);
      this.acceptingSequence = null;
      if (result === "invalid") this.close("invalid-transfer");
      else if (result === "stalled") this.close("stalled");
      else if (result === "accepted" && !this.isClosed()) {
        if (incoming.meta.kind !== "history") this.firstScreenDeadline = null;
        if (
          incoming.meta.kind === "snapshot" &&
          this.recoveryRequested &&
          incoming.meta.generation >= (this.current.screen?.gen ?? 0)
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
      this.current.historyStatus === "reset" ||
      this.current.historyStatus === "end" ||
      this.current.historyStatus === "truncated" ||
      this.current.historyStatus === "oversized" ||
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

  cancel(): void {
    this.close();
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
    this.publish({
      status: "closed",
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
    else this.acceptScreen(meta, bytes);
  }

  private acceptScreen(meta: StreamTransferMeta, bytes: Uint8Array): void {
    const record = decodeStreamScreen(meta, bytes);
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
    if (record.status === "page") {
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
      } else {
        accepted = this.window.prepend(this.subscriptionId, record);
      }
      if (!accepted) throw new Error("Invalid history page");
      this.publish({ historyStatus: "ready" });
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
        this.publish({ historyStatus: "unavailable" });
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
      if (
        this.current.historyStatus === "reset" ||
        this.current.historyStatus === "end" ||
        this.current.historyStatus === "truncated" ||
        this.current.historyStatus === "oversized"
      ) {
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
