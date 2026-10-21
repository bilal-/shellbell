import {
  CONTINUATION_EXTENSIONS,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  StreamMessageSchema,
  StreamSender,
  type StreamTransferMeta,
  selectStreamExtensions,
} from "@shellbell/protocol";
import type { VtSource, VtSourceEnd } from "./backends/types.js";
import { StreamAppliedProgress } from "./stream-applied-progress.js";

export type VtStreamCloseReason =
  | "cancelled"
  | "stalled"
  | "session-gone"
  | "invalid-transfer"
  | "unsupported";

export interface AgentVtStreamOptions {
  subscriptionId: string;
  sessionId: string;
  source: VtSource;
  extensions?: readonly string[];
  retained?: boolean;
  now: () => number;
  newTransferId: () => string;
  sendChunk: (chunk: StreamChunk) => boolean;
  sendControl: (message: StreamMessage) => boolean;
  /** Output, a seed or a status is waiting; the owner should pump. */
  onReady: () => void;
  onClosed: (reason: VtStreamCloseReason) => void;
}

/** Output held while a transfer is in flight; past it the phone is reseeded instead. */
export const VT_BACKLOG_BYTES = 256 * 1024;
/** History lines in the first seed; halved while a seed exceeds one screen transfer. */
export const VT_HISTORY_LINES = 2000;

const encoder = new TextEncoder();

/**
 * A raw terminal subscription: one seed, then the terminal's bytes, on the screen lane. Output
 * that arrives while a transfer is in flight is batched into the next one. When the phone falls
 * too far behind, held output is dropped and a fresh seed is taken once the lane is free, so the
 * phone catches up to the present instead of replaying everything it missed.
 */
export class AgentVtStream {
  private readonly sender: StreamSender;
  private open = true;
  private sending = false;
  private chunkAdmitted = false;
  private generation = 0;
  private state: { meta: StreamTransferMeta; bytes: Uint8Array } | null = null;
  private backlog: Uint8Array[] = [];
  private backlogBytes = 0;
  private offset = 0;
  /** Output was dropped; send nothing more until the next seed. */
  private behind = false;
  private reseedRequested = false;
  private historyLines = VT_HISTORY_LINES;
  private readonly extensions: string[];
  private negotiationPending: boolean;
  private negotiationDeadline: number | null = null;
  private readonly progress = new StreamAppliedProgress();
  private nextProbeAt: number | null = null;
  private probeDeadline: number | null = null;
  private probeToken = 0;
  private probePending = false;
  private probeExpired = false;
  private status: Extract<StreamMessage, { type: "stream.status" }> | null = null;
  private controlRetryAt: number | null = null;
  private seeded = false;

  constructor(private readonly options: AgentVtStreamOptions) {
    this.extensions = selectStreamExtensions(
      options.extensions,
      options.source.continuation ? CONTINUATION_EXTENSIONS : [],
    );
    this.negotiationPending = options.extensions !== undefined;
    this.sender = new StreamSender({
      subscriptionId: options.subscriptionId,
      sessionId: options.sessionId,
      now: () => this.readClock(),
      newTransferId: () => options.newTransferId(),
      send: (chunk) => this.admitChunk(chunk),
    });
    const { source } = options;
    source.on("seed", (seed) => {
      if (!this.open) return;
      const extended = this.extensions.length > 0;
      if (extended && !seed.continuation) {
        this.close("invalid-transfer");
        return;
      }
      const replace = seed.continuation?.reason === "herdr-idle";
      const retained = this.seeded || options.retained === true;
      const bytes = encoder.encode(
        extended && retained && !replace ? seed.continuation!.data : seed.data,
      );
      if (bytes.length > STREAM_LIMITS.screenBytes) {
        // A long history; the visible screen alone always fits a 512 KiB transfer.
        if (this.historyLines > 1) {
          this.historyLines = Math.max(1, Math.floor(this.historyLines / 2));
          void source.reseed(this.historyLines);
        } else this.close("invalid-transfer");
        return;
      }
      this.generation = seed.generation;
      const geometry = { generation: seed.generation, cols: seed.cols, rows: seed.rows };
      this.state = {
        meta: extended
          ? {
              kind: "vt-seed",
              ...geometry,
              capture: options.newTransferId(),
              disposition: !retained ? "initial" : replace ? "replace" : "discontinuity",
              reason: !retained
                ? "start"
                : replace
                  ? "herdr-idle"
                  : !this.seeded
                    ? "reconnect"
                    : this.behind
                      ? "overflow"
                      : seed.continuation!.reason,
              cursor: source.continuation!.cursor,
              alternate: source.continuation!.alternate,
            }
          : { kind: "vt-state", ...geometry },
        bytes,
      };
      this.status = null;
      if (extended && !this.probePending) this.nextProbeAt = this.readClock() + 2_000;
      this.backlog = [];
      this.backlogBytes = 0;
      this.offset = 0;
      this.behind = false;
      this.reseedRequested = false;
      this.ready();
    });
    source.on("bytes", (data, generation) => {
      // Nothing to send; holding it would grow the backlog without counting against its bound.
      if (data.length === 0) return;
      if (!this.open || this.behind || generation !== this.generation) return;
      if (this.backlogBytes + data.length > VT_BACKLOG_BYTES) {
        this.behind = true;
        this.backlog = [];
        this.backlogBytes = 0;
        this.ready();
        return;
      }
      this.backlog.push(new Uint8Array(data));
      this.backlogBytes += data.length;
      this.status = null;
      if (this.extensions.length && !this.probePending) this.nextProbeAt = this.readClock() + 2_000;
      this.ready();
    });
    source.on("end", (reason) => this.close(endReason(reason)));
  }

