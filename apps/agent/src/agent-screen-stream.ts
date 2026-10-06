import {
  encodeStreamDiff,
  type InnerMessageOf,
  prepareStreamHistory,
  prepareStreamSnapshot,
  SidSchema,
  STREAM_LIMITS,
  type StreamChunk,
  StreamIdSchema,
  type StreamMessage,
  StreamMessageSchema,
  StreamSender,
} from "@shellbell/protocol";
import {
  type HistoryCapture,
  type HistoryReadRequest,
  type HistoryReadResult,
  SessionGone,
} from "./backends/types.js";
import type { ScreenFrameContext } from "./screen-tracker.js";

export type ScreenStreamCloseReason =
  | "cancelled"
  | "stalled"
  | "screen-too-large"
  | "session-gone"
  | "invalid-transfer";

export interface AgentStreamHistoryOptions {
  read: (sessionId: string, request: HistoryReadRequest) => Promise<HistoryReadResult>;
  onReady: () => void;
}

export interface AcknowledgedHistoryAnchor {
  readonly generation: number;
  readonly reported: number;
  readonly capture?: HistoryCapture;
}

export interface AgentScreenStreamOptions {
  subscriptionId: string;
  sessionId: string;
  now: () => number;
  newTransferId: () => string;
  sendChunk: (chunk: StreamChunk) => boolean;
  sendControl: (message: StreamMessage) => boolean;
  requestSnapshot: () => void;
  onClosed: (reason: ScreenStreamCloseReason) => void;
  history?: AgentStreamHistoryOptions;
}

interface NativeHistoryRequest {
  readonly requestId: string;
  readonly before: number;
  readonly count: number;
  readonly anchor: AcknowledgedHistoryAnchor;
  readonly controller: AbortController;
  phase: "reading" | "transfer";
  readDeadline: number | null;
  readyDeadline: number | null;
  finalSequence: number | null;
}

export class AgentScreenStream {
  private readonly options: AgentScreenStreamOptions;
  private readonly sender: StreamSender;
  private readonly startedAt: number;
  private open = true;
  private admitted = false;
  private sending = false;
  private refusalAt: number | null = null;
  private pending: {
    kind: "snapshot" | "diff";
    generation: number;
    reported: number;
    capture?: HistoryCapture;
    finalSequence: number | null;
  } | null = null;
  private nativeHistory: NativeHistoryRequest | null = null;
  private timedOutHistory: NativeHistoryRequest | null = null;
  private latestHistoryRequestId: string | undefined;
  private historyRevoked = false;
  private anchor: AcknowledgedHistoryAnchor | undefined;
  private anchorBound = false;
  private lastAcknowledgedGeneration: number | undefined;
  private snapshotAccepted = false;
  private snapshotRequested = false;
  private refreshRequested = false;

  constructor(options: AgentScreenStreamOptions) {
    if (
      !StreamIdSchema.safeParse(options.subscriptionId).success ||
      !SidSchema.safeParse(options.sessionId).success
    ) {
      throw new Error("Invalid screen stream identity");
    }
    const startedAt = options.now();
    if (!Number.isFinite(startedAt)) throw new Error("Invalid screen stream clock");
    this.options = { ...options, ...(options.history ? { history: { ...options.history } } : {}) };
    this.startedAt = startedAt;
    this.sender = new StreamSender({
      subscriptionId: options.subscriptionId,
      sessionId: options.sessionId,
      now: () => this.readClock(),
      newTransferId: () => this.options.newTransferId(),
      send: (chunk) => this.admitChunk(chunk),
    });
  }

