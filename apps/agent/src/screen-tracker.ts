import {
  type Cursor,
  encodeCbor,
  type InnerMessage,
  type InnerMessageOf,
  type Line,
  lineKey,
  stripStyles,
} from "@shellbell/protocol";
import {
  type HistoryCapture,
  type Screen,
  SessionGone,
  type TerminalBackend,
} from "./backends/types.js";
import { type Logger, safeErrorName } from "./log.js";

export interface ScreenFrameContext {
  readonly generation: number;
  readonly reported: number;
  readonly historyRequested: boolean;
  readonly capture?: HistoryCapture;
}

export interface ScreenViewerOptions {
  readonly history?: boolean;
  readonly preparation?: "legacy" | "bounded";
}

interface ScreenTrackerCommonOptions {
  backend: TerminalBackend;
  log: Logger;
  intervalMs?: number;
  maxFramesPerSecond?: number;
  maxEncodedBytes?: number;
  now?: () => number;
  /** Called when `getScreen` reports the session is truly gone (Task 10 wires this to `sessions`). */
  onSessionGone?: (sessionId: string, removedConnections: readonly string[]) => void;
}

export type ScreenTrackerOptions = ScreenTrackerCommonOptions &
  (
    | {
        delivery?: "automatic";
        // biome-ignore lint/suspicious/noConfusingVoidType: void preserves existing callback compatibility.
        sink: (connId: string, msg: InnerMessage, context: ScreenFrameContext) => boolean | void;
        onReady?: never;
      }
    | { delivery: "scheduled"; onReady: (sessionId: string) => void; sink?: never }
  );

interface PreparedFrame {
  gen: number;
  diff: InnerMessage;
  forceSnapshotAll: boolean;
  snapshotFor: (degraded: boolean) => InnerMessage;
  fullSnapshot: () => InnerMessageOf<"screen.snapshot">;
  snapshotContext: ScreenFrameContext;
  diffContext: ScreenFrameContext;
  historyViewers: Set<ViewerState>;
}

interface ViewerState {
  lastSentGen: number;
  forceSnapshot: boolean;
  skipped: number;
  needsHistory: boolean;
  offering: boolean;
  preparation: "legacy" | "bounded";
}

interface SessionState {
  viewers: Map<string, ViewerState>;
  dirty: boolean;
  inflight: boolean;
  lastKeys: string[];
  lastCols: number;
  lastRows: number;
  lastCursor: Cursor | null;
  lastBackendScrollback: number | null;
  reported: number;
  gen: number;
  /** Round-robin start offset for fair tie-breaking under a scarce frame budget. */
  rrOffset: number;
  /** Set once we've logged that even a stripped snapshot exceeds `maxEncodedBytes`. */
  oversizeWarned: boolean;
  prepared: PreparedFrame | null;
  inflightViewers: Set<ViewerState> | null;
}

interface Budget {
  /** Tokens available right now; refilled continuously, capped at `maxFramesPerSecond`. */
  tokens: number;
  last: number;
}

const SNAPSHOT_RATIO = 0.6;
const OVERLAP_MAX_SHIFT = 16;
const OVERLAP_MIN_MATCH = 0.8;
/** Consecutive coalesced ticks after which a viewer's catch-up frame is sent degraded. */
const COALESCE_DEGRADE_TICKS = 3;

