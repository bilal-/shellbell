import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type {
  Capabilities,
  CreateWhere,
  Line,
  SessionInfo,
  TerminalMouseClick,
} from "@shellbell/protocol";
import { type Logger, safeErrorName } from "../../log.js";
import { makeNotificationFacts } from "../../notification-context.js";
import { assertHistoryReadRequest } from "../history.js";
import {
  type AgentState,
  type BackendEvent,
  BackendUnavailable,
  BadWindow,
  type HistoryCapture,
  type HistoryReadRequest,
  type HistoryReadResult,
  type Screen,
  type ScreenReadOptions,
  SessionGone,
  type TerminalBackend,
  Unsupported,
} from "../types.js";
import {
  GONE_CODES,
  type HerdrClient,
  HerdrError,
  type HerdrStream,
  INSTALL_HINT,
  UNSUPPORTED_CODES,
  UPGRADE_HINT,
} from "./client.js";
import { herdrScreen } from "./convert.js";
import { exactPhysicalRows, type HerdrHistoryFacts, parseHistoryFacts } from "./history.js";
import { herdrKeyForBytes } from "./keys.js";
import { HerdrMouseController } from "./mouse.js";
import { HerdrScreenObserver } from "./screen-observer.js";
import type {
  HerdrEvent,
  HerdrSubscription,
  PaneInfo,
  PaneInfoResult,
  PaneLayoutSnapshot,
  PaneReadResult,
  PaneScroll,
  SessionSnapshot,
  SessionSnapshotResult,
  TabCreatedResult,
  WorkspaceCreatedResult,
} from "./types.js";

/** Herdr caps a single `pane.read` at 1000 lines (`line_limit = lines.min(1000)`). */
const MAX_READ_LINES = 1000;
/** Cap on events buffered during a bootstrap, so a storm cannot grow without bound. */
const MAX_BUFFERED_EVENTS = 1000;

/**
 * The lifecycle subscriptions we always want, plus the two per-pane ones. Herdr has no incremental
 * "add subscription" method, so this list is fixed for the life of a stream and the pane set
 * changing means opening a new stream (two-phase, see `openStream`).
 */
export function herdrSubscriptions(paneIds: string[]): HerdrSubscription[] {
  const subs: HerdrSubscription[] = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
    { type: "pane.updated" },
    { type: "pane.focused" },
    { type: "pane.moved" },
    { type: "pane.agent_detected" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.focused" },
    { type: "tab.renamed" },
    { type: "tab.moved" },
    { type: "workspace.created" },
    { type: "workspace.updated" },
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.reordered" },
    { type: "layout.updated" },
  ];
  for (const paneId of paneIds) {
    subs.push({ type: "pane.agent_status_changed", pane_id: paneId });
    subs.push({ type: "pane.scroll_changed", pane_id: paneId });
  }
  return subs;
}

const AGENT_STATES = new Set<string>(["working", "blocked", "idle", "done", "unknown"]);

function agentStateOf(v: unknown): AgentState {
  return typeof v === "string" && AGENT_STATES.has(v) ? (v as AgentState) : "unknown";
}

/**
 * `working` -> running, `idle`/`done` -> finished, `blocked` -> the new state. Herdr's
 * `done` is "idle and not yet seen in the Herdr UI"; the phone cannot observe that, so both map to
 * `finished` on purpose.
 */
const SESSION_STATE: Record<AgentState, SessionInfo["state"]> = {
  working: "running",
  blocked: "blocked",
  idle: "finished",
  done: "finished",
  unknown: "unknown",
};

/** agent name, else pane title, else cwd basename, else "Pane". */
function titleOf(pane: PaneInfo): string {
  const cwd = pane.foreground_cwd ?? pane.cwd;
  const base = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  return (
    pane.display_agent || pane.agent || pane.title || pane.terminal_title_stripped || base || "Pane"
  );
}