  offer(
    message: InnerMessageOf<"screen.snapshot"> | InnerMessageOf<"screen.diff">,
    context: ScreenFrameContext,
  ): boolean {
    if (!this.canOfferScreen()) return false;
    if (
      message.sessionId !== this.options.sessionId ||
      message.gen !== context.generation ||
      message.scrollbackTotal !== context.reported
    )
      return false;
    if (message.type === "screen.diff") {
      if (
        !this.snapshotAccepted ||
        this.lastAcknowledgedGeneration === undefined ||
        message.gen !== this.lastAcknowledgedGeneration + 1
      ) {
        this.requestFreshSnapshot();
        return false;
      }
    } else if (this.lastAcknowledgedGeneration !== undefined) {
      if (
        message.gen < this.lastAcknowledgedGeneration ||
        (message.gen === this.lastAcknowledgedGeneration && !this.refreshRequested)
      )
        return false;
    }
    let bytes: Uint8Array;
    try {
      if (message.type === "screen.snapshot") {
        const { type: _type, sessionId: _sessionId, ...screen } = message;
        const prepared = prepareStreamSnapshot(screen);
        if (!prepared.ok) {
          this.close(prepared.code);
          return false;
        }
        bytes = prepared.bytes;
      } else {
        const { type: _type, sessionId: _sessionId, ...diff } = message;
        bytes = encodeStreamDiff(diff);
      }
    } catch {
      if (message.type === "screen.diff") this.requestFreshSnapshot();
      else this.close("invalid-transfer");
      return false;
    }
    if (!this.open) return false;
    try {
      const result = this.sender.offer(
        { kind: message.type === "screen.snapshot" ? "snapshot" : "diff", generation: message.gen },
        bytes,
      );
      if (!this.reconcileSender()) return false;
      if (!result.accepted) {
        if (result.reason === "too-large") this.close("screen-too-large");
        return false;
      }
    } catch {
      this.close("invalid-transfer");
      return false;
    }
    if (!this.open) return false;
    this.pending = {
      kind: message.type === "screen.snapshot" ? "snapshot" : "diff",
      generation: context.generation,
      reported: context.reported,
      ...(message.type === "screen.snapshot" && context.capture !== undefined
        ? { capture: context.capture }
        : {}),
      finalSequence: null,
    };
    if (message.type === "screen.snapshot") {
      this.snapshotAccepted = true;
      this.snapshotRequested = false;
      this.refreshRequested = false;
    }
    return true;
  }

  canOfferScreen(): boolean {
    this.tick();
    if (!this.open || this.pending || this.sender.inFlight >= STREAM_LIMITS.unacked) return false;
    let canOffer: boolean;
    try {
      canOffer = this.sender.canOffer("snapshot");
    } catch {
      this.close("invalid-transfer");
      return false;
    }
    if (!this.reconcileSender() || !canOffer) return false;
    return true;
  }

  receive(message: StreamMessage, envelopeBytes: number): void {
    if (!this.open || message.subscriptionId !== this.options.subscriptionId) return;
    this.tick();
    if (!this.open) return;
    if (
      !Number.isSafeInteger(envelopeBytes) ||
      envelopeBytes < 1 ||
      envelopeBytes > STREAM_LIMITS.envelopeBytes ||
      !StreamMessageSchema.safeParse(message).success
    ) {
      this.close("invalid-transfer");
      return;
    }
    if (message.type === "stream.cancel") {
      this.cancel();
      return;
    }
    if (message.type === "stream.refresh") {
      this.refreshRequested = true;
      this.requestFreshSnapshot();
      return;
    }
    if (message.type === "stream.history.get") {
      this.requestHistory(message);
      return;
    }
    if (message.type !== "stream.ack") {
      this.close("invalid-transfer");
      return;
    }
    let result: ReturnType<StreamSender["acknowledge"]>;
    try {
      result = this.sender.acknowledge(message.subscriptionId, message.through);
    } catch {
      this.close("invalid-transfer");
      return;
    }
    if (!this.reconcileSender()) return;
    if (result === "invalid") {
      this.close("invalid-transfer");
      return;
    }
    if (result !== "advanced") return;
    if (
      this.pending?.finalSequence !== null &&
      this.pending?.finalSequence !== undefined &&
      message.through >= this.pending.finalSequence
    ) {
      const completed = this.pending;
      this.pending = null;
      this.lastAcknowledgedGeneration = completed.generation;
      if (!this.anchorBound && completed.kind === "snapshot") {
        this.anchor = Object.freeze({
          generation: completed.generation,
          reported: completed.reported,
          ...(completed.capture === undefined ? {} : { capture: completed.capture }),
        });
        this.anchorBound = true;
      }
    }
    const history = this.nativeHistory;
    if (
      history?.phase === "transfer" &&
      history.finalSequence !== null &&
      message.through >= history.finalSequence
    )
      this.finishHistory(history);
  }

