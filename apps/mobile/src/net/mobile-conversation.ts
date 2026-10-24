import {
  CONVERSATION_LIMITS,
  type ConversationBatch,
  type ConversationMessage,
  ConversationMessageSchema,
  type ConversationWireEntry,
  encodeCbor,
  SidSchema,
  StreamIdSchema,
  sha256,
  toBase64Url,
} from "@shellbell/protocol";

export interface MobileConversationOptions {
  subscriptionId: string;
  sessionId: string;
  now: () => number;
  newRequestId: () => string;
  /** One actual direct envelope; peer delivery must be queued until this synchronous call returns. */
  send: (message: ConversationMessage) => boolean;
}
export interface MobileConversationSnapshot {
  readonly state: "checking" | "ready" | "disabled" | "unavailable" | "ended";
  readonly entries: readonly Readonly<ConversationWireEntry>[];
  readonly history: NonNullable<ConversationBatch["history"]>;
  readonly historyStatus: "idle" | "loading" | "unavailable" | "limit";
  readonly canRequestOlder: boolean;
  readonly caughtUp: boolean | null;
  readonly notice: "skipped" | "evicted" | null;
  readonly reason: "unbound" | "unsupported" | "source" | "busy" | "protocol" | null;
}
type Retained = { entry: Readonly<ConversationWireEntry>; bytes: number };
type HistoryRequest = {
  id: string;
  cursor: string;
  anchor: string;
  deadline: number;
  timedOut: boolean;
  obsolete: boolean;
};

/** Memory-only, one route/session. A clear acknowledgement gates the next generation. */
export class MobileConversation {
  private readonly options: MobileConversationOptions;
  private started = false;
  private closed = false;
  private sending = false;
  private cancelPending = false;
  private recovering = false;
  private refreshRetry: { deadline: number; attempts: number } | null = null;
  private generation: string | null = null;
  private retiredGeneration: string | null = null;
  private revision = 0;
  private lastBatch: { id: string; hash: string } | null = null;
  private lastClear: string | null = null;
  private pendingClear: { id: string } | null = null;
  private barrier = false;
  private retained: Retained[] = [];
  private retainedBytes = 0;
  private cursor: string | null = null;
  private pendingHistory: HistoryRequest | null = null;
  private lastRequestId: string | null = null;
  private state: MobileConversationSnapshot["state"] = "checking";
  private history: MobileConversationSnapshot["history"] = "complete";
  private historyStatus: MobileConversationSnapshot["historyStatus"] = "idle";
  private caughtUp: boolean | null = null;
  private notice: MobileConversationSnapshot["notice"] = null;
  private reason: MobileConversationSnapshot["reason"] = null;
  private entries: readonly Readonly<ConversationWireEntry>[] = Object.freeze([]);

  constructor(options: MobileConversationOptions) {
    this.options = { ...options };
    if (
      !StreamIdSchema.safeParse(this.options.subscriptionId).success ||
      !SidSchema.safeParse(this.options.sessionId).success ||
      this.time() === null
    )
      throw new TypeError("Invalid conversation view");
  }

  get snapshot(): Readonly<MobileConversationSnapshot> {
    return Object.freeze({
      state: this.state,
      entries: this.entries,
      history: this.history,
      historyStatus: this.historyStatus,
      caughtUp: this.caughtUp,
      notice: this.notice,
      reason: this.reason,
      canRequestOlder:
        !this.closed &&
        this.state === "ready" &&
        !!this.cursor &&
        this.retained.length > 0 &&
        (!this.pendingHistory || this.pendingHistory.timedOut) &&
        this.hasHistoryRoom(),
    });
  }

  get subscribed(): boolean {
    return this.started && !this.closed;
  }

  start(): boolean {
    if (this.closed || this.started) return false;
    this.started = true;
    this.state = "checking";
    this.reason = null;
    const sent = this.send({
      type: "conversation.subscribe",
      subscriptionId: this.options.subscriptionId,
      sessionId: this.options.sessionId,
    });
    if (!sent && !this.closed) {
      this.started = false;
      this.state = "unavailable";
      this.reason = "source";
    }
    return sent;
  }