function errName(err: unknown): string {
  return safeErrorName(err);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function scrollOf(v: unknown): PaneScroll | undefined {
  return v && typeof v === "object" ? (v as PaneScroll) : undefined;
}

function sameSet(a: string[], b: Set<string>): boolean {
  return a.length === b.size && a.every((x) => b.has(x));
}

interface Pane {
  terminalId: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  title: string;
  cwd?: string;
  /** Layout rect width in cells, else 80. */
  cols: number;
  /** Layout rect height in cells, else `scroll.viewport_rows`, else 24. */
  rows: number;
  /** True when `rows` came from a layout rect, so a scroll refresh must not override it. */
  rowsFromRect: boolean;
  windowNumber: number;
  tabIndex: number;
  paneIndex: number;
  focused: boolean;
  agentStatus: AgentState;
  /** `scroll.max_offset_from_bottom`: rows above the viewport = our `scrollbackTotal`. */
  scrollMax: number;
  scrollOffset?: number;
  /** Set when a `pane.scroll_changed` event carried no usable numbers. */
  scrollStale: boolean;
  scrollFetchedAt: number;
  /**
   * `eventSeq` value stamped when a live, revision-ordered `pane_updated` last updated
   * `agentStatus`. Guards against an in-flight `session.snapshot` reverting a status a fresher
   * event already applied while the RPC was outstanding (race, review fix 4).
   * `pane_agent_status_changed` no longer stamps this: it is a
   * hint, not a mutation, so there is nothing of its own to protect from being reverted.
   */
  statusSeq: number;
  /**
   * `pane_updated.pane.revision`, a monotonic content counter. `screen-changed`
   * fires whenever a `pane_updated` event or a post-reconnect snapshot carries a different value.
   */
  revision: number;
}

interface StreamState {
  cancelled: boolean;
  live: boolean;
  buffer: HerdrEvent[];
  stream: HerdrStream | null;
  /** M-6: set once this bootstrap has already logged an overflow, so a storm logs only once. */
  overflowed: boolean;
}

/** One current epoch per captured pane. Old tokens retain evidence only through the WeakMap. */
interface HistoryEpoch {
  readonly sessionId: string;
  readonly paneId: string;
  readonly stream: StreamState;
  readonly revision: number;
  readonly cols: number;
  readonly rows: number;
  certified?: HerdrHistoryFacts;
}

interface HistoryEvidence {
  readonly epoch: HistoryEpoch;
  readonly facts: HerdrHistoryFacts;
  readonly trimmedViewportRows: number;
}

type FactsResult = { facts: HerdrHistoryFacts } | { reason: "changed" | "busy" };

function sameFacts(a: HerdrHistoryFacts, b: HerdrHistoryFacts): boolean {
  return (
    a.paneId === b.paneId &&
    a.terminalId === b.terminalId &&
    a.revision === b.revision &&
    a.history === b.history &&
    a.viewportRows === b.viewportRows &&
    a.offset === b.offset
  );
}

export interface HerdrBackendOptions {
  client: HerdrClient;
  log: Logger;
  /** poll for the socket every 2 s after the server goes away. */
  reconnectMs?: number;
  /** Debounce before a lifecycle-hint snapshot refresh / stream rebuild. */
  syncDebounceMs?: number;
  /** Minimum gap between `pane.get` scroll refreshes for one pane. */
  scrollRefreshMs?: number;
  /** Native content observation cadence; JSON pane revisions do not track screen output. */
  screenPollMs?: number;
  backgroundScreenPollMs?: number;
  mouse?: Pick<HerdrMouseController, "configure" | "close" | "available" | "click"> &
    Partial<Pick<HerdrMouseController, "verifiedExecutable">>;
}

export class HerdrBackend implements TerminalBackend {
  readonly name = "herdr" as const;
  get capabilities(): Capabilities {
    return {
      subscribe: true,
      // Herdr has no prompt/command lifecycle and no exit codes at all: the idle heuristic (8.8) and
      // `agent-state` carry the whole notification story.
      prompts: false,
      createSession: true,
      terminalInput: true,
      terminalPaste: true,
      focus: true,
      history: true,
      // `pane.read` has no stable absolute line numbering, so the tracker must use `lineKey` overlap.
      absoluteLines: false,
      ...(this.mouse.available ? { mouseClick: true } : {}),
    };
  }
  private readonly mouse: NonNullable<HerdrBackendOptions["mouse"]>;

  private panes = new Map<string, Pane>();
  private historyEpochs = new Map<string, HistoryEpoch>();
  private historyCaptures = new WeakMap<HistoryCapture, HistoryEvidence>();
  private byPaneId = new Map<string, string>();
  private order: string[] = [];
  private workspaces = new Set<string>();
  private focusedWorkspace: string | null = null;
  /**
   * Bumped every time a live, revision-ordered `pane_updated` event applies a status to a pane;
   * captured just before each `session.snapshot` request so the (later) response can tell whether
   * a per-pane status it is about to apply has since gone stale (review fix 4). Not touched by
   * `pane_agent_status_changed`: that event is a hint, so it has
   * nothing of its own to protect from reversion.
   */
  private eventSeq = 0;

  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly log: Logger;
  private readonly client: HerdrClient;
  private readonly screenObserver: HerdrScreenObserver;

  private active: StreamState | null = null;
  private subscribedPaneIds = new Set<string>();

  private closed = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncBusy = false;
  private wantSnapshot = false;
  private wantResubscribe = false;

  constructor(private readonly opts: HerdrBackendOptions) {
    this.client = opts.client;
    this.mouse = opts.mouse ?? new HerdrMouseController({ socketPath: this.client.socketPath });
    this.log = opts.log.child({ backend: "herdr" });
    this.screenObserver = new HerdrScreenObserver({
      watchedMs: opts.screenPollMs,
      backgroundMs: opts.backgroundScreenPollMs,
      targets: () => {
        const stream = this.active;
        if (this.closed || !stream?.live) return [];
        return [...this.panes].map(([id, pane]) => ({
          id,
          identity: pane.paneId,
          current: () => {
            const current = this.panes.get(id);
            return (
              !this.closed &&
              this.active === stream &&
              current?.paneId === pane.paneId &&
              current.rows === pane.rows &&
              current.cols === pane.cols
            );
          },
          read: () => this.getScreen(id),
        }));
      },
      changed: (id) => {
        this.historyEpochs.delete(id);
        this.emit({ type: "screen-changed", sessionId: id });
      },
      failed: () => this.log.warn("herdr screen observation failed"),
    });
  }

  /** `false` while the socket is down, so the registry drops us from `hello`. */
  get isConnected(): boolean {
    return !this.closed && this.active !== null;
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    this.closed = false;
    // Gate 1: semver (throws BackendUnavailable). Gate 2: the discovery snapshot doubles as the
    // `session.snapshot` feature probe -- it landed in 0.7.2 -- and tells us which panes exist, so
    // the very first subscription already covers all of them.
    const pong = await this.client.ping();
    await this.mouse.configure(pong.version);
    let discovered: string[] = [];
    try {
      const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
      discovered = assertSnapshot(res?.snapshot).panes.map((p) => p.pane_id);
    } catch (err) {
      throw this.unavailable(err);
    }
    try {
      await this.openStream(discovered);
    } catch (err) {
      if (err instanceof BackendUnavailable) throw err;
      throw this.unavailable(err);
    }
  }

  private unavailable(err: unknown): BackendUnavailable {
    if (err instanceof BackendUnavailable) return err;
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code))
      return new BackendUnavailable(
        `herdr does not support session.snapshot (${detail})`,
        UPGRADE_HINT,
      );
    if (err instanceof HerdrError && err.code === "malformed")
      return new BackendUnavailable(
        `herdr answered session.snapshot with junk (${detail})`,
        UPGRADE_HINT,
      );
    return new BackendUnavailable(detail, INSTALL_HINT);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.mouse.close();
    this.screenObserver.stop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    const active = this.active;
    this.active = null;
    if (active) {
      active.cancelled = true;
      active.stream?.close();
    }
    this.panes.clear();
    this.historyEpochs.clear();
    this.byPaneId.clear();
    this.order = [];
    // Review fix 5: leaving any of these set would surface as one spurious sync/rebuild on a
    // future `connect()` of the SAME instance, and a handler left registered after `close()`
    // would keep firing for an owner that thinks it long since unsubscribed.
    this.wantSnapshot = false;
    this.wantResubscribe = false;
    this.syncBusy = false;
    this.subscribedPaneIds.clear();
    this.handlers.clear();
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- sessions ----

  async notificationFacts(sessionId: string) {
    const p = this.panes.get(sessionId);
    if (!p || !this.isConnected) return undefined;
    return makeNotificationFacts(
      {
        sessionId,
        cwd: p.cwd,
        title: p.title,
        sessionLabel: `Herdr · Window ${p.windowNumber} · Tab ${p.tabIndex + 1} · Pane ${p.paneIndex + 1}`,
      },
      undefined,
      "reported",
    );
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.order
      .map((id) => this.panes.get(id))
      .filter((p): p is Pane => p !== undefined)
      .map((p) => this.toInfo(p));
  }

  async getScreen(sessionId: string, options?: ScreenReadOptions): Promise<Screen> {
    const pane = this.pane(sessionId);
    const epoch = options?.history ? this.captureEpoch(pane) : undefined;
    if (pane.scrollStale) await this.refreshScroll(pane);
    const before = epoch && this.ownsHistory(epoch) ? await this.historyFacts(epoch) : undefined;
    const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
      pane_id: pane.paneId,
      source: "visible",
      format: "ansi",
    });
    const screen = herdrScreen({
      text: res?.read?.text ?? "",
      rows: pane.rows,
      cols: pane.cols,
      scrollMax: pane.scrollMax,
    });
    if (!epoch || !this.ownsHistory(epoch) || !before || !("facts" in before)) return screen;
    const raw = exactPhysicalRows(res, {
      paneId: epoch.paneId,
      source: "visible",
      rows: epoch.rows,
      cols: epoch.cols,
      minRows: 0,
    });
    if (!raw || before.facts.offset !== 0) return screen;
    const after = await this.historyFacts(epoch);
    if (!this.ownsHistory(epoch) || !("facts" in after)) return screen;
    if (!sameFacts(before.facts, after.facts)) {
      this.revokeHistory(epoch);
      return screen;
    }
    epoch.certified = after.facts;
    const token = Object.freeze({});
    this.historyCaptures.set(token, {
      epoch,
      facts: after.facts,
      trimmedViewportRows: epoch.rows - raw.length,
    });
    screen.historyCapture = token;
    return screen;
  }

  async getHistoryPage(sessionId: string, request: HistoryReadRequest): Promise<HistoryReadResult> {
    assertHistoryReadRequest(request);
    if (request.signal.aborted) return { status: "cancelled" };
    this.pane(sessionId);
    const evidence = this.historyCaptures.get(request.capture);
    if (!evidence || evidence.epoch.sessionId !== sessionId) {
      return { status: "unavailable", reason: "unanchored" };
    }
    const { epoch, facts } = evidence;
    const stopped = (): HistoryReadResult | undefined =>
      request.signal.aborted
        ? { status: "cancelled" }
        : !this.ownsHistory(epoch)
          ? { status: "reset" }
          : undefined;
    const initialStop = stopped();
    if (initialStop) return initialStop;
    if (
      request.reported < facts.history ||
      request.reported > Number.MAX_SAFE_INTEGER - facts.viewportRows
    ) {
      return { status: "unavailable", reason: "unanchored" };
    }
    const first = await this.historyFacts(epoch);
    const firstStop = stopped();
    if (firstStop) return firstStop;
    if (!("facts" in first)) return { status: "unavailable", reason: first.reason };
    if (!sameFacts(facts, first.facts)) {
      this.revokeHistory(epoch);
      return { status: "reset" };
    }
    const oldest = request.reported - facts.history;
    let candidate: HistoryReadResult;
    if (request.before <= oldest) {
      candidate = {
        status: "boundary",
        reason: request.before === oldest ? "end" : "truncated",
        oldestAvailable: oldest,
      };
    } else {
      const desiredFrom = Math.max(request.before - request.count, oldest);
      const windowFrom = Math.max(oldest, request.reported + facts.viewportRows - MAX_READ_LINES);
      const from = Math.max(desiredFrom, windowFrom);
      if (from >= request.before) return { status: "unavailable", reason: "fetch-window" };
      const want = facts.viewportRows + (request.reported - from);
      if (!Number.isSafeInteger(want) || want < 1 || want > MAX_READ_LINES) {
        return { status: "unavailable", reason: "fetch-window" };
      }
      let result: unknown;
      try {
        result = await this.client.request("pane.read", {
          pane_id: epoch.paneId,
          source: "recent",
          format: "ansi",
          lines: want,
        });
      } catch (err) {
        return (
          stopped() ?? {
            status: "unavailable",
            reason: err instanceof HerdrError && err.code === "agent_not_idle" ? "busy" : "changed",
          }
        );
      }
      const readStop = stopped();
      if (readStop) return readStop;
      const lines = exactPhysicalRows(result, {
        paneId: epoch.paneId,
        source: "recent",
        // Ghostty's ANSI formatter trims the blank viewport tail in both
        // visible and recent reads. Only accept the shortfall certified by
        // this capture; never invent or pad rows from older history.
        rows: want - evidence.trimmedViewportRows,
        cols: epoch.cols,
      });
      if (!lines) return { status: "unavailable", reason: "changed" };
      candidate = {
        status: "page",
        from,
        to: request.before,
        oldestAvailable: oldest,
        lines: lines.slice(0, request.before - from),
      };
    }
    const last = await this.historyFacts(epoch);
    const finalStop = stopped();
    if (finalStop) return finalStop;
    if (!("facts" in last)) return { status: "unavailable", reason: last.reason };
    if (!sameFacts(facts, last.facts)) {
      this.revokeHistory(epoch);
      return { status: "reset" };
    }
    epoch.certified = last.facts;
    return candidate;
  }

  private captureEpoch(pane: Pane): HistoryEpoch | undefined {
    if (this.closed || !this.active || this.active.cancelled) return undefined;
    if (pane.scrollOffset !== undefined && pane.scrollOffset !== 0) return undefined;
    const existing = this.historyEpochs.get(pane.terminalId);
    if (existing && this.ownsHistory(existing)) return existing;
    const epoch: HistoryEpoch = {
      sessionId: pane.terminalId,
      paneId: pane.paneId,
      stream: this.active,
      revision: pane.revision,
      cols: pane.cols,
      rows: pane.rows,
    };
    this.historyEpochs.set(pane.terminalId, epoch);
    return epoch;
  }

  private ownsHistory(epoch: HistoryEpoch): boolean {
    const pane = this.panes.get(epoch.sessionId);
    return (
      !this.closed &&
      this.active === epoch.stream &&
      !epoch.stream.cancelled &&
      this.historyEpochs.get(epoch.sessionId) === epoch &&
      pane?.paneId === epoch.paneId &&
      pane.cols === epoch.cols &&
      pane.rows === epoch.rows &&
      pane.revision === epoch.revision
    );
  }

  private revokeHistory(epoch: HistoryEpoch): void {
    if (this.historyEpochs.get(epoch.sessionId) === epoch)
      this.historyEpochs.delete(epoch.sessionId);
  }

  private async historyFacts(epoch: HistoryEpoch): Promise<FactsResult> {
    try {
      const result = await this.client.request<PaneInfoResult>("pane.get", {
        pane_id: epoch.paneId,
      });
      // Validate against the response's own native IDs first: a well-formed different identity
      // is a contradiction, not merely a malformed response from the requested pane.
      const facts = parseHistoryFacts(result, result?.pane?.pane_id, result?.pane?.terminal_id);
      if (!facts) return { reason: "changed" };
      if (
        this.ownsHistory(epoch) &&
        (facts.paneId !== epoch.paneId ||
          facts.terminalId !== epoch.sessionId ||
          facts.viewportRows !== epoch.rows ||
          (epoch.certified && !sameFacts(epoch.certified, facts)))
      ) {
        this.revokeHistory(epoch);
      }
      return { facts };
    } catch (err) {
      return {
        reason: err instanceof HerdrError && err.code === "agent_not_idle" ? "busy" : "changed",
      };
    }
  }

  /**
   * best-effort, styled, bounded. `source:"recent"` returns the **last** N lines of the
   * buffer (screen included), N <= 1000. `before` is in the same coordinate system as the
   * `scrollbackTotal` we emit (`scroll.max_offset_from_bottom` = the index of the screen's first
   * row), so `depth` is how far above our own screen top the requested page ends. There is no
   * stable absolute numbering (`absoluteLines: false`), so a short page plus `oldestAvailable` is
   * how the phone learns it has reached the top.
   */
  async getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const pane = this.pane(sessionId);
    const stream = this.active;
    const { scrollMax, rows, cols } = pane;
    const depth = Math.max(0, scrollMax - before);
    const want = Math.min(MAX_READ_LINES, depth + count + rows);
    // Let temporary failures reach the legacy request handler as retryable
    // errors. An empty successful page would permanently mark history ended.
    const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
      pane_id: pane.paneId,
      source: "recent",
      format: "ansi",
      lines: want,
    });
    const unavailable = () =>
      new BackendUnavailable(
        "History temporarily unavailable",
        "Retry history after output settles.",
      );
    const all = exactPhysicalRows(res, {
      paneId: pane.paneId,
      source: "recent",
      rows: want,
      cols,
      minRows: 0,
    });
    if (!all) throw unavailable();
    const available = Math.min(want, scrollMax + rows);
    const trimmed = available - all.length;
    // A native fetch limit is not an end boundary. Likewise, a shortfall larger
    // than the viewport cannot be explained by Ghostty's blank-tail trimming.
    if (trimmed < 0 || trimmed > rows || (before > 0 && depth + rows >= MAX_READ_LINES))
      throw unavailable();
    if (trimmed > 0) {
      const visible = await this.call<PaneReadResult>(sessionId, "pane.read", {
        pane_id: pane.paneId,
        source: "visible",
        format: "ansi",
      });
      const tail = exactPhysicalRows(visible, {
        paneId: pane.paneId,
        source: "visible",
        rows,
        cols,
        minRows: 0,
      });
      if (
        !tail ||
        tail.length !== rows - trimmed ||
        (tail.length > 0 && !isDeepStrictEqual(tail, all.slice(-tail.length)))
      )
        throw unavailable();
    }
    if (
      this.closed ||
      this.active !== stream ||
      stream?.cancelled ||
      this.panes.get(sessionId) !== pane ||
      pane.rows !== rows ||
      pane.cols !== cols ||
      pane.scrollMax !== scrollMax
    )
      throw unavailable();
    const end = Math.max(0, all.length + trimmed - depth - rows);
    const start = Math.max(0, end - count);
    const lines = all.slice(start, end);
    const exhausted = all.length + trimmed < want;
    const oldestAvailable = exhausted && start === 0 ? Math.max(0, before - lines.length) : 0;
    return { lines, oldestAvailable };
  }

  /**
   * `pane.send_text` writes literal bytes and never submits, so anything that ends in a
   * newline is split into text + a real `enter` key, and a payload that is exactly one named key's
   * bytes goes out as that key.
   */
  async sendText(sessionId: string, text: string): Promise<void> {
    const pane = this.pane(sessionId);
    const whole = herdrKeyForBytes(text);
    if (whole) {
      // Never log keys. A key name is still a keystroke, so this
      // records only that one key was sent -- not which one.
      this.log.debug("herdr key");
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: [whole] });
      return;
    }
    // Never log the text itself -- only its length.
    this.log.debug("herdr text", { len: text.length });
    if (text.endsWith("\r") || text.endsWith("\n")) {
      const body = text.slice(0, -1);
      if (body) await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text: body });
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: ["enter"] });
      return;
    }
    await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text });
  }

  async clickMouse(sessionId: string, click: TerminalMouseClick): Promise<void> {
    const pane = this.pane(sessionId);
    const active = this.active;
    const current = () => {
      const now = this.panes.get(sessionId);
      return (
        !this.closed &&
        this.active === active &&
        active?.live === true &&
        now?.paneId === pane.paneId &&
        now.cols === click.cols &&
        now.rows === click.rows &&
        (now.scrollOffset ?? 0) === 0
      );
    };
    if (!this.mouse.available || !current()) throw new Unsupported("mouse input unavailable");
    // A fresh authoritative layout prevents a stale phone grid from resizing the laptop pane.
    const snapshot = assertSnapshot(
      (await this.client.request<SessionSnapshotResult>("session.snapshot", {}))?.snapshot,
    );
    const identity = snapshot.panes.find((entry) => entry.terminal_id === sessionId);
    const rect = snapshot.layouts
      .flatMap((layout) => layout.panes)
      .find((entry) => entry.pane_id === pane.paneId)?.rect;
    if (
      !current() ||
      identity?.pane_id !== pane.paneId ||
      identity.scroll?.offset_from_bottom !== 0 ||
      rect?.width !== click.cols ||
      rect.height !== click.rows
    )
      throw new Unsupported("mouse grid changed");
    await this.mouse.click(sessionId, click, current);
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const pane = this.pane(sessionId);
    await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text: data });
  }

  async paste(sessionId: string, text: string, submit: boolean): Promise<void> {
    const pane = this.pane(sessionId);
    await this.call(sessionId, "pane.send_input", {
      pane_id: pane.paneId,
      text,
      keys: submit ? ["Enter"] : [],
    });
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const pane = this.pane(where.sessionId);
      // Shellbell's axis names the DIVIDER (like iTerm2's SplitPane.VERTICAL): "vertical" puts the
      // new pane to the right. Herdr's "down" is a horizontal divider. It has no left/up split.
      const res = await this.client.request<PaneInfoResult>("pane.split", {
        target_pane_id: pane.paneId,
        direction: where.direction === "vertical" ? "right" : "down",
        focus: false,
      });
      const id = str(res?.pane?.terminal_id);
      if (!id) throw new Error("herdr pane.split returned no terminal_id");
      // The snapshot is the only writer of the map: ask for one and return the new id now.
      this.scheduleSync("snapshot");
      return id;
    }
    if (where.windowId !== undefined && !this.workspaces.has(where.windowId))
      throw new BadWindow(where.windowId);
    const workspaceId = where.windowId ?? this.focusedWorkspace ?? [...this.workspaces][0];
    if (!workspaceId) {
      return this.createWorkspaceSession();
    }
    const res = await this.client.request<TabCreatedResult>("tab.create", {
      workspace_id: workspaceId,
      focus: false,
    });
    const id = str(res?.root_pane?.terminal_id);
    if (!id) throw new Error("herdr tab.create returned no terminal_id");
    this.scheduleSync("snapshot");
    return id;
  }

  /** only ever from an explicit user action — this marks a `done` agent as seen. */
  async createWorkspaceSession(): Promise<string> {
    const created = await this.client.request<WorkspaceCreatedResult>("workspace.create", {
      cwd: homedir(),
      focus: false,
    });
    const id = str(created?.root_pane?.terminal_id);
    if (!id) throw new Error("herdr workspace.create returned no terminal_id");
    this.scheduleSync("snapshot");
    return id;
  }

  get terminalSocketPath(): string {
    return this.client.socketPath;
  }
  get terminalAttachExecutable(): string | undefined {
    return this.isConnected ? this.mouse.verifiedExecutable : undefined;
  }

  async focus(sessionId: string): Promise<void> {
    const pane = this.pane(sessionId);
    await this.call(sessionId, "pane.focus", { pane_id: pane.paneId });
  }

  setWatched(ids: string[]): void {
    this.screenObserver.setWatched(ids);
  }

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.warn("event handler failed", { error: errName(err) });
      }
    }
  }

  private pane(sessionId: string): Pane {
    const pane = this.panes.get(sessionId);
    if (!pane) throw new SessionGone(sessionId);
    return pane;
  }

  /**
   * Every pane-targeted call goes through here so a stale pane target does two things: tell the
   * caller (`SessionGone`) and ask the snapshot -- the only authority -- to reconcile, which is
   * what actually emits `session-removed` if the pane is really gone.
   */
  private async call<T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (err) {
      if (err instanceof HerdrError && GONE_CODES.has(err.code)) {
        this.scheduleSync("snapshot");
        throw new SessionGone(sessionId);
      }
      throw err;
    }
  }

  private toInfo(p: Pane): SessionInfo {
    return {
      id: p.terminalId,
      backend: "herdr",
      title: p.title,
      cwd: p.cwd,
      cols: Math.max(1, p.cols),
      rows: Math.max(1, p.rows),
      windowId: p.workspaceId,
      windowNumber: p.windowNumber,
      tabId: p.tabId,
      tabIndex: p.tabIndex,
      paneIndex: p.paneIndex,
      // Herdr has no "my window is frontmost" signal; pane focus is the closest thing.
      isFocusedOnMac: p.focused,
      state: SESSION_STATE[p.agentStatus],
    };
  }

  private sortOrder(): void {
    this.order = [...this.panes.values()]
      .sort(
        (a, b) =>
          a.windowNumber - b.windowNumber ||
          a.tabIndex - b.tabIndex ||
          a.paneIndex - b.paneIndex ||
          a.paneId.localeCompare(b.paneId),
      )
      .map((p) => p.terminalId);
  }

  // ---- stream / sync ----

  /**
   * Two-phase: the new subscription connection is opened and **acked** — and is already
   * buffering events — before it replaces the current one, so the handover loses nothing. The
   * snapshot that follows is the only writer of the pane map; if it fails, the new stream is closed
   * and the reconnect poll takes over.
   */
  private async openStream(paneIds?: string[]): Promise<void> {
    const ids = paneIds ?? [...this.byPaneId.keys()];
    const state: StreamState = {
      cancelled: false,
      live: false,
      buffer: [],
      stream: null,
      overflowed: false,
    };
    const stream = await this.client.subscribe(herdrSubscriptions(ids), {
      onEvent: (e) => {
        if (state.cancelled) return;
        if (state.live) {
          this.onEvent(e);
          return;
        }
        if (state.buffer.length < MAX_BUFFERED_EVENTS) {
          state.buffer.push(e);
          return;
        }
        // M-6: a storm past the cap drops events with no compensating action; log once (count
        // only, never event content) and make sure the round ends with a fresh snapshot so
        // whatever a dropped hint would have told us gets picked up anyway.
        if (!state.overflowed) {
          state.overflowed = true;
          this.log.warn("herdr bootstrap event buffer overflowed; dropping events", {
            max: MAX_BUFFERED_EVENTS,
          });
        }
        this.scheduleSync("snapshot");
      },
      onEnd: (reason) => {
        if (!state.cancelled && this.active === state) this.onStreamEnd(reason);
      },
    });
    state.stream = stream;
    if (this.closed) {
      state.cancelled = true;
      stream.close();
      return;
    }
    const previous = this.active;
    this.active = state;
    this.historyEpochs.clear();
    this.subscribedPaneIds = new Set(ids);
    if (previous) {
      previous.cancelled = true;
      previous.stream?.close();
    }
    try {
      await this.refreshSnapshot();
    } catch (err) {
      state.cancelled = true;
      stream.close();
      if (this.active === state) this.active = null;
      throw err;
    }
    // A superseded snapshot can settle harmlessly; its bootstrap still owns no live event replay.
    if (state.cancelled || this.closed || this.active !== state) return;
    // Only now do buffered events run — against a map the snapshot has already installed.
    state.live = true;
    const buffered = state.buffer;
    state.buffer = [];
    for (const e of buffered) this.onEvent(e);
    this.screenObserver.start();
    this.emit({ type: "layout-changed" });
  }

  private async refreshSnapshot(): Promise<void> {
    // Captured BEFORE the round-trip: any live, revision-ordered `pane_updated` event that bumps a
    // pane's `statusSeq` past this value while the request is outstanding is fresher than the
    // response about to arrive (review fix 4).
    const requestSeq = this.eventSeq;
    const stream = this.active;
    try {
      const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
      if (this.closed || this.active !== stream) return;
      this.applySnapshot(assertSnapshot(res?.snapshot), requestSeq);
    } catch (err) {
      // An old reconciliation failure must not tear down a replacement stream.
      if (this.closed || this.active !== stream) return;
      throw err;
    }
  }

  /**
   * every lifecycle event is a hint. They coalesce into one debounced, single-flight
   * snapshot (and, when the pane set changed, one stream rebuild). Nothing here can be scheduled by
   * the work it triggers, so there is no loop.
   */
  private scheduleSync(reason: "snapshot" | "resubscribe"): void {
    if (this.closed) return;
    if (reason === "resubscribe") this.wantResubscribe = true;
    else this.wantSnapshot = true;
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSync().catch((err) => {
        this.log.warn("herdr sync crashed", { error: errName(err) });
      });
    }, this.opts.syncDebounceMs ?? 250);
    this.syncTimer.unref?.();
  }

  private async runSync(): Promise<void> {
    if (this.syncBusy || this.closed) return;
    this.syncBusy = true;
    try {
      while ((this.wantResubscribe || this.wantSnapshot) && !this.closed && this.active) {
        const resubscribe = this.wantResubscribe;
        this.wantResubscribe = false;
        this.wantSnapshot = false;
        if (resubscribe) await this.openStream();
        else await this.refreshSnapshot();
      }
    } catch (err) {
      // The socket is the only thing that can fail here; treat it as a disconnect so the normal
      // reconnect path (and its `session-removed` storm) runs exactly once.
      this.log.warn("herdr sync failed", { error: errName(err) });
      this.onStreamEnd("sync-failed");
    } finally {
      this.syncBusy = false;
    }
  }

  /** the server exiting removes the socket file; poll for it every 2 s. */
  private onStreamEnd(reason: string): void {
    if (this.closed) return;
    this.screenObserver.stop();
    const active = this.active;
    this.active = null;
    this.historyEpochs.clear();
    if (active) {
      active.cancelled = true;
      active.stream?.close();
    }
    this.log.info("herdr stream ended", { reason });
    // Loudly: the tracker drops its viewers, the EventEngine forgets each session (so a pane that
    // comes back blocked counts as a first sighting, not a transition), and `isConnected` is false.
    const ids = [...this.order];
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    this.subscribedPaneIds.clear();
    for (const id of ids) this.emit({ type: "session-removed", sessionId: id });
    this.emit({ type: "layout-changed" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.opts.reconnectMs ?? 2000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((err) => {
        this.log.debug("herdr reconnect failed", { error: errName(err) });
        this.scheduleReconnect();
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  // ---- snapshot ----

  private applySnapshot(snap: SessionSnapshot, requestSeq = 0): void {
    const workspaceNumbers = new Map<string, number>();
    const workspaces = new Set<string>();
    for (const w of snap.workspaces ?? []) {
      workspaces.add(w.workspace_id);
      workspaceNumbers.set(w.workspace_id, w.number ?? 0);
    }
    const tabNumbers = new Map<string, number>();
    for (const t of snap.tabs ?? []) tabNumbers.set(t.tab_id, t.number ?? 0);
    const rects = rectIndex(snap.layouts ?? []);

    const prev = this.panes;
    const next = new Map<string, Pane>();
    const byPaneId = new Map<string, string>();
    const changed: { id: string; state: AgentState; agent?: string }[] = [];
    // I-1: the snapshot is the sole writer of `title`/`cwd`, so it is the only place that can
    // notice one changed on a pane that merely got renamed/`cd`ed -- the event path already emits
    // `title-changed` for its own title updates (`pane.agent_status_changed`), this closes the gap
    // for `tab.renamed`/`pane.moved` (which only ever schedule a snapshot) and for a KNOWN pane's
    // `pane.updated` once that handler's own title/cwd check (below) has scheduled one too --
    // `pane.updated` carries no `agent`/`display_agent` name, so this snapshot pass is what
    // actually applies a shell pane's new title/cwd and emits `title-changed` for it.
    const titleChanged = new Set<string>();
    // a pane that already existed with a different numeric `revision` missed
    // its `pane_updated` event while the stream was down (reconnect gap) -- emit `screen-changed`
    // so a stale phone screen gets refreshed. First sight of a pane stores its revision silently.
    const revisionChanged = new Set<string>();
    for (const info of snap.panes) {
      const id = info.terminal_id ?? info.pane_id;
      const was = prev.get(id);
      const rect = rects.get(info.pane_id);
      const snapshotState = agentStateOf(info.agent_status);
      // Review fix 4: a live, revision-ordered `pane_updated` event applied to this pane AFTER the
      // `session.snapshot` request was issued is fresher than the value this response carries —
      // keep it rather than reverting (and never emit a stale `agent-state` for the revert).
      const statusSeq = was?.statusSeq ?? 0;
      const staleStatus = statusSeq > requestSeq;
      const state = staleStatus ? (was?.agentStatus ?? snapshotState) : snapshotState;
      const viewportRows = info.scroll?.viewport_rows;
      const title = titleOf(info);
      const cwd = info.foreground_cwd ?? info.cwd;
      if (was && (was.title !== title || was.cwd !== cwd)) titleChanged.add(id);
      // Same freshness rule as `statusSeq` above: a live `pane_updated` that landed after this
      // `session.snapshot` request was issued already applied a `revision` at least this fresh, so
      // the (older) snapshot answer must not rewind it or emit a spurious `screen-changed` for the
      // "revert". `staleStatus` is driven entirely by `pane_updated`'s own `statusSeq` stamp now
      // (`pane_agent_status_changed` no longer stamps it), so this stays correct even when the
      // fresher event never touched `revision` at all -- `was.revision` is simply left untouched in
      // that case.
      const revision = staleStatus
        ? (was?.revision ?? (typeof info.revision === "number" ? info.revision : 0))
        : typeof info.revision === "number"
          ? info.revision
          : (was?.revision ?? 0);
      if (
        !staleStatus &&
        was &&
        typeof info.revision === "number" &&
        typeof was.revision === "number" &&
        info.revision !== was.revision
      )
        revisionChanged.add(id);
      next.set(id, {
        terminalId: id,
        paneId: info.pane_id,
        workspaceId: info.workspace_id,
        tabId: info.tab_id,
        title,
        cwd,
        cols: rect?.cols ?? was?.cols ?? 80,
        rows: Math.max(1, rect?.rows ?? viewportRows ?? was?.rows ?? 24),
        rowsFromRect: rect !== undefined,
        windowNumber: workspaceNumbers.get(info.workspace_id) ?? 0,
        tabIndex: tabNumbers.get(info.tab_id) ?? 0,
        paneIndex: rect?.order ?? 0,
        focused: info.focused === true || info.pane_id === snap.focused_pane_id,
        agentStatus: state,
        scrollMax: info.scroll?.max_offset_from_bottom ?? was?.scrollMax ?? 0,
        scrollOffset: info.scroll?.offset_from_bottom ?? was?.scrollOffset,
        scrollStale: was?.scrollStale ?? false,
        scrollFetchedAt: was?.scrollFetchedAt ?? 0,
        statusSeq,
        revision,
      });
      byPaneId.set(info.pane_id, id);
      workspaces.add(info.workspace_id);
      if (!staleStatus && was?.agentStatus !== state)
        changed.push({ id, state, agent: info.display_agent ?? info.agent });
    }
    const removed = [...prev.keys()].filter((id) => !next.has(id));
    const addedSet = new Set([...next.keys()].filter((id) => !prev.has(id)));
    const changedById = new Map(changed.map((c) => [c.id, c]));

    for (const [id, epoch] of this.historyEpochs) {
      const before = prev.get(id);
      const after = next.get(id);
      if (
        !after ||
        after.paneId !== epoch.paneId ||
        after.cols !== epoch.cols ||
        after.rows !== epoch.rows ||
        after.revision !== epoch.revision ||
        after.scrollMax !== before?.scrollMax ||
        after.scrollOffset !== before?.scrollOffset
      ) {
        this.revokeHistory(epoch);
      }
    }
    this.panes = next;
    this.byPaneId = byPaneId;
    this.workspaces = workspaces;
    this.focusedWorkspace = snap.focused_workspace_id ?? null;
    this.sortOrder();

    // Order matters: the agent must learn a session exists before it hears about its state, and
    // both must follow the sorted display order (window/tab/rect) rather than the snapshot's raw
    // pane array order, which the fixtures deliberately scramble (rect-order rule coverage).
    for (const id of removed) this.emit({ type: "session-removed", sessionId: id });
    for (const id of this.order)
      if (addedSet.has(id)) this.emit({ type: "session-added", sessionId: id });
    const at = Date.now();
    for (const id of this.order) {
      const c = changedById.get(id);
      if (c)
        this.emit({ type: "agent-state", sessionId: c.id, state: c.state, agent: c.agent, at });
    }
    // I-1: a retained pane whose title or cwd moved gets the same event the event path emits for
    // its own title updates, so `Agent.onBackendEvent` re-broadcasts `sessions` either way.
    for (const id of this.order)
      if (titleChanged.has(id)) this.emit({ type: "title-changed", sessionId: id });
    for (const id of this.order)
      if (revisionChanged.has(id)) this.emit({ type: "screen-changed", sessionId: id });
    if (removed.length > 0 || addedSet.size > 0) this.emit({ type: "layout-changed" });

    // Herdr has no incremental subscription call, so a changed pane set means a new stream.
    // This is the ONLY place that asks for one, and after it runs the sets match -- no loop.
    if (!sameSet([...byPaneId.keys()], this.subscribedPaneIds)) this.scheduleSync("resubscribe");
  }

  // ---- events ----

  private onEvent(e: HerdrEvent): void {
    try {
      this.handleEvent(e);
    } catch (err) {
      this.log.warn("herdr event handling failed", { error: errName(err) });
    }
  }

  /**
   * Lifecycle events arrive snake_case (`pane_created`) while the three subscription-driven ones
   * keep their dotted subscription name (`pane.agent_status_changed`). Normalising the separator
   * makes the table tolerant of both.
   */
  private handleEvent(e: HerdrEvent): void {
    const kind = e.event.replaceAll(".", "_");
    const data = e.data;
    switch (kind) {
      // --- hints: the snapshot decides what actually changed ---
      case "pane_created":
      case "pane_closed":
      case "pane_exited":
      case "pane_moved":
      case "pane_agent_detected":
      case "tab_created":
      case "tab_closed":
      case "tab_renamed":
      case "tab_moved":
      case "workspace_created":
      case "workspace_updated":
      case "workspace_closed":
      case "workspace_renamed":
      case "workspace_moved":
      case "workspace_reordered":
        // Lifecycle hints can replace identities or move geometry before the snapshot arrives.
        this.historyEpochs.clear();
        this.scheduleSync("snapshot");
        return;

      // --- values on a pane that already exists ---
      // `pane_updated.pane` is a full `PaneInfo`, not a
      // hint. An unknown `pane_id` means a pane appeared and only the snapshot can add it; a known
      // pane is updated in place -- scroll, agent status (latest-wins; `agent` may appear but no display name, so the
      // title itself is never WRITTEN from this payload), and its metadata `revision`.
      // Revisions order these events; screen observation detects output independently.
      // A plain shell pane's title/cwd only ever change via this event,
      // though, so a moved `titleOf(info)`/`cwd` still schedules the debounced snapshot refresh --
      // the only thing that actually writes `title`/`cwd` (I-1) -- so `title-changed` keeps firing.
      case "pane_updated": {
        const info = data.pane as Partial<PaneInfo> | undefined;
        const paneId = str(info?.pane_id);
        if (!paneId) return;
        const pane = this.paneByPaneId(paneId);
        if (!pane) {
          this.scheduleSync("snapshot");
          return;
        }
        // `events.subscribe` replays a bounded backlog of recent
        // events -- including old `pane_updated` revisions -- right after its ack, at a 100 ms
        // cadence, before any live event. A `revision` that is
        // not strictly newer than the stored one is that replay (or a reorder) and is ignored
        // entirely: no scroll, no status, no title/cwd sync, no `screen-changed`. The stored
        // revision never moves backwards; only a snapshot (`applySnapshot`) is allowed to do that,
        // and only because it is authoritative.
        if (
          typeof info?.revision === "number" &&
          typeof pane.revision === "number" &&
          info.revision <= pane.revision
        )
          return;

        this.historyEpochs.delete(pane.terminalId);
        if (
          titleOf(info as PaneInfo) !== pane.title ||
          (info?.foreground_cwd ?? info?.cwd) !== pane.cwd
        )
          this.scheduleSync("snapshot");
        const scroll = scrollOf(info?.scroll);
        if (typeof scroll?.offset_from_bottom === "number")
          pane.scrollOffset = scroll.offset_from_bottom;
        if (scroll && typeof scroll.max_offset_from_bottom === "number") {
          pane.scrollMax = scroll.max_offset_from_bottom;
          if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
            pane.rows = Math.max(1, scroll.viewport_rows);
          pane.scrollStale = false;
        }
        // Review fix 4's freshness stamp applies here too: this event's payload is at least as
        // fresh as anything a `session.snapshot` requested earlier could answer with.
        pane.statusSeq = ++this.eventSeq;
        const state = agentStateOf(info?.agent_status);
        if (pane.agentStatus !== state) {
          pane.agentStatus = state;
          this.emit({ type: "agent-state", sessionId: pane.terminalId, state, at: Date.now() });
        }
        if (typeof info?.revision === "number" && info.revision !== pane.revision) {
          pane.revision = info.revision;
          this.emit({ type: "screen-changed", sessionId: pane.terminalId });
        }
        return;
      }
      case "pane_agent_status_changed": {
        const pane = this.paneByPaneId(str(data.pane_id));
        if (!pane) return;
        // a hint, not a mutation. It carries no revision, and the
        // subscription replay re-delivers stale ones, so
        // applying it directly could flip a pane back to a status it left seconds ago. Schedule
        // the same debounced snapshot refresh as every other hint; `applySnapshot` is
        // authoritative for `agent_status` and already emits `agent-state` on a transition and
        // `title-changed` on a title change (it reads the snapshot's own `agent`/`display_agent`
        // fields), so there is nothing left to apply here directly. No `statusSeq` stamp either --
        // that freshness rule now belongs only to `pane_updated`, which is revision-ordered. The
        // live `pane_updated` Herdr emits for the same transition (measured ~0.6 s later, spec
        // 8.13) carries a revision and needs no round trip, so it usually applies first; `blocked`
        // rings otherwise trail the transition by the debounce plus one snapshot (~350 ms).
        this.scheduleSync("snapshot");
        return;
      }
      case "pane_scroll_changed": {
        // The research documents this event as `{ pane_id }` only, so the `pane.get` refresh
        // below is the PRIMARY path and the payload branch is an opportunistic shortcut for a
        // build that does send numbers. Both are cheap; neither is load-bearing on the other.
        const pane = this.paneByPaneId(str(data.pane_id));
        if (!pane) return;
        this.historyEpochs.delete(pane.terminalId);
        const scroll = scrollOf(data.scroll);
        if (typeof scroll?.offset_from_bottom === "number")
          pane.scrollOffset = scroll.offset_from_bottom;
        if (scroll && typeof scroll.max_offset_from_bottom === "number") {
          pane.scrollMax = scroll.max_offset_from_bottom;
          if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
            pane.rows = Math.max(1, scroll.viewport_rows);
          pane.scrollStale = false;
          return;
        }
        // The payload shape is a spike item: mark it stale and let `getScreen` refresh it, at most
        // once a second, rather than firing a `pane.get` per scrolled line.
        pane.scrollStale = true;
        return;
      }
      case "layout_updated": {
        this.historyEpochs.clear();
        const layout = data.layout as PaneLayoutSnapshot | undefined;
        if (layout) {
          for (const [paneId, rect] of rectIndex([layout])) {
            const pane = this.paneByPaneId(paneId);
            if (!pane) continue;
            pane.cols = rect.cols;
            pane.rows = Math.max(1, rect.rows);
            pane.rowsFromRect = true;
            pane.paneIndex = rect.order;
          }
          this.sortOrder();
        }
        this.emit({ type: "layout-changed" });
        return;
      }
      case "pane_focused": {
        const pane = this.paneByPaneId(str(data.pane_id));
        if (pane) for (const p of this.panes.values()) p.focused = p === pane;
        // A pane we have never seen means our map is behind: ask the only authority there is.
        else this.scheduleSync("snapshot");
        this.emit({ type: "focus-changed" });
        return;
      }
      case "tab_focused":
      case "workspace_focused":
        this.emit({ type: "focus-changed" });
        return;
      default:
        this.log.debug("unhandled herdr event");
        return;
    }
  }

  private paneByPaneId(paneId: string | undefined): Pane | undefined {
    const id = paneId ? this.byPaneId.get(paneId) : undefined;
    return id ? this.panes.get(id) : undefined;
  }

  private async refreshScroll(pane: Pane): Promise<void> {
    const now = Date.now();
    const gap = this.opts.scrollRefreshMs ?? 1000;
    if (now - pane.scrollFetchedAt < gap) return;
    pane.scrollFetchedAt = now;
    try {
      const res = await this.client.request<PaneInfoResult>("pane.get", { pane_id: pane.paneId });
      const scroll = res?.pane?.scroll;
      if (
        this.panes.get(pane.terminalId) === pane &&
        scroll &&
        (scroll.max_offset_from_bottom !== pane.scrollMax ||
          scroll.viewport_rows !== pane.rows ||
          scroll.offset_from_bottom !== pane.scrollOffset)
      ) {
        this.historyEpochs.delete(pane.terminalId);
      }
      if (typeof scroll?.offset_from_bottom === "number")
        pane.scrollOffset = scroll.offset_from_bottom;
      if (scroll && typeof scroll.max_offset_from_bottom === "number") {
        pane.scrollMax = scroll.max_offset_from_bottom;
        if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
          pane.rows = Math.max(1, scroll.viewport_rows);
      }
      pane.scrollStale = false;
    } catch (err) {
      this.log.debug("herdr scroll refresh failed", { error: errName(err) });
    }
  }
}

/** `session.snapshot` must actually be a snapshot; anything else is a broken/incompatible herdr. */
function assertSnapshot(snap: unknown): SessionSnapshot {
  const s = snap as SessionSnapshot | undefined;
  if (!s || typeof s !== "object" || !Array.isArray(s.panes))
    throw new HerdrError("malformed", "session.snapshot returned no panes array");
  return s;
}

function rectIndex(
  layouts: PaneLayoutSnapshot[],
): Map<string, { cols: number; rows: number; order: number }> {
  const out = new Map<string, { cols: number; rows: number; order: number }>();
  for (const layout of layouts) {
    const panes = [...(layout.panes ?? [])].sort(
      (a, b) => (a.rect?.y ?? 0) - (b.rect?.y ?? 0) || (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
    );
    panes.forEach((p, order) => {
      out.set(p.pane_id, {
        cols: Math.max(1, p.rect?.width ?? 80),
        rows: Math.max(1, p.rect?.height ?? 24),
        order,
      });
    });
  }
  return out;
}