  private requestHistory(message: Extract<StreamMessage, { type: "stream.history.get" }>): void {
    const history = this.options.history;
    if (!history) {
      this.close("invalid-transfer");
      return;
    }
    if (
      message.requestId === this.nativeHistory?.requestId ||
      message.requestId === this.latestHistoryRequestId
    )
      return;
    if (this.nativeHistory || this.timedOutHistory) {
      this.sendHistoryError(message.requestId, "history-unavailable");
      return;
    }
    const anchor = this.anchor;
    let canOffer: boolean;
    try {
      canOffer = this.sender.canOffer("history");
    } catch {
      this.close("invalid-transfer");
      return;
    }
    if (!this.reconcileSender()) return;
    if (this.historyRevoked || (anchor && !anchor.capture)) {
      // The first ACK fixes the history origin. A later viewport cannot supply
      // its missing capture; recovery requires a fresh subscription.
      this.latestHistoryRequestId = message.requestId;
      this.sendHistoryError(message.requestId, "history-reset");
      return;
    }
    if (
      !anchor?.capture ||
      message.before > anchor.reported ||
      this.sender.inFlight >= STREAM_LIMITS.unacked ||
      !canOffer
    ) {
      this.latestHistoryRequestId = message.requestId;
      this.sendHistoryError(message.requestId, "history-unavailable");
      return;
    }
    let now: number;
    try {
      now = this.readClock();
    } catch {
      this.close("invalid-transfer");
      return;
    }
    const owner: NativeHistoryRequest = {
      requestId: message.requestId,
      before: message.before,
      count: message.count,
      anchor,
      controller: new AbortController(),
      phase: "reading",
      readDeadline: now + STREAM_LIMITS.totalMs,
      readyDeadline: null,
      finalSequence: null,
    };
    this.nativeHistory = owner;
    let reading: Promise<HistoryReadResult>;
    try {
      reading = history.read(this.options.sessionId, {
        capture: anchor.capture,
        reported: anchor.reported,
        before: owner.before,
        count: owner.count,
        signal: owner.controller.signal,
      });
    } catch (error) {
      this.failHistoryRead(owner, error);
      return;
    }
    void Promise.resolve(reading)
      .then(
        (result) => this.completeHistoryRead(owner, result),
        (error: unknown) => this.failHistoryRead(owner, error),
      )
      .catch(() => {
        if (this.open && this.nativeHistory === owner) this.close("invalid-transfer");
      });
  }

  private completeHistoryRead(owner: NativeHistoryRequest, result: HistoryReadResult): void {
    if (this.timedOutHistory === owner) {
      this.timedOutHistory = null;
      return;
    }
    if (!this.open || this.nativeHistory !== owner || owner.phase !== "reading") return;
    this.tick();
    if (this.timedOutHistory === owner) {
      this.timedOutHistory = null;
      return;
    }
    if (!this.open || this.nativeHistory !== owner) return;
    if (result === null || typeof result !== "object") {
      this.close("invalid-transfer");
      return;
    }
    if (result.status === "reset") {
      this.historyRevoked = true;
      this.finishHistory(owner, "history-reset");
      return;
    }
    if (result.status === "unavailable") {
      if (
        !["unsupported", "unanchored", "busy", "changed", "fetch-window"].includes(result.reason)
      ) {
        this.close("invalid-transfer");
        return;
      }
      this.finishHistory(owner, "history-unavailable");
      return;
    }
    if (result.status === "cancelled") {
      this.finishHistory(owner, "history-unavailable");
      return;
    }
    if (result.status !== "page" && result.status !== "boundary") {
      this.close("invalid-transfer");
      return;
    }
    if (
      result.status === "page" &&
      (!Array.isArray(result.lines) || result.lines.length > owner.count)
    ) {
      this.close("invalid-transfer");
      return;
    }
    const prepared = prepareStreamHistory({
      ...result,
      kind: "history",
      generation: owner.anchor.generation,
      requestId: owner.requestId,
      before: owner.before,
    });
    if (!prepared.ok) {
      if (prepared.code === "history-line-too-large")
        this.finishHistory(owner, "history-line-too-large");
      else this.close("invalid-transfer");
      return;
    }
    try {
      const offered = this.sender.offer(
        {
          kind: "history",
          generation: owner.anchor.generation,
          requestId: owner.requestId,
          before: owner.before,
        },
        prepared.bytes,
      );
      if (!this.reconcileSender()) return;
      if (!offered.accepted) {
        this.close("invalid-transfer");
        return;
      }
      // The sender owns the encoded copy; release the prepared record and raw rows here.
      owner.phase = "transfer";
      owner.readDeadline = null;
      owner.readyDeadline = this.readClock() + STREAM_LIMITS.progressMs;
    } catch {
      this.close("invalid-transfer");
      return;
    }
    if (!this.open || this.nativeHistory !== owner) return;
    try {
      observeRejection(this.options.history?.onReady(), () => {
        if (this.open) this.close("invalid-transfer");
      });
    } catch {
      if (this.open) this.close("invalid-transfer");
    }
  }

