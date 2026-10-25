import { createHash } from "node:crypto";
import {
  CONVERSATION_LIMITS,
  type ConversationBatch,
  ConversationBatchSchema,
  type ConversationMessage,
  ConversationMessageSchema,
  type ConversationWireEntry,
  encodeCbor,
  StreamIdSchema,
} from "@shellbell/protocol";
import type {
  ConversationBranch,
  ConversationHistory,
  ConversationSnapshot,
  TranscriptPageAnchor,
} from "./transcript-document.js";
import type { TranscriptFollower, TranscriptPoll } from "./transcript-follower.js";

type Row = { local: string; id: string; hash: string };
const HISTORY_ANCESTORS = 4096;
type Projected = Row & {
  entry: Readonly<ConversationWireEntry>;
  anchor?: Readonly<TranscriptPageAnchor> | null;
};
type Cursor = { id: string; local: string; anchor: Readonly<TranscriptPageAnchor> | null };
type History = Extract<ConversationMessage, { type: "conversation.history.get" }>;
type Clear = Extract<ConversationMessage, { type: "conversation.clear" }>;
type Pending = {
  batch: ConversationBatch;
  proposed: Row[];
  branch: Readonly<ConversationBranch>;
  cursor: Cursor | null | undefined;
  sent: boolean;
  deadline: number;
  ancestors?: readonly Readonly<{ id: string; start: number }>[];
};
export interface AgentConversationOptions {
  subscriptionId: string;
  sessionId: string;
  now(): number;
  newId(): string;
  /** Includes route, focused session and owner consent; rechecked after every await. */
  enabled(): boolean;
  /** Shared follower pool/locator are owned by the coordinator, never by a retry. */
  follow(): TranscriptFollower | null;
  send(message: ConversationMessage): boolean;
  wake(): void;
}

/** One direct-route subscription. All native IDs and branch evidence stay computer-side.
 * The coordinator serializes work fairly; the background lane only calls synchronous offer(). */
export class AgentConversationStream {
  private readonly options: AgentConversationOptions;
  private closed = false;
  private ended = false;
  private follower: TranscriptFollower | null = null;
  private operation = false;
  private epoch = {};
  private due = 0;
  /** A catching-up reader has already said it is checking. */
  private checkingShown = false;
  private generation: string | null = null;
  private revision = 0;
  private appliedHistory: NonNullable<ConversationBatch["history"]> = "complete";
  private applied: Row[] = [];
  private branch: Readonly<ConversationBranch> | null = null;
  private projection: Projected[] = [];
  private projectionClipped = false;
  private snapshot: Readonly<ConversationSnapshot> | null = null;
  private snapshotCurrent = false;
  private discontinuity = 0;
  private pending: Pending | null = null;
  private cursor: Cursor | null = null;
  private history: History | null = null;
  private lastHistory: string | null = null;
  private lastHistoryResult: Extract<
    ConversationMessage,
    { type: "conversation.history.end" }
  > | null = null;
  private clear: { message: Clear; sent: boolean; deadline: number } | null = null;
  private afterClear: Clear["reason"] | null = null;
  private controls: ConversationMessage[] = [];
  private authorizedUntil = 0;
  private caughtUp = false;
  private lastStatusAt = 0;
  private lastSourceAt: number;
  private unlinkedHistory = false;
  private readonly historicalBranch = new Map<string, number>();

  constructor(options: AgentConversationOptions) {
    if (!StreamIdSchema.safeParse(options.subscriptionId).success)
      throw new TypeError("Invalid conversation subscription");
    this.options = { ...options };
    this.lastSourceAt = options.now();
    this.status("checking");
  }