export class ScreenTracker {
  offerPrepared(
    connId: string,
    sink: (message: InnerMessage, context: ScreenFrameContext) => boolean,
  ): boolean {
    if (this.opts.delivery !== "scheduled" || this.stopped) return false;
    const sessionId = this.viewerSession.get(connId);
    if (!sessionId) return false;
    const s = this.sessions.get(sessionId);
    const v = s?.viewers.get(connId);
    const frame = s?.prepared;
    if (!s || !v || !frame || v.offering) return false;
    if (v.needsHistory && !frame.historyViewers.has(v)) {
      s.dirty = true;
      return false;
    }
    if (v.lastSentGen === frame.gen && !v.forceSnapshot) return false;
    const owns = () =>
      !this.stopped &&
      this.sessions.get(sessionId) === s &&
      s.prepared === frame &&
      s.viewers.get(connId) === v;
    v.offering = true;
    try {
      const bounded = v.preparation === "bounded";
      const starved = !bounded && v.skipped >= COALESCE_DEGRADE_TICKS;
      const adjacent =
        v.lastSentGen === frame.gen - 1 && !v.forceSnapshot && !frame.forceSnapshotAll && !starved;
      const message = adjacent
        ? frame.diff
        : bounded
          ? frame.fullSnapshot()
          : frame.snapshotFor(starved);
      const context = adjacent ? frame.diffContext : frame.snapshotContext;
      const accepted: unknown = sink(message, context);
      if (accepted !== true && accepted !== false) {
        observeRejection(accepted);
        throw new TypeError("scheduled screen offer requires a synchronous boolean");
      }
      if (accepted === true) {
        if (owns()) {
          v.lastSentGen = frame.gen;
          v.forceSnapshot = false;
          v.skipped = 0;
          if (!adjacent) v.needsHistory = false;
        }
        return true;
      }
      if (owns()) v.forceSnapshot = true;
      return false;
    } catch {
      if (owns()) v.forceSnapshot = true;
      throw new TypeError("scheduled screen offer failed");
    } finally {
      v.offering = false;
    }
  }
  private readonly sessions = new Map<string, SessionState>();
  private sessionOffset = 0;
  private scheduledCycle = 0;
  private lastReadinessCycle = 0;
  private readonly viewerSession = new Map<string, string>();
  /** ONE bucket for every sink call: they all share the agent's single relay socket. */
  private readonly budget: Budget;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  /** Guards against a `getScreen` in flight at `stop()` time still reaching the sink. */
  private stopped = true;
  /** Last watched set pushed to the backend, joined; guards against re-sending an equal set. */
  private watchedKey = "";
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: ScreenTrackerOptions) {
    this.intervalMs = Math.max(125, opts.intervalMs ?? 125);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "tracker" });
    this.budget = { tokens: 0, last: this.now() };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // The tracker subscribes to the backend itself: `screen-changed` is the only event that means
    // "there is new output", and `session-removed` is the only one that invalidates our state.
    this.unsubscribe ??= this.opts.backend.on((e) => {
      if (e.type === "screen-changed") this.markDirty(e.sessionId);
      else if (e.type === "session-removed") this.sessionRemoved(e.sessionId);
    });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.sessions.values()) {
      s.prepared = null;
      s.inflightViewers?.clear();
      s.inflightViewers = null;
      if (s.viewers.size > 0) s.dirty = true;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    // A stopped tracker must never leave a backend polling on our behalf.
    this.watchedKey = "stopped";
    try {
      this.opts.backend.setWatched?.([]);
    } catch (err) {
      this.log.warn("setWatched failed", { err: safeErrorName(err) });
    }
  }

  setIntervalMs(ms: number): void {
    const next = Math.max(125, ms);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  setViewed(connId: string, sessionId: string | null, options?: ScreenViewerOptions): void {
    if (sessionId) {
      const preparation = options?.preparation === undefined ? "legacy" : options.preparation;
      if (preparation !== "legacy" && preparation !== "bounded") {
        throw new TypeError("invalid screen preparation");
      }
      if (preparation === "bounded" && this.opts.delivery !== "scheduled") {
        throw new TypeError("bounded screen preparation requires scheduled delivery");
      }
    }
    const prev = this.viewerSession.get(connId);
    if (prev) {
      const previous = this.sessions.get(prev);
      const viewer = previous?.viewers.get(connId);
      if (viewer) {
        previous?.prepared?.historyViewers.delete(viewer);
        previous?.inflightViewers?.delete(viewer);
      }
      previous?.viewers.delete(connId);
      if (previous?.viewers.size === 0) {
        previous.prepared = null;
        previous.inflightViewers = null;
      }
      this.viewerSession.delete(connId);
    }
    if (sessionId) {
      const s = this.state(sessionId);
      s.viewers.set(connId, {
        lastSentGen: -1,
        forceSnapshot: true,
        skipped: 0,
        needsHistory: options?.history === true,
        offering: false,
        preparation: options?.preparation ?? "legacy",
      });
      s.dirty = true;
      this.viewerSession.set(connId, sessionId);
    }
    this.pushWatched();
  }

  dropViewer(connId: string): void {
    this.setViewed(connId, null);
  }

  viewedBy(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId)?.viewers.keys() ?? [])];
  }

  markDirty(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.viewers.size > 0) s.dirty = true;
  }

  forceSnapshot(connId: string, sessionId: string): void {
    const v = this.sessions.get(sessionId)?.viewers.get(connId);
    if (!v) return;
    v.forceSnapshot = true;
    (this.sessions.get(sessionId) as SessionState).dirty = true;
  }

  sessionRemoved(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.prepared = null;
      s.inflightViewers?.clear();
      s.inflightViewers = null;
    }
    if (!s) return;
    const removedConnections = [...s.viewers.keys()];
    for (const conn of removedConnections) this.viewerSession.delete(conn);
    this.sessions.delete(sessionId);
    this.pushWatched();
    try {
      observeRejection(this.opts.onSessionGone?.(sessionId, removedConnections));
    } catch {
      // Removal is complete; an observer cannot undo it or block other sessions.
    }
  }

  /**
   * tells the backend which sessions at least one phone is viewing, via the optional
   * `TerminalBackend.setWatched?` hook. No shipped backend implements it any more -- herdr's
   * change detection is fully event-driven off `pane_updated.pane.revision` for every pane,
   * watched or not -- but the hook and this fan-out stay for a future
   * backend that needs to know. The full set is sent every time it changes, never a delta.
   */
  private pushWatched(): void {
    const ids = [...this.sessions.entries()]
      .filter(([, s]) => s.viewers.size > 0)
      .map(([id]) => id)
      .sort();
    const key = ids.join(" ");
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    try {
      this.opts.backend.setWatched?.(ids);
    } catch (err) {
      this.log.warn("setWatched failed", { err: safeErrorName(err) });
    }
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        viewers: new Map(),
        dirty: false,
        inflight: false,
        lastKeys: [],
        lastCols: 0,
        lastRows: 0,
        lastCursor: null,
        lastBackendScrollback: null,
        reported: 0,
        gen: 0,
        rrOffset: 0,
        oversizeWarned: false,
        prepared: null,
        inflightViewers: null,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private async tick(): Promise<void> {
    if (this.opts.delivery === "scheduled") {
      this.tickScheduled();
      return;
    }
    const entries = [...this.sessions.entries()];
    if (entries.length === 0) return;
    const offset = this.sessionOffset % entries.length;
    const ordered = entries.slice(offset).concat(entries.slice(0, offset));

    for (const entry of ordered) {
      const [sessionId, s] = entry;
      if (this.stopped) return;
      if (s.inflight || s.viewers.size === 0) continue;
      if (s.dirty) {
        s.inflight = true;
        s.dirty = false;
        // Eligibility belongs to the viewer objects present before the native await.
        const historyViewers = new Set([...s.viewers.values()].filter((v) => v.needsHistory));
        const historyRequested = historyViewers.size > 0;
        s.inflightViewers = historyViewers;
        let screen: Screen;
        try {
          screen = historyRequested
            ? await this.opts.backend.getScreen(sessionId, { history: true })
            : await this.opts.backend.getScreen(sessionId);
        } catch (err) {
          // A stopped tracker or remove/recreate makes this rejection obsolete just like a
          // successful capture below. Release the old state without mutating its replacement.
          if (
            !this.stopped &&
            this.sessions.get(sessionId) === s &&
            s.inflightViewers === historyViewers
          ) {
            if (err instanceof SessionGone) {
              this.log.warn("getScreen: session gone; dropping", {
                session: sessionId.slice(0, 12),
              });
              this.sessionRemoved(sessionId);
            } else {
              // Transient error (RPC timeout, etc.): keep viewers, resync everyone next tick.
              this.log.warn("getScreen failed; will retry", {
                session: sessionId.slice(0, 12),
                err: safeErrorName(err),
              });
              for (const v of s.viewers.values()) v.forceSnapshot = true;
              s.dirty = true;
            }
          }
          s.inflightViewers = null;
          s.inflight = false;
          continue;
        }
        // A `stop()` or remove/recreate may have landed while `getScreen` was in flight: never
        // commit that obsolete capture or let it reach the sink.
        if (
          this.stopped ||
          this.sessions.get(sessionId) !== s ||
          s.inflightViewers !== historyViewers
        ) {
          s.inflight = false;
          continue;
        }
        try {
          this.processScreen(sessionId, s, screen, historyViewers, historyRequested);
        } catch (err) {
          // Diff preparation failed after getScreen succeeded. Retry a fresh capture and force a
          // snapshot, but keep delivery failures below separate from backend polling.
          this.log.error("processScreen threw; will resync every viewer next tick", {
            session: sessionId.slice(0, 12),
            err: safeErrorName(err),
          });
          for (const v of s.viewers.values()) v.forceSnapshot = true;
          s.dirty = true;
          continue;
        } finally {
          s.inflightViewers = null;
          s.inflight = false;
        }
      }
      let tokenSpent = false;
      try {
        tokenSpent = this.deliver(sessionId, s);
      } catch (err) {
        // Fallible frame construction and the sink both happen after spending. Count that refused
        // send so the same session cannot monopolize each subsequent refill.
        tokenSpent = true;
        // Keep the prepared generation and viewer state intact so the next tick can retry without
        // manufacturing another backend capture.
        this.log.error("screen delivery threw; will retry prepared generation", {
          session: sessionId.slice(0, 12),
          err: safeErrorName(err),
        });
      }
      if (tokenSpent) this.sessionOffset = (entries.indexOf(entry) + 1) % entries.length;
    }
  }

  private tickScheduled(): void {
    const entries = [...this.sessions.entries()];
    if (entries.length === 0) return;
    const offset = this.sessionOffset % entries.length;
    const cycle = ++this.scheduledCycle;
    const nextOffset = (offset + 1) % entries.length;
    for (const entry of entries.slice(offset).concat(entries.slice(0, offset))) {
      const [sessionId, s] = entry;
      if (this.stopped) return;
      if (s.inflight || s.viewers.size === 0) continue;
      if (s.dirty) {
        void this.captureScheduled(sessionId, s, cycle, nextOffset);
      } else {
        this.notifyScheduled(sessionId, s, cycle, nextOffset);
      }
    }
  }

  private async captureScheduled(
    sessionId: string,
    s: SessionState,
    cycle: number,
    nextOffset: number,
  ): Promise<void> {
    s.inflight = true;
    s.dirty = false;
    const historyViewers = new Set([...s.viewers.values()].filter((v) => v.needsHistory));
    s.inflightViewers = historyViewers;
    try {
      const screen =
        historyViewers.size > 0
          ? await this.opts.backend.getScreen(sessionId, { history: true })
          : await this.opts.backend.getScreen(sessionId);
      if (
        this.stopped ||
        this.sessions.get(sessionId) !== s ||
        s.inflightViewers !== historyViewers
      )
        return;
      try {
        this.processScreen(sessionId, s, screen, historyViewers, historyViewers.size > 0);
      } catch {
        this.log.error("processScreen failed; will resync prepared screen");
        for (const v of s.viewers.values()) v.forceSnapshot = true;
        s.dirty = true;
        return;
      }
    } catch (err) {
      if (
        this.stopped ||
        this.sessions.get(sessionId) !== s ||
        s.inflightViewers !== historyViewers
      )
        return;
      if (err instanceof SessionGone) {
        this.sessionRemoved(sessionId);
      } else {
        this.log.warn("getScreen failed; will retry", {
          session: sessionId.slice(0, 12),
          err: safeErrorName(err),
        });
        for (const v of s.viewers.values()) v.forceSnapshot = true;
        s.dirty = true;
      }
      return;
    } finally {
      s.inflightViewers = null;
      s.inflight = false;
    }
    this.notifyScheduled(sessionId, s, cycle, nextOffset);
  }

  private notifyScheduled(
    sessionId: string,
    s: SessionState,
    cycle: number,
    nextOffset: number,
  ): void {
    if (this.opts.delivery !== "scheduled" || this.stopped) return;
    const frame = s.prepared;
    if (!frame || this.sessions.get(sessionId) !== s) return;
    const pending = [...s.viewers.entries()].filter(([, v]) => {
      if (v.needsHistory && !frame.historyViewers.has(v)) {
        s.dirty = true;
        return false;
      }
      return v.lastSentGen !== frame.gen || v.forceSnapshot;
    });
    if (pending.length === 0) return;
    try {
      observeRejection(this.opts.onReady(sessionId));
    } catch {
      this.log.error("scheduled screen readiness failed");
    }
    for (const [connId, v] of pending) {
      if (
        !this.stopped &&
        this.sessions.get(sessionId) === s &&
        s.prepared === frame &&
        s.viewers.get(connId) === v &&
        (v.lastSentGen !== frame.gen || v.forceSnapshot)
      )
        v.skipped += 1;
    }
    if (cycle > this.lastReadinessCycle) {
      this.lastReadinessCycle = cycle;
      this.sessionOffset = nextOffset;
    }
  }

  private processScreen(
    sessionId: string,
    s: SessionState,
    screen: Screen,
    historyViewers: Set<ViewerState>,
    historyRequested: boolean,
  ): void {
    // A `subscribe(null)` can remove the very last viewer while `getScreen` above was still in
    // flight; without this guard `n` below is 0 and `s.rrOffset % n` is a permanent NaN.
    if (s.viewers.size === 0) return;
    // Per-backend, not the registry-wide AND of every connected backend's capability (minor: a
    // second backend with `absoluteLines: false`, e.g. tmux, must not make an iTerm2 session run
    // overlap detection meant for backends without absolute line numbering). Falls back to the
    // aggregate facade capability for a backend that has no per-session notion of it at all.
    const absoluteLines =
      this.opts.backend.capabilitiesOf?.(sessionId)?.absoluteLines ??
      this.opts.backend.capabilities.absoluteLines;
    const keys = screen.lines.map(lineKey);
    const rows = screen.rows;
    let delta = 0;
    let reset = false;
    let forceSnapshotAll =
      s.lastKeys.length === 0 || s.lastCols !== screen.cols || s.lastRows !== screen.rows;

    if (s.lastBackendScrollback === null) {
      s.reported = screen.scrollbackTotal;
    } else {
      const backendDelta = screen.scrollbackTotal - s.lastBackendScrollback;
      if (backendDelta < 0) {
        reset = true;
        forceSnapshotAll = true;
        s.reported = screen.scrollbackTotal;
      } else if (backendDelta >= rows) {
        forceSnapshotAll = true;
        s.reported += backendDelta;
      } else if (backendDelta > 0) {
        delta = backendDelta;
        s.reported += backendDelta;
      } else if (!absoluteLines && !forceSnapshotAll) {
        const changedRowForRow = countChanged(keys, s.lastKeys, 0);
        if (changedRowForRow > SNAPSHOT_RATIO * rows) {
          const k = detectOverlap(keys, s.lastKeys, rows);
          if (k > 0) {
            delta = k;
            s.reported += k;
          }
        }
      }
    }
    s.lastBackendScrollback = screen.scrollbackTotal;
    // tmux's `history_size` saturates, so its `getHistory` cannot derive absolute line
    // numbers on its own -- hand it the monotonic value we just computed. Optional on the
    // interface; iTerm2 (absoluteLines: true) does not implement it.
    this.opts.backend.setReported?.(sessionId, s.reported);

    const changed: { i: number; line: Line }[] = [];
    if (!forceSnapshotAll) {
      for (let i = 0; i < rows; i++) {
        const old = i + delta < s.lastKeys.length ? s.lastKeys[i + delta] : undefined;
        if (old === undefined || old !== keys[i])
          changed.push({ i, line: screen.lines[i] as Line });
      }
      if (changed.length > SNAPSHOT_RATIO * rows) forceSnapshotAll = true;
    }

    const cursorChanged =
      !s.lastCursor || s.lastCursor.x !== screen.cursor.x || s.lastCursor.y !== screen.cursor.y;
    // Nothing to say this tick: don't advance `gen` or wake an already-current viewer.
    const noOp = !forceSnapshotAll && delta === 0 && changed.length === 0 && !cursorChanged;

    if (!noOp) s.gen += 1;
    const preservePrepared =
      noOp && s.prepared?.gen === s.gen && ![...historyViewers].some((v) => v.needsHistory);
    // A history join may require fresh capture evidence on a no-op read while an
    // older viewer still needs the changed-row diff for this same generation.
    const pendingDiff =
      this.opts.delivery === "scheduled" && noOp && s.prepared?.gen === s.gen ? s.prepared : null;
    s.lastKeys = keys;
    s.lastCols = screen.cols;
    s.lastRows = screen.rows;
    s.lastCursor = screen.cursor;
    if (preservePrepared) return;

    const base = { sessionId, cursor: screen.cursor, scrollbackTotal: s.reported, gen: s.gen };
    const maxBytes = this.opts.maxEncodedBytes ?? 262_144;
    // Encoded once per tick (not once per viewer): every lagging/new viewer this tick shares it.
    let fullMsg: InnerMessageOf<"screen.snapshot"> | undefined;
    let fullBytes: number | undefined;
    let degradedMsg: InnerMessageOf<"screen.snapshot"> | undefined;
    const getFull = (): InnerMessageOf<"screen.snapshot"> => {
      fullMsg ??= {
        type: "screen.snapshot",
        ...base,
        cols: screen.cols,
        rows: screen.rows,
        lines: screen.lines,
        reset: reset || undefined,
      };
      return fullMsg;
    };
    const getDegraded = (): InnerMessageOf<"screen.snapshot"> => {
      if (!degradedMsg) {
        degradedMsg = { ...getFull(), lines: screen.lines.map(stripStyles), degraded: true };
        // stripStyles is the only fallback we have; if it's still too big, send it anyway but say so.
        if (!s.oversizeWarned) {
          const bytes = encodeCbor(degradedMsg).byteLength;
          if (bytes > maxBytes) {
            this.log.warn("screen.snapshot exceeds maxEncodedBytes even after stripStyles", {
              session: sessionId.slice(0, 12),
              bytes,
              maxEncodedBytes: maxBytes,
            });
            s.oversizeWarned = true;
          }
        }
      }
      return degradedMsg;
    };
    /** `starved` forces the degraded path; otherwise size against the 256 KB (default) cap decides. */
    const snapshotFor = (starved: boolean): InnerMessage => {
      if (starved) return getDegraded();
      fullBytes ??= encodeCbor(getFull()).byteLength;
      return fullBytes > maxBytes ? getDegraded() : getFull();
    };
    const diff: InnerMessage = { type: "screen.diff", ...base, scroll: delta, changed };

    const diffContext: ScreenFrameContext = Object.freeze({
      generation: s.gen,
      reported: s.reported,
      historyRequested,
    });
    const snapshotContext: ScreenFrameContext = Object.freeze({
      ...diffContext,
      ...(screen.historyCapture ? { capture: screen.historyCapture } : {}),
    });
    s.prepared = {
      gen: s.gen,
      diff: pendingDiff?.diff ?? diff,
      // A rebuilt no-op has no delta from gen - 1; lagging viewers need its full snapshot.
      forceSnapshotAll: pendingDiff?.forceSnapshotAll ?? (forceSnapshotAll || noOp),
      snapshotFor,
      fullSnapshot: getFull,
      snapshotContext,
      diffContext: pendingDiff?.diffContext ?? diffContext,
      historyViewers,
    };
  }

  private deliver(sessionId: string, s: SessionState): boolean {
    if (this.opts.delivery === "scheduled") return false;
    const frame = s.prepared;
    if (!frame || s.viewers.size === 0) return false;
    const ownsFrame = () =>
      !this.stopped && this.sessions.get(sessionId) === s && s.prepared === frame;
    const { gen, diff, forceSnapshotAll, snapshotFor } = frame;
    let tokenSpent = false;

    // Fair service order under a scarce budget: most-coalesced viewer first; ties broken by
    // rotating the start offset each tick, so no viewer is stuck permanently at the back.
    const entries = [...s.viewers.entries()];
    const n = entries.length;
    const offset = s.rrOffset % n;
    const rotated = entries.slice(offset).concat(entries.slice(0, offset));
    const ordered = rotated
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => b.entry[1].skipped - a.entry[1].skipped || a.idx - b.idx)
      .map((x) => x.entry);
    s.rrOffset = (s.rrOffset + 1) % n;

    for (const [conn, v] of ordered) {
      if (!ownsFrame()) break;
      if (s.viewers.get(conn) !== v) continue;
      if (v.needsHistory && !frame.historyViewers.has(v)) {
        s.dirty = true;
        continue;
      }
      const stale = v.lastSentGen !== gen;
      if (!stale && !v.forceSnapshot) continue; // already has this exact generation; nothing to do
      if (!this.spend()) {
        // Global budget exhausted this tick: coalesce. `lastSentGen` stays stale, so this viewer
        // is served a snapshot on the next tick it wins the budget.
        v.skipped += 1;
        continue;
      }
      tokenSpent = true;
      const starved = v.skipped >= COALESCE_DEGRADE_TICKS;
      const upToDate =
        v.lastSentGen === gen - 1 && !v.forceSnapshot && !forceSnapshotAll && !starved;
      try {
        const message = upToDate ? diff : snapshotFor(starved);
        const accepted = this.opts.sink(
          conn,
          message,
          upToDate ? frame.diffContext : frame.snapshotContext,
        );
        // A sink can synchronously stop/restart the tracker. Session/viewer identity
        // alone survives that cycle; only this exact prepared frame owns bookkeeping.
        if (!ownsFrame()) break;
        if (s.viewers.get(conn) !== v) continue;
        if (accepted === false) {
          v.skipped += 1;
          v.forceSnapshot = true;
          continue;
        }
      } catch (err) {
        if (!ownsFrame()) break;
        if (s.viewers.get(conn) !== v) continue;
        v.skipped += 1;
        v.forceSnapshot = true;
        this.log.error("screen sink threw; will retry prepared generation", {
          conn: conn.slice(0, 12),
          err: safeErrorName(err),
        });
        continue;
      }
      v.lastSentGen = gen;
      v.forceSnapshot = false;
      v.skipped = 0;
      // Logical sink acceptance ends acquisition demand; it is not a phone transfer ACK.
      if (!upToDate) v.needsHistory = false;
    }
    return tokenSpent;
  }

  /**
   * One continuously-refilling token bucket across every viewer of every session: all frames
   * leave through the agent's single relay socket, which the relay caps at 60 msg/s (close 4429).
   */
  private spend(): boolean {
    const max = this.opts.maxFramesPerSecond ?? 40;
    const now = this.now();
    const elapsed = Math.max(0, now - this.budget.last);
    this.budget.tokens = Math.min(max, this.budget.tokens + (elapsed * max) / 1000);
    this.budget.last = now;
    if (this.budget.tokens < 1) return false;
    this.budget.tokens -= 1;
    return true;
  }
}

function observeRejection(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  void new Promise((resolve) => resolve(value)).catch(() => {});
}

function countChanged(keys: string[], last: string[], shift: number): number {
  let n = 0;
  for (let i = 0; i < keys.length; i++) if (last[i + shift] !== keys[i]) n++;
  return n;
}

/** Returns k>0 if new row i equals old row i+k for ≥80% of comparable rows; the smallest such k wins. */
function detectOverlap(keys: string[], last: string[], rows: number): number {
  for (let k = 1; k <= Math.min(rows - 1, OVERLAP_MAX_SHIFT); k++) {
    const comparable = rows - k;
    if (comparable <= 0) break;
    let match = 0;
    for (let i = 0; i < comparable; i++) if (keys[i] === last[i + k]) match++;
    if (match >= OVERLAP_MIN_MATCH * comparable) return k;
  }
  return 0;
}