  private failHistoryRead(owner: NativeHistoryRequest, error: unknown): void {
    if (this.timedOutHistory === owner) {
      this.timedOutHistory = null;
      return;
    }
    if (!this.open || this.nativeHistory !== owner || owner.phase !== "reading") return;
    this.tick();
    if (this.timedOutHistory === owner) {
      this.timedOutHistory = null;
      return;
    }
    if (!this.open || this.nativeHistory !== owner) return;
    if (error instanceof SessionGone) this.close("session-gone");
    else this.finishHistory(owner, "history-unavailable");
  }

  private finishHistory(
    owner: NativeHistoryRequest,
    error?: "history-unavailable" | "history-reset" | "history-line-too-large",
  ): void {
    if (!this.open || this.nativeHistory !== owner) return;
    this.nativeHistory = null;
    this.latestHistoryRequestId = owner.requestId;
    owner.readDeadline = null;
    owner.readyDeadline = null;
    if (error) this.sendHistoryError(owner.requestId, error);
  }

  private sendHistoryError(
    requestId: string,
    code: "history-unavailable" | "history-reset" | "history-line-too-large",
  ): void {
    if (!this.open) return;
    let result: unknown;
    try {
      result = this.options.sendControl({
        type: "stream.error",
        subscriptionId: this.options.subscriptionId,
        requestId,
        code,
      });
    } catch {
      this.close("invalid-transfer");
      return;
    }
    if (result !== true && result !== false) {
      observeRejection(result);
      this.close("invalid-transfer");
    }
  }

  sendOne(): boolean {
    if (this.sending) return false;
    this.tick();
    if (!this.open) return false;
    this.sending = true;
    try {
      this.sender.pump();
      this.reconcileSender();
      return this.chunkAdmitted;
    } catch {
      this.close("invalid-transfer");
      throw new Error("Screen stream send failed");
    } finally {
      this.chunkAdmitted = false;
      this.sending = false;
    }
  }
  private chunkAdmitted = false;

  tick(): void {
    if (!this.open) return;
    try {
      const now = this.readClock();
      const history = this.nativeHistory;
      if (
        history?.phase === "reading" &&
        history.readDeadline !== null &&
        now >= history.readDeadline
      ) {
        this.nativeHistory = null;
        this.timedOutHistory = history;
        this.latestHistoryRequestId = history.requestId;
        history.readDeadline = null;
        history.controller.abort();
        this.sendHistoryError(history.requestId, "history-unavailable");
      }
      if (!this.open) return;
      const deadline = this.nextDeadline();
      if (deadline !== null && now >= deadline) this.close("stalled");
    } catch {
      this.close("invalid-transfer");
    }
  }