  receive(message: unknown, envelopeBytes: number): boolean {
    if (
      this.closed ||
      !this.started ||
      !message ||
      typeof message !== "object" ||
      (message as { subscriptionId?: unknown }).subscriptionId !== this.options.subscriptionId
    )
      return false;
    if (
      !Number.isSafeInteger(envelopeBytes) ||
      envelopeBytes < 1 ||
      envelopeBytes > CONVERSATION_LIMITS.envelopeBytes
    ) {
      this.recover();
      return false;
    }
    const parsed = ConversationMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.recover();
      return false;
    }
    const value = parsed.data;
    switch (value.type) {
      case "conversation.clear": {
        if (value.clearId !== this.lastClear) {
          this.discard();
          this.barrier = true;
          this.recovering = false;
          this.refreshRetry = null;
          this.lastClear = value.clearId;
          this.pendingClear = { id: value.clearId };
          this.state =
            value.reason === "disabled"
              ? "disabled"
              : value.reason === "ended"
                ? "ended"
                : value.reason === "unavailable"
                  ? "unavailable"
                  : "checking";
          this.notice = value.reason === "skipped" ? "skipped" : null;
          this.reason = value.reason === "unavailable" ? "source" : null;
        }
        const pending = this.pendingClear;
        const sent = this.send({
          type: "conversation.cleared",
          subscriptionId: this.options.subscriptionId,
          clearId: value.clearId,
        });
        if (sent && !this.closed && pending && this.pendingClear === pending) {
          this.pendingClear = null;
          this.barrier = false;
          this.recovering = false;
          this.refreshRetry = null;
          this.state =
            value.reason === "disabled"
              ? "disabled"
              : value.reason === "ended"
                ? "ended"
                : value.reason === "unavailable"
                  ? "unavailable"
                  : "checking";
        }
        return true;
      }
      case "conversation.status":
        if (
          (this.recovering || this.barrier) &&
          (value.state === "ready" || value.state === "checking")
        )
          return false;
        if (value.state === "disabled" || value.state === "unavailable") {
          this.barrier ||= this.generation !== null;
          this.discard();
          this.refreshRetry = null;
          this.recovering = false;
        }
        this.state = value.state;
        this.reason = value.reason ?? null;
        this.caughtUp = value.caughtUp ?? null;
        // The skip notice explains a reset; once the new generation is current it is stale.
        if (this.notice === "skipped" && this.generation !== null && value.caughtUp === true)
          this.notice = null;
        return true;
      case "conversation.batch":
        return this.apply(value);
      case "conversation.history.end": {
        const pending = this.pendingHistory;
        if (value.generation !== this.generation || value.requestId !== pending?.id) return false;
        if (pending.obsolete) {
          this.pendingHistory = null;
          this.historyStatus = "limit";
          return true;
        }
        if (value.reason === "changed") {
          this.pendingHistory = null;
          this.cursor = null;
          this.historyStatus = "unavailable";
          return true;
        }
        if (value.reason === "complete") {
          this.pendingHistory = null;
          this.cursor = null;
          this.history = "complete";
          this.historyStatus = "idle";
        } else {
          pending.timedOut = true;
          this.historyStatus = "unavailable";
        }
        return true;
      }
      default:
        this.recover();
        return false;
    }
  }

  requestOlder(): boolean {
    if (
      this.closed ||
      !this.started ||
      this.state !== "ready" ||
      !this.generation ||
      !this.cursor ||
      this.barrier
    )
      return false;
    if (!this.hasHistoryRoom()) {
      this.historyStatus = "limit";
      return false;
    }
    if (this.pendingHistory && !this.pendingHistory.timedOut) return false;
    const now = this.time();
    if (now === null) {
      this.recover();
      return false;
    }
    let pending = this.pendingHistory;
    if (!pending) {
      let id: string;
      try {
        id = this.options.newRequestId();
      } catch {
        this.historyStatus = "unavailable";
        return false;
      }
      const anchor = this.retained[0]?.entry.id;
      if (!StreamIdSchema.safeParse(id).success || id === this.lastRequestId || !anchor) {
        this.historyStatus = "unavailable";
        return false;
      }
      pending = {
        id,
        cursor: this.cursor,
        anchor,
        deadline: now + CONVERSATION_LIMITS.progressMs,
        timedOut: false,
        obsolete: false,
      };
      this.lastRequestId = id;
      this.pendingHistory = pending;
    }
    pending.deadline = now + CONVERSATION_LIMITS.progressMs;
    pending.timedOut = false;
    this.historyStatus = "loading";
    const sent = this.send({
      type: "conversation.history.get",
      subscriptionId: this.options.subscriptionId,
      generation: this.generation,
      requestId: pending.id,
      cursor: pending.cursor,
    });
    if (!sent && this.pendingHistory === pending) {
      pending.timedOut = true;
      this.historyStatus = "unavailable";
    }
    return sent;
  }

  tick(): void {
    if (this.closed) return;
    const now = this.time();
    if (now === null) {
      this.recover();
      return;
    }
    if (this.refreshRetry && now >= this.refreshRetry.deadline) this.sendRefresh(this.refreshRetry);
    if (
      this.pendingHistory &&
      !this.pendingHistory.timedOut &&
      now >= this.pendingHistory.deadline
    ) {
      this.pendingHistory.timedOut = true;
      this.historyStatus = "unavailable";
    }
  }

  nextDeadline(): number | null {
    if (this.closed) return null;
    const history =
      this.pendingHistory && !this.pendingHistory.timedOut ? this.pendingHistory.deadline : null;
    const refresh = this.refreshRetry?.deadline ?? null;
    return history === null ? refresh : refresh === null ? history : Math.min(history, refresh);
  }

  refresh(): void {
    if (!this.closed && this.started) this.recover(true);
  }

  malformed(): void {
    if (!this.closed && this.started) this.recover();
  }

  /** An authenticated hello can announce owner opt-out before the clear control arrives. */
  disable(): void {
    if (this.closed) return;
    this.barrier ||= this.generation !== null;
    this.discard();
    this.refreshRetry = null;
    this.recovering = false;
    this.state = "disabled";
    this.reason = null;
  }

  /** Route loss, leaving the session and revocation all discard held records before any callback. */
  close(): void {
    if (this.closed) return;
    const notify = this.started;
    this.closed = true;
    this.discard();
    this.refreshRetry = null;
    this.pendingClear = null;
    this.lastClear = null;
    this.retiredGeneration = null;
    this.lastRequestId = null;
    this.state = "ended";
    this.notice = null;
    this.reason = null;
    if (notify) {
      if (this.sending) this.cancelPending = true;
      else
        this.send(
          { type: "conversation.cancel", subscriptionId: this.options.subscriptionId },
          true,
        );
    }
  }

  private apply(batch: ConversationBatch): boolean {
    if (this.state === "disabled" || this.state === "ended") return false;
    const encoded = encodeCbor(batch);
    const hash = toBase64Url(sha256(encoded));
    encoded.fill(0);
    if (
      this.generation === batch.generation &&
      this.revision === batch.revision &&
      this.lastBatch?.id === batch.batchId
    ) {
      if (this.lastBatch.hash !== hash) {
        this.recover();
        return false;
      }
      this.acknowledge(batch);
      return true;
    }
    if (
      this.barrier ||
      (batch.operation === "reset"
        ? this.generation !== null || batch.generation === this.retiredGeneration
        : this.generation !== batch.generation) ||
      batch.baseRevision !== this.revision
    ) {
      this.recover();
      return false;
    }
    let retained: Retained[];
    let suffix: Retained[] = [];
    if (batch.operation === "reset") retained = [];
    else if (batch.operation === "patch") {
      const index =
        batch.anchor === null
          ? -1
          : this.retained.findIndex(({ entry }) => entry.id === batch.anchor);
      if (
        (batch.anchor === null && this.retained.length !== 0 && batch.after === undefined) ||
        (batch.anchor !== null && index < 0)
      ) {
        this.recover();
        return false;
      }
      retained = this.retained.slice(0, index + 1);
      if (batch.after !== undefined && batch.after !== null) {
        const after = this.retained.findIndex(({ entry }) => entry.id === batch.after);
        if (after <= index) {
          this.recover();
          return false;
        }
        suffix = this.retained.slice(after);
      }
    } else {
      const pending = this.pendingHistory;
      if (
        !pending ||
        pending.id !== batch.requestId ||
        pending.anchor !== batch.anchor ||
        (!pending.obsolete && this.retained[0]?.entry.id !== batch.anchor)
      ) {
        this.recover();
        return false;
      }
      if (pending.obsolete) {
        // The live tail evicted this page's anchor while the request was in flight.
        // Account for the applied batch without joining across the missing boundary.
        this.revision = batch.revision;
        this.lastBatch = { id: batch.batchId, hash };
        this.pendingHistory = null;
        this.historyStatus = "limit";
        this.acknowledge(batch);
        return true;
      }
      retained = [...this.retained];
    }
    const ids = new Set([...retained, ...suffix].map(({ entry }) => entry.id));
    if (batch.entries.some((entry) => ids.has(entry.id))) {
      this.recover();
      return false;
    }
    const incoming = batch.entries.map((value) => {
      const entry = Object.freeze({ ...value });
      const bytes = encodeCbor(entry);
      const length = bytes.byteLength;
      bytes.fill(0);
      return { entry, bytes: length };
    });
    const combined =
      batch.operation === "prepend"
        ? [...incoming, ...retained]
        : [...retained, ...incoming, ...suffix];
    let bytes = combined.reduce((total, row) => total + row.bytes, 0);
    let first = 0;
    while (
      combined.length - first > CONVERSATION_LIMITS.retainedEntries ||
      bytes > CONVERSATION_LIMITS.retainedBytes
    )
      bytes -= combined[first++]!.bytes;
    this.retained = combined.slice(first);
    this.retainedBytes = bytes;
    this.entries = Object.freeze(this.retained.map(({ entry }) => entry));
    this.generation = batch.generation;
    this.revision = batch.revision;
    this.lastBatch = { id: batch.batchId, hash };
    this.state = "ready";
    this.reason = null;
    this.recovering = false;
    this.refreshRetry = null;
    if (batch.olderCursor !== undefined) this.cursor = batch.olderCursor;
    if (batch.history !== undefined) this.history = batch.history;
    if (batch.operation === "prepend") {
      this.pendingHistory = null;
      this.historyStatus = "idle";
    }
    if (first > 0) {
      this.notice = "evicted";
      this.cursor = null;
      this.history = "unloaded";
      this.historyStatus = "limit";
      if (this.pendingHistory && this.pendingHistory.anchor !== this.retained[0]?.entry.id) {
        this.pendingHistory.obsolete = true;
        this.pendingHistory.timedOut = true;
      }
    }
    this.acknowledge(batch);
    return true;
  }

  private acknowledge(batch: ConversationBatch): void {
    this.send({
      type: "conversation.applied",
      subscriptionId: this.options.subscriptionId,
      generation: batch.generation,
      batchId: batch.batchId,
      revision: batch.revision,
      oldestId: this.retained[0]?.entry.id ?? null,
      newestId: this.retained.at(-1)?.entry.id ?? null,
      retainedCount: this.retained.length,
    });
  }

  private recover(force = false): void {
    if (
      this.closed ||
      this.state === "disabled" ||
      this.state === "ended" ||
      (this.recovering && !force)
    )
      return;
    this.discard();
    this.barrier = true;
    this.recovering = true;
    this.state = "unavailable";
    this.reason = "protocol";
    const retry = { deadline: this.time() ?? 0, attempts: 0 };
    this.refreshRetry = retry;
    this.sendRefresh(retry);
  }

  private sendRefresh(retry: { deadline: number; attempts: number }): void {
    const sent = this.send({
      type: "conversation.refresh",
      subscriptionId: this.options.subscriptionId,
    });
    if (this.refreshRetry !== retry || this.closed) return;
    {
      const now = this.time();
      if (now === null) {
        this.refreshRetry = null;
        this.recovering = false;
        return;
      }
      retry.deadline =
        now +
        (sent
          ? CONVERSATION_LIMITS.progressMs
          : Math.min(5_000, 250 * 2 ** Math.min(retry.attempts++, 5)));
    }
  }

  private discard(): void {
    if (this.generation) this.retiredGeneration = this.generation;
    this.generation = null;
    this.revision = 0;
    this.lastBatch = null;
    this.retained = [];
    this.retainedBytes = 0;
    this.entries = Object.freeze([]);
    this.cursor = null;
    this.history = "complete";
    this.historyStatus = "idle";
    this.caughtUp = null;
    this.pendingHistory = null;
  }

  private hasHistoryRoom(): boolean {
    return (
      this.retained.length + CONVERSATION_LIMITS.entriesPerBatch <=
        CONVERSATION_LIMITS.retainedEntries &&
      this.retainedBytes + CONVERSATION_LIMITS.envelopeBytes <= CONVERSATION_LIMITS.retainedBytes
    );
  }

  private time(): number | null {
    try {
      const now = this.options.now();
      return Number.isFinite(now) ? now : null;
    } catch {
      return null;
    }
  }

  private send(message: ConversationMessage, closing = false): boolean {
    if ((this.closed && !closing) || this.sending) return false;
    this.sending = true;
    try {
      const sent = this.options.send(message);
      if (sent !== true && sent !== false) {
        // A malformed async adapter must not create an unhandled rejection.
        void Promise.resolve(sent).catch(() => {});
        return false;
      }
      return sent;
    } catch {
      return false;
    } finally {
      this.sending = false;
      if (this.cancelPending) {
        this.cancelPending = false;
        this.send(
          { type: "conversation.cancel", subscriptionId: this.options.subscriptionId },
          true,
        );
      }
    }
  }
}