  start(): Promise<void> {
    if (this.negotiationPending)
      this.negotiationDeadline = this.readClock() + STREAM_LIMITS.progressMs;
    if (this.extensions.length) this.nextProbeAt = this.readClock() + 2_000;
    return this.options.source.start(this.historyLines);
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
      this.requestReseed();
      return;
    }
    if (message.type === "stream.history.get") {
      // xterm keeps the history itself; the seed already carried tmux's.
      this.sendControl({
        type: "stream.error",
        subscriptionId: this.options.subscriptionId,
        requestId: message.requestId,
        code: "history-unavailable",
      });
      return;
    }
    if (message.type === "stream.applied") {
      if (
        this.negotiationPending ||
        this.extensions.length === 0 ||
        this.progress.receive(message) === "invalid"
      )
        this.close("invalid-transfer");
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
    if (result === "invalid") this.close("invalid-transfer");
    else if (result === "advanced") this.ready();
  }

  /** Admit at most one control or data envelope per shared scheduler turn. */
  sendOne(): boolean {
    if (this.sending) return false;
    this.tick();
    if (!this.open) return false;
    this.sending = true;
    try {
      const control = this.flushControl();
      if (control !== "ready") return control === "sent";
      if (this.sender.canOffer("vt")) this.offerNext();
      if (!this.open) return false;
      this.sender.pump();
      this.reconcileSender();
      return this.chunkAdmitted;
    } catch {
      this.close("invalid-transfer");
      return false;
    } finally {
      this.chunkAdmitted = false;
      this.sending = false;
    }
  }

  tick(): void {
    if (!this.open) return;
    try {
      this.reconcileSender();
      if (this.negotiationDeadline !== null && this.readClock() >= this.negotiationDeadline)
        this.close("stalled");
      if (this.open) this.probe();
    } catch {
      this.close("invalid-transfer");
    }
  }