  nextDeadline(): number | null {
    if (!this.open) return null;
    const deadlines = [this.sender.nextDeadline()];
    if (!this.admitted) deadlines.push(this.startedAt + STREAM_LIMITS.progressMs);
    if (this.refusalAt !== null) deadlines.push(this.refusalAt + STREAM_LIMITS.progressMs);
    if (this.nativeHistory?.readDeadline !== null && this.nativeHistory?.readDeadline !== undefined)
      deadlines.push(this.nativeHistory.readDeadline);
    if (
      this.nativeHistory?.readyDeadline !== null &&
      this.nativeHistory?.readyDeadline !== undefined
    )
      deadlines.push(this.nativeHistory.readyDeadline);
    const active = deadlines.filter((deadline): deadline is number => deadline !== null);
    return active.length === 0 ? null : Math.min(...active);
  }

  historyAnchor(): AcknowledgedHistoryAnchor | undefined {
    return this.anchor;
  }

  cancel(): void {
    this.close("cancelled");
  }

  terminate(reason: "session-gone" | "invalid-transfer"): void {
    if (reason !== "session-gone" && reason !== "invalid-transfer") {
      throw new TypeError("Invalid screen stream termination reason");
    }
    this.close(reason);
  }

  private readClock(): number {
    const now = this.options.now();
    if (!Number.isFinite(now)) throw new Error("Invalid screen stream clock");
    return now;
  }

  private reconcileSender(): boolean {
    if (!this.open) return false;
    try {
      const state = this.sender.tick();
      if (this.open && state !== "open")
        this.close(state === "stalled" ? "stalled" : "invalid-transfer");
    } catch {
      this.close("invalid-transfer");
    }
    return this.open;
  }

  private admitChunk(chunk: StreamChunk): boolean {
    if (!this.open || this.chunkAdmitted) return false;
    this.tick();
    if (!this.open) return false;
    let result: unknown;
    try {
      result = this.options.sendChunk(chunk);
    } catch {
      this.close("invalid-transfer");
      throw new Error("Screen stream send failed");
    }
    if (result !== true && result !== false) {
      observeRejection(result);
      this.close("invalid-transfer");
      throw new Error("Screen stream send failed");
    }
    if (result) {
      this.chunkAdmitted = true;
      this.admitted = true;
      this.refusalAt = null;
      if (
        chunk.meta.kind === "history" &&
        this.nativeHistory?.phase === "transfer" &&
        chunk.meta.requestId === this.nativeHistory.requestId
      ) {
        this.nativeHistory.readyDeadline = null;
        if (chunk.index === chunk.count - 1) this.nativeHistory.finalSequence = chunk.sequence;
      } else if (
        chunk.meta.kind !== "history" &&
        this.pending &&
        chunk.meta.generation === this.pending.generation &&
        chunk.index === chunk.count - 1
      ) {
        this.pending.finalSequence = chunk.sequence;
      }
    } else if (this.open && this.refusalAt === null) {
      try {
        this.refusalAt = this.readClock();
      } catch {
        this.close("invalid-transfer");
      }
    }
    return result;
  }

  private requestFreshSnapshot(): void {
    if (!this.open || this.snapshotRequested) return;
    this.snapshotRequested = true;
    try {
      observeRejection(this.options.requestSnapshot(), () => {
        if (this.open) this.close("invalid-transfer");
      });
    } catch {
      this.close("invalid-transfer");
    }
  }

  private close(reason: ScreenStreamCloseReason): void {
    if (!this.open) return;
    this.open = false;
    const history = this.nativeHistory;
    this.nativeHistory = null;
    this.timedOutHistory = null;
    this.sender.cancel();
    this.pending = null;
    this.anchor = undefined;
    this.anchorBound = false;
    this.refusalAt = null;
    this.snapshotRequested = false;
    this.refreshRequested = false;
    history?.controller.abort();
    if (reason !== "cancelled") {
      try {
        observeRejection(
          this.options.sendControl({
            type: "stream.error",
            subscriptionId: this.options.subscriptionId,
            code: reason,
          }),
        );
      } catch {
        /* callback failure cannot revive a closed subscription */
      }
    }
    try {
      observeRejection(this.options.onClosed(reason));
    } catch {
      /* closure notification is best effort */
    }
  }
}

function observeRejection(value: unknown, onReject?: () => void): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  void new Promise((resolve) => resolve(value)).catch(() => onReject?.());
}