  get sessionId(): string {
    return this.options.sessionId;
  }
  get subscriptionId(): string {
    return this.options.subscriptionId;
  }
  get needsWork(): boolean {
    return (
      !this.closed &&
      !this.ended &&
      !this.operation &&
      !this.clear &&
      this.options.enabled() &&
      this.options.now() >= this.due
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.discard();
    this.clear = null;
    this.controls = [];
  }

  invalidate(reason: Clear["reason"]): void {
    if (this.closed) return;
    this.ended ||= reason === "ended";
    if (this.ended) reason = "ended";
    this.discard();
    this.controls = [];
    // A clear already in flight remains the barrier. Its reason can only be changed before send.
    if (!this.clear?.sent)
      this.clear = {
        message: {
          type: "conversation.clear",
          subscriptionId: this.subscriptionId,
          clearId: this.id(),
          reason,
        },
        sent: false,
        deadline: 0,
      };
    else if (this.clear.message.reason !== reason) this.afterClear = reason;
    this.options.wake();
  }

  receive(message: ConversationMessage, envelopeBytes: number): void {
    if (this.closed || message.subscriptionId !== this.subscriptionId) return;
    if (
      !Number.isSafeInteger(envelopeBytes) ||
      envelopeBytes < 1 ||
      envelopeBytes > CONVERSATION_LIMITS.envelopeBytes ||
      !ConversationMessageSchema.safeParse(message).success
    ) {
      this.invalidate("unavailable");
      return;
    }
    if (message.type === "conversation.cancel") {
      this.close();
      return;
    }
    if (message.type === "conversation.cleared") {
      if (this.clear?.sent && message.clearId === this.clear.message.clearId) {
        this.clear = null;
        const after = this.afterClear;
        this.afterClear = null;
        if (after) {
          this.invalidate(after);
          return;
        }
        this.due = this.options.now();
        if (!this.options.enabled() && !this.ended) this.status("disabled");
      }
      return;
    }
    if (message.type === "conversation.refresh") {
      if (this.clear) {
        this.clear.deadline = 0;
        this.options.wake();
      } else if (!this.ended) this.invalidate(this.options.enabled() ? "changed" : "disabled");
      return;
    }
    if (!this.options.enabled() || this.clear) return;
    if (message.type === "conversation.applied") {
      this.appliedBatch(message);
      return;
    }
    if (message.type === "conversation.history.get") {
      if (message.generation !== this.generation) return;
      if (this.history?.requestId === message.requestId) return;
      if (this.history) {
        this.endHistory(message, "busy");
        return;
      }
      if (
        message.requestId === this.lastHistory &&
        this.lastHistoryResult?.requestId === message.requestId
      ) {
        this.queueControl(this.lastHistoryResult);
        return;
      }
      if (message.requestId === this.lastHistory || message.cursor !== this.cursor?.id) {
        this.endHistory(message, "changed");
        return;
      }
      this.history = { ...message };
      this.due = this.options.now();
    }
  }

  /** At most one follower operation. A stopped/retired await never restores held records. */
  async work(): Promise<void> {
    if (!this.needsWork) return;
    this.operation = true;
    const epoch = this.epoch;
    const current = () =>
      !this.closed && this.epoch === epoch && this.options.enabled() && !this.clear;
    try {
      this.follower ??= this.options.follow();
      if (!this.follower) {
        this.status("checking", "busy");
        this.due = this.options.now() + 1000;
        return;
      }
      const follower = this.follower;
      if (this.pending?.sent && this.options.now() < this.pending.deadline) {
        this.due = this.pending.deadline;
        return;
      }
      if (
        this.snapshotCurrent &&
        this.snapshot &&
        this.history &&
        !this.pending &&
        this.cursor?.anchor &&
        follower.older &&
        this.applied[0]?.local === this.cursor.local &&
        this.projection.findIndex((row) => row.local === this.cursor!.local) <= 0
      ) {
        const result = await follower.older(this.cursor.anchor);
        if (!current() || this.follower !== follower) return;
        this.due = this.options.now() + 200;
        if (result.status === "stopped") this.stopped(result.reason);
        else if (result.status === "refresh") this.snapshotCurrent = false;
        else if (result.status === "busy") this.waitingForSource();
        else if (result.status === "reading") {
          // A page past large records takes many reads; the phone gives up after progressMs.
          this.waitingForSource();
          this.due = this.options.now();
        } else if (result.status === "unavailable") this.finishHistory("unavailable");
        else if (result.status === "page") {
          const ancestors = result.branch?.kind === "claude" ? result.branch.nodes : [];
          const knownBranches = [
            this.historicalBranch,
            new Map(
              this.branch?.kind === "claude"
                ? this.branch.nodes.map((node) => [node.id, node.start])
                : [],
            ),
            new Map(
              this.snapshot.branch?.kind === "claude"
                ? this.snapshot.branch.nodes.map((node) => [node.id, node.start])
                : [],
            ),
          ];
          if (
            ancestors.some((node) =>
              knownBranches.some(
                (known) => known.has(node.id) && known.get(node.id) !== node.start,
              ),
            )
          ) {
            this.invalidate("changed");
            return;
          }
          if (
            new Set([...this.historicalBranch.keys(), ...ancestors.map((node) => node.id)]).size >
            HISTORY_ANCESTORS
          ) {
            this.finishHistory("unavailable");
            return;
          }
          this.unlinkedHistory ||= result.history === "unlinked";
          this.lastSourceAt = this.options.now();
          this.authorizedUntil = this.options.now() + 200;
          this.caughtUp = false;
          if (!result.entries.length)
            this.finishHistory(
              result.history === "complete" && !this.unlinkedHistory ? "complete" : "unavailable",
            );
          else {
            const known = new Map(
              [...this.applied, ...this.projection].map((row) => [row.local, row.id]),
            );
            const rows = result.entries.map(({ entry: source, anchor }) => {
              const id = known.get(source.id) ?? this.id();
              const entry = Object.freeze({ ...source, id });
              const bytes = encodeCbor(entry);
              const hash = createHash("sha256").update(bytes).digest("base64url");
              bytes.fill(0);
              return { local: source.id, id, hash, entry, anchor };
            });
            const request = this.history;
            const first = this.applied[0]!;
            const page = this.page(rows, "prepend", first.id, request.requestId);
            if (!page.length) this.finishHistory("unavailable");
            else
              this.queue(
                "prepend",
                page,
                this.applied,
                first.id,
                request.requestId,
                undefined,
                [],
                {
                  history: this.unlinkedHistory ? "unlinked" : result.history,
                  more: page.length < rows.length || (result.more ?? result.history !== "complete"),
                  ancestors,
                },
              );
          }
          this.options.wake();
        }
        return;
      }
      if (
        this.snapshotCurrent &&
        this.snapshot &&
        (this.pending || this.history || this.hasUpdate())
      ) {
        const proof = await follower.confirm(this.snapshot.revision);
        if (!current() || this.follower !== follower) return;
        if (proof.status === "confirmed") {
          this.lastSourceAt = this.options.now();
          this.caughtUp = proof.caughtUp;
          this.authorizedUntil = this.options.now() + 200;
          this.prepare();
          this.due = this.options.now() + 200;
          this.options.wake();
          return;
        }
        if (proof.status === "stopped") {
          this.stopped(proof.reason);
          return;
        }
        if (proof.status === "busy") {
          this.waitingForSource();
          return;
        }
        // Parsing a newer read invalidates a projection without changing source ownership.
        // Refresh from the applied baseline; never clear rows just because history was requested.
        if (this.pending?.sent) this.invalidate("changed");
        else {
          this.pending = null;
          this.snapshotCurrent = false;
          this.due = this.options.now() + 200;
        }
        return;
      }
      const result = await follower.poll();
      if (!current() || this.follower !== follower) return;
      this.accept(result);
    } catch {
      if (current()) this.invalidate("unavailable");
    } finally {
      this.operation = false;
    }
  }

  /** Called only by the route-owned background scheduler. Returns one actual admission. */
  offer(): boolean {
    if (this.closed) return false;
    const now = this.options.now();
    if (this.clear) {
      const pending = this.clear;
      if (pending.sent && now < pending.deadline) return false;
      const sent = this.send(pending.message);
      if (this.clear === pending && sent) {
        pending.sent = true;
        pending.deadline = now + CONVERSATION_LIMITS.progressMs;
      }
      return sent;
    }
    if (this.controls.length) {
      const message =
        this.controls.find((value) => value.type === "conversation.history.end") ??
        this.controls[0]!;
      if (
        message.type === "conversation.status" &&
        message.state === "ready" &&
        (!this.options.enabled() || now > this.authorizedUntil)
      )
        return false;
      const sent = this.send(message);
      if (sent) this.controls = this.controls.filter((value) => value !== message);
      return sent;
    }
    const pending = this.pending;
    if (
      !pending ||
      !this.options.enabled() ||
      now > this.authorizedUntil ||
      (pending.sent && now < pending.deadline)
    )
      return false;
    const sent = this.send(pending.batch);
    if (this.pending === pending && sent) {
      pending.sent = true;
      pending.deadline = now + CONVERSATION_LIMITS.progressMs;
      this.due = pending.deadline;
    }
    return sent;
  }

  /** Clear/control retries do not require file work or consent. */
  tick(): void {
    if (this.closed) return;
    if (!this.options.enabled() && (this.follower || this.generation || this.pending))
      this.invalidate("disabled");
    if (this.clear && this.options.now() >= this.clear.deadline) this.options.wake();
    else if (this.controls.length) this.options.wake();
  }

  private accept(result: TranscriptPoll): void {
    this.due = this.options.now() + 200;
    if (result.status === "busy") {
      this.waitingForSource();
      return;
    }
    if (result.status === "stopped") {
      this.stopped(result.reason);
      return;
    }
    if (result.discontinuity !== this.discontinuity && this.generation) {
      this.invalidate("skipped");
      return;
    }
    this.discontinuity = result.discontinuity;
    if (result.status === "catching-up") {
      this.snapshotCurrent = false;
      // Once per reader: an 8 MiB catch-up is over a hundred immediate reads.
      if (!this.generation) {
        if (!this.checkingShown) this.status("checking");
        this.checkingShown = true;
      } else this.waitingForSource();
      // With unread bytes, read on at the next fair turn. Without, such as a first line still
      // being written, keep the usual pause rather than re-reading the file in a tight loop.
      if (result.pending) this.due = this.options.now();
      return;
    }
    this.lastSourceAt = this.options.now();
    const snapshot = result.snapshot;
    if (snapshot.state !== "ready" || !snapshot.branch) {
      if (this.generation) this.invalidate("unavailable");
      else {
        this.status("unavailable", snapshot.state === "unsupported" ? "unsupported" : "unbound");
        this.due = this.options.now() + 5000;
      }
      return;
    }
    if (this.branch?.kind === "claude") {
      const previous = this.branch.nodes.at(-1);
      if (
        snapshot.branch.kind !== "claude" ||
        !previous ||
        ![...snapshot.branch.nodes, ...(snapshot.branch.parallel ?? [])].some(
          (node) => node.id === previous.id && node.start === previous.start,
        )
      ) {
        const evicted =
          snapshot.branch.kind === "claude" &&
          previous &&
          snapshot.history !== "complete" &&
          (snapshot.branch.nodes[0]?.start ?? 0) > previous.start;
        this.invalidate(evicted ? "skipped" : "changed");
        return;
      }
      const prior = new Map(this.branch.nodes.map((node) => [node.id, node.start] as const));
      if (
        snapshot.branch.nodes.some(
          (node) =>
            (prior.has(node.id) && prior.get(node.id) !== node.start) ||
            (this.historicalBranch.has(node.id) &&
              this.historicalBranch.get(node.id) !== node.start),
        )
      ) {
        this.invalidate("changed");
        return;
      }
    }
    // A document reuses its immutable entries on idle polls. Keep their wire IDs
    // and encodings while refreshing branch/revision evidence and authorization.
    if (snapshot.entries !== this.snapshot?.entries) {
      const known = new Map(
        [...this.applied, ...this.projection].map((row) => [row.local, row.id]),
      );
      const rows: Projected[] = [];
      let bytes = 0;
      this.projectionClipped = false;
      for (let index = snapshot.entries.length - 1; index >= 0; index--) {
        const source = snapshot.entries[index]!;
        if (source.id.startsWith("history:")) continue;
        const id = known.get(source.id) ?? this.id();
        const entry = Object.freeze({ ...source, id });
        const encoded = encodeCbor(entry);
        bytes += encoded.byteLength;
        const hash = createHash("sha256").update(encoded).digest("base64url");
        encoded.fill(0);
        if (
          // Reserve one atomic page from the same total plaintext queue budget.
          bytes > CONVERSATION_LIMITS.queuedBytes - CONVERSATION_LIMITS.batchBytes ||
          rows.length >= CONVERSATION_LIMITS.retainedEntries
        ) {
          this.projectionClipped = true;
          break;
        }
        rows.push({ local: source.id, id, hash, entry });
      }
      rows.reverse();
      // Clipping can leave a row older pages can't start from at the top. Start at the first
      // row they can, so the rows before it come back as an older page instead of being lost.
      const anchor = this.follower?.anchor;
      if (this.projectionClipped && anchor) {
        const first = rows.findIndex(
          (row) => anchor.call(this.follower, snapshot.revision, row.local) !== null,
        );
        if (first > 0) rows.splice(0, first);
      }
      this.projection = rows;
    }
    this.snapshot = this.projectionClipped ? { ...snapshot, history: "truncated" } : snapshot;
    this.snapshotCurrent = true;
    this.caughtUp = result.caughtUp;
    this.authorizedUntil = 0;
    if (!this.generation) this.generation = this.id();
    if (!this.hasUpdate() && !this.history) {
      // Revalidate before advertising source liveness, even for an unchanged projection.
      this.due = this.options.now() + 1000;
      if (this.options.now() - this.lastStatusAt >= 2000) this.historyStatusProbe();
    }
  }

  private waitingForSource(): void {
    this.due = this.options.now() + 200;
    if (this.options.now() - this.lastSourceAt >= CONVERSATION_LIMITS.progressMs)
      this.status("checking", "busy");
  }

  private historyStatusProbe(): void {
    // A pending status makes work() confirm the current revision on its next fair turn.
    this.authorizedUntil = 0;
    this.queueControl({
      type: "conversation.status",
      subscriptionId: this.subscriptionId,
      state: "ready",
      caughtUp: this.caughtUp,
    });
    this.due = this.options.now();
  }

  private hasUpdate(): boolean {
    if (!this.generation || this.revision === 0) return true;
    if (
      this.controls.some((value) => value.type === "conversation.status" && value.state === "ready")
    )
      return true;
    return this.update() !== null;
  }

  /** Preserve loaded older rows outside the current source window; replace only a proven suffix. */
  private update(): {
    at: number;
    rows: Projected[];
    after: number;
    reset?: "skipped" | "changed";
  } | null {
    if (!this.applied.length)
      return this.projection.length ? { at: 0, rows: this.projection, after: 0 } : null;
    const positions = new Map(this.applied.map((row, index) => [row.local, index]));
    let start = this.projection.findIndex((row) => positions.has(row.local));
    if (start < 0) return { at: -1, rows: [], after: 0, reset: "skipped" };
    let at = positions.get(this.projection[start]!.local)!;
    // A complete applied prefix can gain notices/groups or lose superseded entries.
    // An unloaded prefix remains demand-paged; it must not be inserted as live output.
    if (this.appliedHistory === "complete") {
      if (this.snapshot?.history === "complete" && (start > 0 || at > 0))
        return { at: 0, rows: this.projection.slice(0, start), after: at };
      if (start > 0) return { at, rows: this.projection.slice(0, start), after: at };
    }
    while (
      start < this.projection.length &&
      at < this.applied.length &&
      this.projection[start]!.local === this.applied[at]!.local &&
      this.projection[start]!.hash === this.applied[at]!.hash
    ) {
      start++;
      at++;
    }
    if (start === this.projection.length)
      return at === this.applied.length ? null : { at, rows: [], after: this.applied.length };
    const first = this.projection[start]!;
    if (this.applied[at]?.local === first.local) return { at, rows: [first], after: at + 1 };
    const later = positions.get(first.local);
    if (later !== undefined)
      return later > at
        ? { at, rows: [], after: later }
        : { at: -1, rows: [], after: 0, reset: "changed" };
    let end = start;
    while (end < this.projection.length && !positions.has(this.projection[end]!.local)) end++;
    return { at, rows: this.projection.slice(start, end), after: at };
  }

  private prepare(): void {
    if (this.pending || !this.snapshot?.branch || !this.generation) return;
    if (
      this.controls.some((value) => value.type === "conversation.status" && value.state === "ready")
    ) {
      this.queueControl({
        type: "conversation.status",
        subscriptionId: this.subscriptionId,
        state: "ready",
        caughtUp: this.caughtUp,
      });
      this.lastStatusAt = this.options.now();
    }
    if (this.history) {
      const request = this.history;
      const first = this.applied[0];
      const index = this.projection.findIndex((row) => row.local === first?.local);
      if (!first || index < 0 || first.local !== this.cursor?.local) {
        this.finishHistory("changed");
        return;
      }
      if (index === 0) {
        this.finishHistory(this.snapshot.history === "complete" ? "complete" : "unavailable");
        return;
      }
      const rows = this.page(
        this.projection.slice(0, index),
        "prepend",
        first.id,
        request.requestId,
      );
      this.queue("prepend", rows, this.applied, first.id, request.requestId);
      return;
    }
    if (this.revision === 0) {
      this.queue("reset", this.page(this.projection, "reset"), []);
      return;
    }
    const update = this.update();
    if (!update) {
      this.branch = this.snapshot.branch;
      return;
    }
    if (update.at < 0) {
      this.invalidate(update.reset ?? "changed");
      return;
    }
    const anchor = this.applied[update.at - 1]?.id ?? null;
    const after = this.applied[update.after]?.id ?? null;
    this.queue(
      "patch",
      this.page(update.rows, "patch", anchor, undefined, after),
      this.applied.slice(0, update.at),
      anchor,
      undefined,
      after,
      this.applied.slice(update.after),
    );
  }

  private page(
    source: Projected[],
    operation: ConversationBatch["operation"],
    anchor?: string | null,
    requestId?: string,
    after?: string | null,
  ): Projected[] {
    const rows: Projected[] = [];
    const newestFirst = operation !== "patch";
    for (let i = 0; i < Math.min(source.length, CONVERSATION_LIMITS.entriesPerBatch); i++) {
      const row = source[newestFirst ? source.length - i - 1 : i]!;
      const next = newestFirst ? [row, ...rows] : [...rows, row];
      const batch = this.message(operation, next, anchor, requestId, "0".repeat(22), after);
      if (encodeCbor(batch).byteLength > CONVERSATION_LIMITS.batchBytes) break;
      rows.splice(0, rows.length, ...next);
    }
    return rows;
  }

  private message(
    operation: ConversationBatch["operation"],
    rows: Projected[],
    anchor?: string | null,
    requestId?: string,
    cursor: string | null = null,
    after?: string | null,
  ): ConversationBatch {
    return {
      type: "conversation.batch",
      subscriptionId: this.subscriptionId,
      generation: this.generation!,
      batchId: "0".repeat(22),
      baseRevision: this.revision,
      revision: this.revision + 1,
      operation,
      ...(operation !== "reset" && { anchor: anchor ?? null }),
      ...(requestId && { requestId }),
      ...(after !== undefined && { after }),
      entries: rows.map((row) => row.entry),
      ...(operation !== "patch" && {
        olderCursor: cursor,
        history: cursor ? "unloaded" : this.snapshot!.history,
      }),
    };
  }

  private queue(
    operation: ConversationBatch["operation"],
    rows: Projected[],
    retained: Row[],
    anchor?: string | null,
    requestId?: string,
    after?: string | null,
    suffix: Row[] = [],
    physical?: {
      history: ConversationHistory;
      more: boolean;
      ancestors?: readonly Readonly<{ id: string; start: number }>[];
    },
  ): void {
    const metadata = rows.map(({ local, id, hash }) => ({ local, id, hash }));
    const proposed =
      operation === "prepend" ? [...metadata, ...retained] : [...retained, ...metadata, ...suffix];
    if (new Set(proposed.map((row) => row.local)).size !== proposed.length) {
      if (operation === "prepend") this.finishHistory("changed");
      else this.invalidate("changed");
      return;
    }
    const before = this.projection.findIndex((row) => row.local === proposed[0]?.local);
    const first = proposed[0];
    // The synthetic side-chain notice describes the whole window, not a content boundary.
    const boundary = first?.local === "unlinked-side" ? proposed[1] : first;
    const physicalAnchor = boundary
      ? (rows.find((row) => row.local === boundary.local)?.anchor ??
        this.follower?.anchor?.(this.snapshot!.revision, boundary.local) ??
        null)
      : null;
    const more = physical ? physical.more : before > 0 || this.snapshot!.history !== "complete";
    const cursor =
      operation === "patch"
        ? undefined
        : first && more && (before > 0 || physicalAnchor)
          ? { id: this.id(), local: first.local, anchor: physicalAnchor }
          : null;
    const batch = {
      ...this.message(operation, rows, anchor, requestId, cursor?.id, after),
      batchId: this.id(),
      ...(physical && {
        history:
          physical.history === "unlinked"
            ? ("unlinked" as const)
            : cursor || physical.more
              ? ("unloaded" as const)
              : physical.history,
      }),
    };
    if (!ConversationBatchSchema.safeParse(batch).success) {
      this.invalidate("unavailable");
      return;
    }
    this.pending = {
      batch,
      proposed,
      branch: this.snapshot!.branch!,
      cursor,
      sent: false,
      deadline: 0,
      ...(physical?.ancestors && { ancestors: physical.ancestors }),
    };
    this.queueControl({
      type: "conversation.status",
      subscriptionId: this.subscriptionId,
      state: "ready",
      caughtUp: this.caughtUp,
    });
  }

  private appliedBatch(
    message: Extract<ConversationMessage, { type: "conversation.applied" }>,
  ): void {
    const pending = this.pending;
    if (
      !pending?.sent ||
      message.generation !== this.generation ||
      message.batchId !== pending.batch.batchId ||
      message.revision !== pending.batch.revision
    )
      return;
    const start =
      message.retainedCount === 0
        ? pending.proposed.length
        : pending.proposed.findIndex((row) => row.id === message.oldestId);
    if (
      start < 0 ||
      pending.proposed.length - start !== message.retainedCount ||
      (pending.proposed.at(-1)?.id ?? null) !== message.newestId
    ) {
      this.invalidate("unavailable");
      return;
    }
    this.applied = pending.proposed.slice(start);
    for (const node of pending.ancestors ?? []) this.historicalBranch.set(node.id, node.start);
    this.branch = pending.branch;
    this.revision = message.revision;
    if (pending.batch.history !== undefined) this.appliedHistory = pending.batch.history;
    if (start > 0) this.appliedHistory = "unloaded";
    if (pending.cursor !== undefined) this.cursor = pending.cursor;
    if (this.applied[0]?.local !== this.cursor?.local) this.cursor = null;
    if (pending.batch.operation === "prepend") {
      this.lastHistory = pending.batch.requestId!;
      this.lastHistoryResult = null;
      this.history = null;
    }
    this.pending = null;
    this.due = this.options.now();
  }

  private finishHistory(
    reason: Extract<ConversationMessage, { type: "conversation.history.end" }>["reason"],
  ): void {
    this.follower?.cancelOlder?.();
    if (reason === "complete") {
      this.appliedHistory = "complete";
      this.cursor = null;
    } else if (reason === "changed") this.cursor = null;
    const history = this.history!;
    this.history = null;
    this.lastHistory = history.requestId;
    this.endHistory(history, reason);
    this.lastHistoryResult = {
      type: "conversation.history.end",
      subscriptionId: this.subscriptionId,
      generation: history.generation,
      requestId: history.requestId,
      reason,
    };
  }
  private endHistory(
    request: History,
    reason: Extract<ConversationMessage, { type: "conversation.history.end" }>["reason"],
  ): void {
    this.queueControl({
      type: "conversation.history.end",
      subscriptionId: this.subscriptionId,
      generation: request.generation,
      requestId: request.requestId,
      reason,
    });
  }
  private stopped(reason: string): void {
    if (this.generation)
      this.invalidate(
        reason === "disabled" ? "disabled" : reason === "changed" ? "changed" : "unavailable",
      );
    else {
      this.discard();
      this.status(
        reason === "disabled" ? "disabled" : "unavailable",
        reason === "unbound" ? "unbound" : reason === "unsupported" ? "unsupported" : "source",
      );
      // A missing identity also covers a busy shared native probe or a timed-out lookup.
      // Retry at a bounded rate while watched; only a proven unsupported format is terminal.
      this.due = reason === "unsupported" ? Infinity : this.options.now() + 5000;
    }
  }
  private status(
    state: "checking" | "unavailable" | "disabled",
    reason?: "busy" | "unbound" | "unsupported" | "source",
  ): void {
    this.queueControl({
      type: "conversation.status",
      subscriptionId: this.subscriptionId,
      state,
      ...(reason && { reason }),
    });
  }

  private queueControl(message: ConversationMessage): void {
    if (message.type === "conversation.status")
      this.controls = this.controls.filter((value) => value.type !== "conversation.status");
    else if (
      message.type === "conversation.history.end" &&
      this.controls.some(
        (value) =>
          value.type === "conversation.history.end" &&
          value.generation === message.generation &&
          value.requestId === message.requestId,
      )
    )
      return;
    if (this.controls.length >= 4)
      this.controls = this.controls.filter((value) => value.type !== "conversation.status");
    if (this.controls.length < 4) this.controls.push(message);
    this.options.wake();
  }
  private discard(): void {
    this.checkingShown = false;
    this.epoch = {};
    this.follower?.close();
    this.follower = null;
    this.generation = null;
    this.revision = 0;
    this.appliedHistory = "complete";
    this.applied = [];
    this.branch = null;
    this.projection = [];
    this.projectionClipped = false;
    this.snapshot = null;
    this.snapshotCurrent = false;
    this.pending = null;
    this.cursor = null;
    this.history = null;
    this.lastHistory = null;
    this.lastHistoryResult = null;
    this.authorizedUntil = 0;
    this.discontinuity = 0;
    this.unlinkedHistory = false;
    this.historicalBranch.clear();
  }
  private id(): string {
    const id = this.options.newId();
    if (!StreamIdSchema.safeParse(id).success) throw new TypeError("Invalid conversation ID");
    return id;
  }
  private send(message: ConversationMessage): boolean {
    try {
      const result = this.options.send(message);
      if (result !== true && result !== false) {
        void Promise.resolve(result).catch(() => {});
        return false;
      }
      return result;
    } catch {
      return false;
    }
  }
}