  nextDeadline(): number | null {
    if (!this.open) return null;
    const deadlines = [
      this.sender.nextDeadline(),
      this.nextProbeAt,
      this.probeDeadline,
      this.controlRetryAt,
      this.negotiationDeadline,
    ].filter((value): value is number => value !== null);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  cancel(): void {
    this.close("cancelled");
  }

  terminate(reason: "session-gone" | "invalid-transfer"): void {
    this.close(reason);
  }

  private offerNext(): void {
    if (this.state) {
      const { meta, bytes } = this.state;
      const offered = this.sender.offer(meta, bytes);
      if (offered.accepted) {
        this.state = null;
        this.seeded = true;
      }
      return;
    }
    if (this.behind) {
      // The lane is free, so a seed taken now goes out at once and is as fresh as possible.
      this.requestReseed();
      return;
    }
    if (this.backlogBytes === 0) return;
    const bytes = new Uint8Array(this.backlogBytes);
    let at = 0;
    for (const part of this.backlog) {
      bytes.set(part, at);
      at += part.length;
    }
    const offered = this.sender.offer(
      { kind: "vt", generation: this.generation, offset: this.offset },
      bytes,
    );
    if (offered.accepted) {
      this.offset += bytes.length;
      this.backlog = [];
      this.backlogBytes = 0;
    }
  }

  private requestReseed(): void {
    if (this.reseedRequested) return;
    this.reseedRequested = true;
    void this.options.source.reseed(this.historyLines);
  }

  private ready(): void {
    try {
      this.options.onReady();
    } catch {
      /* the owner's pump is best effort */
    }
  }

  private readClock(): number {
    const now = this.options.now();
    if (!Number.isFinite(now)) throw new Error("Invalid vt stream clock");
    return now;
  }

  private reconcileSender(): void {
    const state = this.sender.tick();
    if (this.open && state !== "open")
      this.close(state === "stalled" ? "stalled" : "invalid-transfer");
  }

  private admitChunk(chunk: StreamChunk): boolean {
    if (!this.open || this.chunkAdmitted) return false;
    const sent = this.options.sendChunk(chunk);
    if (sent) {
      this.chunkAdmitted = true;
      if (this.extensions.length) this.progress.admit(chunk);
    }
    return sent;
  }

  /** One coalescing status slot, independent of terminal transfer credits. */
  private flushControl(): "ready" | "blocked" | "sent" {
    const message: StreamMessage | null = this.negotiationPending
      ? {
          type: "stream.accepted",
          subscriptionId: this.options.subscriptionId,
          extensions: this.extensions,
        }
      : this.status;
    if (!message) {
      this.controlRetryAt = null;
      return "ready";
    }
    if (this.controlRetryAt !== null && this.readClock() < this.controlRetryAt)
      return this.negotiationPending ? "blocked" : "ready";
    let sent = false;
    try {
      sent = this.options.sendControl(message) === true;
    } catch {
      // Retry a refused control without admitting extended data ahead of negotiation.
    }
    if (!sent) {
      this.controlRetryAt = this.readClock() + 100;
      return this.negotiationPending ? "blocked" : "ready";
    }
    this.controlRetryAt = null;
    if (this.negotiationPending) {
      this.negotiationPending = false;
      this.negotiationDeadline = null;
    } else if (this.status === message) this.status = null;
    return "sent";
  }

  private probe(): void {
    if (!this.extensions.length) return;
    const now = this.readClock();
    if (this.probeDeadline !== null && now >= this.probeDeadline) {
      this.probeDeadline = null;
      this.probeExpired = true;
      this.publishStatus("paused");
    }
    if (this.probePending) return;
    if (this.nextProbeAt === null || now < this.nextProbeAt) return;
    this.nextProbeAt = null;
    this.probeDeadline = now + 2_000;
    this.probePending = true;
    this.probeExpired = false;
    const token = ++this.probeToken;
    Promise.resolve()
      .then(() => this.options.source.continuation!.probe())
      .then(
        (result) => {
          if (!this.open || token !== this.probeToken) return;
          this.probePending = false;
          this.probeDeadline = null;
          this.nextProbeAt = this.readClock() + 2_000;
          if (this.probeExpired) {
            this.ready();
            return;
          }
          const caughtUp =
            result.quiescent &&
            result.generation === this.generation &&
            !this.state &&
            !this.behind &&
            this.backlogBytes === 0 &&
            this.sender.canOffer("vt");
          this.publishStatus(caughtUp ? "quiescent" : "catching-up");
        },
        () => {
          if (!this.open || token !== this.probeToken) return;
          this.probePending = false;
          this.probeDeadline = null;
          this.nextProbeAt = this.readClock() + 2_000;
          this.publishStatus("paused");
        },
      )
      .catch(() => {
        if (this.open && token === this.probeToken) this.close("invalid-transfer");
      });
  }

  private publishStatus(state: "quiescent" | "catching-up" | "paused"): void {
    const boundary = this.progress.boundary;
    if (boundary) {
      this.status = {
        type: "stream.status",
        subscriptionId: this.options.subscriptionId,
        ...boundary,
        state,
      };
    }
    this.ready();
  }

  private sendControl(message: StreamMessage): void {
    try {
      this.options.sendControl(message);
    } catch {
      /* control delivery is best effort */
    }
  }

  private close(reason: VtStreamCloseReason): void {
    if (!this.open) return;
    this.open = false;
    ++this.probeToken;
    this.status = null;
    this.negotiationDeadline = null;
    this.probeDeadline = null;
    this.nextProbeAt = null;
    this.controlRetryAt = null;
    this.sender.cancel();
    this.state = null;
    this.backlog = [];
    this.backlogBytes = 0;
    this.options.source.close();
    if (reason !== "cancelled") {
      this.sendControl({
        type: "stream.error",
        subscriptionId: this.options.subscriptionId,
        code: reason,
      });
    }
    try {
      this.options.onClosed(reason);
    } catch {
      /* closure notification is best effort */
    }
  }
}

/** Herdr read failures must not trigger a snapshot fallback that has not been verified. */
function endReason(reason: VtSourceEnd): VtStreamCloseReason {
  if (reason === "pane-gone") return "session-gone";
  if (reason === "herdr-unreadable") return "stalled";
  return "unsupported";
}
