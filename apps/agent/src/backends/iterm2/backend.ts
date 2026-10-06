import { create } from "@bufbuild/protobuf";
import type { Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import { type Logger, safeErrorName } from "../../log.js";
import { makeNotificationFacts } from "../../notification-context.js";
import { assertHistoryReadRequest } from "../history.js";
import {
  type BackendEvent,
  BackendUnavailable,
  type HistoryCapture,
  type HistoryReadRequest,
  type HistoryReadResult,
  type Screen,
  type ScreenReadOptions,
  SessionGone,
  type TerminalBackend,
} from "../types.js";
import type { ITerm2Client } from "./client.js";
import { bufferToScreen, lineContentsToLine } from "./convert.js";
import {
  ActivateRequest_AppSchema,
  ActivateRequestSchema,
  CoordRangeSchema,
  CoordSchema,
  CreateTabRequestSchema,
  FocusRequestSchema,
  GetBufferRequestSchema,
  GetPropertyRequestSchema,
  LineRangeSchema,
  ListSessionsRequestSchema,
  type ListSessionsResponse,
  type Notification,
  NotificationRequestSchema,
  NotificationType,
  PromptMonitorMode,
  PromptMonitorRequestSchema,
  SendTextRequestSchema,
  SendTextResponse_Status,
  SplitPaneRequest_SplitDirection,
  SplitPaneRequestSchema,
  type SplitTreeNode,
  VariableMonitorRequestSchema,
  VariableRequestSchema,
  VariableScope,
  WindowedCoordRangeSchema,
} from "./gen/iterm2_pb.js";
import { hasFullRowRange, type ITermHistoryFacts, parseHistoryFacts } from "./history.js";

interface HistoryOwnership {
  coordinateRevision: object;
  activityRevision: object;
  observed?: Readonly<Pick<ITermHistoryFacts, "overflow" | "origin">>;
}

interface CaptureEvidence {
  readonly sessionId: string;
  readonly connectionGeneration: number;
  readonly coordinateRevision: object;
  readonly cols: number;
  readonly rows: number;
  readonly facts: ITermHistoryFacts;
}

function sameHistoryFacts(a: ITermHistoryFacts, b: ITermHistoryFacts): boolean {
  // Scrolling the viewport changes firstVisible, not the absolute coordinate space.
  return a.overflow === b.overflow && a.history === b.history && a.grid === b.grid;
}

function historyRegressed(facts: ITermHistoryFacts, prior: HistoryOwnership["observed"]): boolean {
  return prior !== undefined && (facts.overflow < prior.overflow || facts.origin < prior.origin);
}

interface Native {
  id: string;
  title: string;
  cwd?: string;
  cols: number;
  rows: number;
  windowId: string;
  windowNumber: number;
  tabId: string;
  tabIndex: number;
  paneIndex: number;
  tmuxWindowId?: string;
  /** the `jobName` variable -- executable name only (e.g. `herdr`, `tmux`, `zsh`). */
  job?: string;
}

const UNAVAILABLE_HINT =
  "iTerm2 → Settings → General → Magic → ✓ Enable Python API, then run `shellbell` again.";

function errName(err: unknown): string {
  return safeErrorName(err);
}

export class ITerm2Backend implements TerminalBackend {
  readonly name = "iterm2" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    prompts: true,
    createSession: true,
    terminalInput: true,
    focus: true,
    history: true,
    absoluteLines: true,
  };
  private sessions = new Map<string, Native>();
  private readonly historyOwnership = new Map<string, HistoryOwnership>();
  private readonly historyCaptures = new WeakMap<HistoryCapture, CaptureEvidence>();
  private order: string[] = [];
  private focused: string | null = null;
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly subscribed = new Set<string>();
  private readonly log: Logger;

  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private connectionGeneration = 0;

  // Single-flight layout refresh: at most one `runApplyLayout` executes at a time. A layout
  // that arrives while one is in flight replaces `layoutDirty` (only the latest is kept) and
  // is picked up as exactly one more refresh once the current one completes.
  private layoutBusy = false;
  private layoutDirty: ListSessionsResponse | null = null;
  private layoutRefresh: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: ITerm2Client,
    log: Logger,
    private readonly backoff: { minMs?: number; maxMs?: number } = {},
  ) {
    this.log = log.child({ backend: "iterm2" });
    this.client.on("notification", (n) => this.onNotification(n));
    this.client.on("close", () => {
      this.invalidateConnection();
      this.scheduleReconnect();
    });
  }

  get isConnected(): boolean {
    return !this.closed && this.client.connected;
  }

  private invalidateConnection(): void {
    this.connectionGeneration++;
    this.layoutBusy = false;
    this.layoutDirty = null;
    const ids = [...this.sessions.keys()];
    this.sessions.clear();
    this.historyOwnership.clear();
    this.order = [];
    this.subscribed.clear();
    this.focused = null;
    for (const sessionId of ids) this.emit({ type: "session-removed", sessionId });
    this.emit({ type: "layout-changed" });
  }

  private ownsConnection(generation: number): boolean {
    return generation === this.connectionGeneration && this.isConnected;
  }

  /** 1 s -> 2 s -> 4 s -> 8 s -> 16 s -> 30 s cap, fresh cookie each attempt. */
  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const min = this.backoff.minMs ?? 1000;
    const max = this.backoff.maxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.log.info("iTerm2 gone; retrying", { delayMs: delay, attempt: this.attempt });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const generation = this.connectionGeneration;
      void this.connect().catch((err) => {
        if (generation !== this.connectionGeneration || this.closed) return;
        this.log.warn("iTerm2 reconnect failed", { error: errName(err) });
        this.scheduleReconnect();
      });
    }, delay);
  }

  async connect(): Promise<void> {
    this.closed = false;
    const generation = this.connectionGeneration;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.client.connected) {
      try {
        await this.client.connect();
      } catch (err) {
        if (generation !== this.connectionGeneration || this.closed) return;
        throw new BackendUnavailable(String(err), UNAVAILABLE_HINT);
      }
    }
    if (!this.ownsConnection(generation)) {
      // A stopped backend must not keep a transport whose handshake finished late.
      if (this.closed) this.client.close();
      return;
    }
    // The socket handshake succeeding does not mean iTerm2's API is actually usable (the
    // Python API toggle can still reject every RPC) -- `attempt` is only reset once the full
    // post-handshake sequence below succeeds, and any failure here is surfaced the same way
    // as a handshake failure: BackendUnavailable with the same actionable hint.
    try {
      for (const t of [
        NotificationType.NOTIFY_ON_LAYOUT_CHANGE,
        NotificationType.NOTIFY_ON_NEW_SESSION,
        NotificationType.NOTIFY_ON_TERMINATE_SESSION,
        NotificationType.NOTIFY_ON_FOCUS_CHANGE,
      ]) {
        await this.client.request({
          case: "notificationRequest",
          value: create(NotificationRequestSchema, { subscribe: true, notificationType: t }),
        });
        if (!this.ownsConnection(generation)) return;
      }
      const ls = await this.client.request({
        case: "listSessionsRequest",
        value: create(ListSessionsRequestSchema, {}),
      });
      if (!this.ownsConnection(generation)) return;
      if (ls.submessage.case === "listSessionsResponse")
        await this.applyLayout(ls.submessage.value, generation);
      if (!this.ownsConnection(generation)) return;
      const focus = await this.client.request({
        case: "focusRequest",
        value: create(FocusRequestSchema, {}),
      });
      if (!this.ownsConnection(generation)) return;
      if (focus.submessage.case === "focusResponse") {
        for (const n of focus.submessage.value.notifications)
          if (n.event.case === "session") this.focused = n.event.value;
      }
    } catch (err) {
      if (!this.ownsConnection(generation)) return;
      throw new BackendUnavailable(String(err), UNAVAILABLE_HINT);
    }
    this.attempt = 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.invalidateConnection();
    this.client.close();
  }

  async notificationFacts(sessionId: string) {
    const n = this.sessions.get(sessionId);
    if (!n || !this.isConnected) return undefined;
    return makeNotificationFacts(
      {
        sessionId,
        cwd: n.cwd,
        title: n.title,
        sessionLabel: `iTerm2 · Window ${n.windowNumber} · Tab ${n.tabIndex + 1} · Pane ${n.paneIndex + 1}`,
      },
      n.job,
      "reported",
    );
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.order
      .map((id) => this.sessions.get(id))
      .filter((n): n is Native => n !== undefined)
      .map((n) => this.toInfo(n));
  }

  tmuxWindowIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions.values()) if (s.tmuxWindowId) out.add(s.tmuxWindowId);
    return out;
  }

  /**
   * the `jobName` of the process running in `sessionId`, or `undefined` for a `-CC`
   * integration tab (it already carries a `tmux_window_id`, so the tmux-side rule de-dupes it
   * instead -- this method must not also report it as a `tmux` host job, or the registry would
   * try to hide it a second, wrong way).
   */
  hostJob(sessionId: string): string | undefined {
    const n = this.sessions.get(sessionId);
    if (!n || n.tmuxWindowId) return undefined;
    return n.job;
  }

  async getScreen(sessionId: string, options?: ScreenReadOptions): Promise<Screen> {
    const native = this.sessions.get(sessionId);
    if (!native) throw new SessionGone(sessionId);
    const ownership = this.historyOwnership.get(sessionId);
    const attempt =
      options?.history && ownership
        ? {
            sessionId,
            connectionGeneration: this.connectionGeneration,
            coordinateRevision: ownership.coordinateRevision,
            cols: native.cols,
            rows: native.rows,
          }
        : undefined;
    const activity = ownership?.activityRevision;
    const observed = ownership?.observed;
    const initial = attempt ? await this.fetchHistoryFacts(sessionId) : null;
    // Contradictory facts already invalidate this epoch, even if the live buffer
    // request fails or remains pending. Preserve its ordinary result/error path.
    if (
      attempt &&
      initial &&
      this.ownsHistory(attempt) &&
      (initial.grid !== attempt.rows || historyRegressed(initial, observed))
    )
      this.revokeHistory(sessionId);
    const res = await this.client.request({
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: sessionId,
        lineRange: create(LineRangeSchema, { screenContentsOnly: true }),
        includeStyles: true,
      }),
    });
    if (res.submessage.case !== "getBufferResponse" || res.submessage.value.status !== 0)
      throw new SessionGone(sessionId);
    const buffer = res.submessage.value;
    let capture: HistoryCapture | undefined;
    if (
      attempt &&
      initial &&
      initial.grid === attempt.rows &&
      this.ownsHistory(attempt) &&
      this.historyOwnership.get(sessionId)?.activityRevision === activity &&
      hasFullRowRange(buffer, initial.origin, initial.origin + initial.grid)
    ) {
      const final = await this.fetchHistoryFacts(sessionId);
      // Check the caller continuation as well: the helper's promise can settle before a
      // notification changes ownership, but publication still belongs to this attempt.
      if (
        final &&
        this.ownsHistory(attempt) &&
        (final.grid !== attempt.rows || historyRegressed(final, initial))
      )
        this.revokeHistory(sessionId);
      if (
        final &&
        sameHistoryFacts(initial, final) &&
        this.ownsHistory(attempt) &&
        this.historyOwnership.get(sessionId)?.activityRevision === activity
      ) {
        this.observeHistory(sessionId, final);
        capture = Object.freeze({});
        this.historyCaptures.set(
          capture,
          Object.freeze({ ...attempt, facts: Object.freeze(initial) }),
        );
      }
    }
    const screen = bufferToScreen(buffer, native.rows, native.cols);
    if (capture) screen.historyCapture = capture;
    return screen;
  }

  private ownsHistory(evidence: Omit<CaptureEvidence, "facts">): boolean {
    const native = this.sessions.get(evidence.sessionId);
    return (
      this.ownsConnection(evidence.connectionGeneration) &&
      this.historyOwnership.get(evidence.sessionId)?.coordinateRevision ===
        evidence.coordinateRevision &&
      native?.cols === evidence.cols &&
      native.rows === evidence.rows
    );
  }

  private revokeHistory(sessionId: string): void {
    const ownership = this.historyOwnership.get(sessionId);
    if (!ownership) return;
    ownership.coordinateRevision = {};
    ownership.observed = undefined;
  }

  private observeHistory(sessionId: string, facts: ITermHistoryFacts): void {
    const ownership = this.historyOwnership.get(sessionId);
    if (!ownership) return;
    ownership.observed = {
      overflow: Math.max(facts.overflow, ownership.observed?.overflow ?? 0),
      origin: Math.max(facts.origin, ownership.observed?.origin ?? 0),
    };
  }

  private async fetchHistoryFacts(sessionId: string): Promise<ITermHistoryFacts | null> {
    try {
      const reply = await this.client.request({
        case: "getPropertyRequest",
        value: create(GetPropertyRequestSchema, {
          identifier: { case: "sessionId", value: sessionId },
          name: "number_of_lines",
        }),
      });
      return reply.submessage.case === "getPropertyResponse" && reply.submessage.value.status === 0
        ? parseHistoryFacts(reply.submessage.value.jsonValue)
        : null;
    } catch {
      return null;
    }
  }

  async getHistoryPage(sessionId: string, request: HistoryReadRequest): Promise<HistoryReadResult> {
    assertHistoryReadRequest(request);
    if (request.signal.aborted) return { status: "cancelled" };
    if (!this.sessions.has(sessionId)) throw new SessionGone(sessionId);
    const evidence = this.historyCaptures.get(request.capture);
    if (!evidence || evidence.sessionId !== sessionId)
      return { status: "unavailable", reason: "unanchored" };

    const interrupted = (): HistoryReadResult | undefined => {
      if (request.signal.aborted) return { status: "cancelled" };
      if (!this.ownsHistory(evidence)) return { status: "reset" };
    };
    const admission = interrupted();
    if (admission) return admission;
    if (request.reported !== evidence.facts.origin)
      return { status: "unavailable", reason: "unanchored" };
    const activity = this.historyOwnership.get(sessionId)?.activityRevision;
    // Freeze the observation baseline at entry. Concurrent completions can raise the
    // high-water marks, but cannot turn this attempt's older reply into a regression.
    const observed = this.historyOwnership.get(sessionId)?.observed ?? evidence.facts;
    const changed: HistoryReadResult = { status: "unavailable", reason: "changed" };
    const validateFacts = (
      facts: ITermHistoryFacts | null,
      prior = observed,
    ): HistoryReadResult | undefined => {
      if (!facts) return changed;
      if (facts.grid !== evidence.rows || historyRegressed(facts, prior)) {
        // Only revoke the coordinate revision still owned by this attempt. Callers
        // check ownership before reaching here, so stale facts cannot revoke a replacement.
        const owned = this.historyOwnership.get(sessionId);
        if (owned?.coordinateRevision === evidence.coordinateRevision)
          this.revokeHistory(sessionId);
        return { status: "reset" };
      }
    };

    const initial = await this.fetchHistoryFacts(sessionId);
    const initialStop = interrupted() ?? validateFacts(initial);
    if (initialStop) return initialStop;
    if (!initial) return changed;
    const oldestAvailable = initial.overflow;
    const from = Math.max(request.before - request.count, oldestAvailable);
    let lines: Line[] | undefined;
    if (request.before > oldestAvailable) {
      try {
        const reply = await this.client.request({
          case: "getBufferRequest",
          value: create(GetBufferRequestSchema, {
            session: sessionId,
            lineRange: create(LineRangeSchema, {
              windowedCoordRange: create(WindowedCoordRangeSchema, {
                coordRange: create(CoordRangeSchema, {
                  start: create(CoordSchema, { x: 0, y: BigInt(from) }),
                  end: create(CoordSchema, { x: 0, y: BigInt(request.before) }),
                }),
              }),
            }),
            includeStyles: true,
          }),
        });
        const rangeStop = interrupted();
        if (rangeStop) return rangeStop;
        if (
          reply.submessage.case !== "getBufferResponse" ||
          !hasFullRowRange(reply.submessage.value, from, request.before)
        )
          return changed;
        lines = reply.submessage.value.contents.map(lineContentsToLine);
      } catch {
        return interrupted() ?? changed;
      }
    }
    const final = await this.fetchHistoryFacts(sessionId);
    const finalStop = interrupted() ?? validateFacts(final, initial);
    if (finalStop) return finalStop;
    if (
      !final ||
      !sameHistoryFacts(initial, final) ||
      this.historyOwnership.get(sessionId)?.activityRevision !== activity
    )
      return changed;
    this.observeHistory(sessionId, final);
    if (lines) return { status: "page", from, to: request.before, oldestAvailable, lines };
    return {
      status: "boundary",
      reason: request.before === oldestAvailable ? "end" : "truncated",
      oldestAvailable,
    };
  }

  async getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    if (!this.sessions.has(sessionId)) throw new SessionGone(sessionId);
    const start = Math.max(0, before - count);
    const res = await this.client.request({
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: sessionId,
        lineRange: create(LineRangeSchema, {
          windowedCoordRange: create(WindowedCoordRangeSchema, {
            coordRange: create(CoordRangeSchema, {
              start: create(CoordSchema, { x: 0, y: BigInt(start) }),
              end: create(CoordSchema, { x: 0, y: BigInt(before) }),
            }),
          }),
        }),
        includeStyles: true,
      }),
    });
    if (res.submessage.case !== "getBufferResponse" || res.submessage.value.status !== 0)
      throw new SessionGone(sessionId);
    const lines = res.submessage.value.contents.map(lineContentsToLine);
    const oldestAvailable = lines.length < before - start ? before - lines.length : 0;
    return { lines, oldestAvailable };
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    const res = await this.client.request({
      case: "sendTextRequest",
      value: create(SendTextRequestSchema, { session: sessionId, text, suppressBroadcast: true }),
    });
    if (res.submessage.case !== "sendTextResponse") throw new SessionGone(sessionId);
    const status = res.submessage.value.status;
    if (status === SendTextResponse_Status.SESSION_NOT_FOUND) throw new SessionGone(sessionId);
    if (status !== SendTextResponse_Status.OK)
      throw new Error(`sendText failed: ${SendTextResponse_Status[status]}`);
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    await this.sendText(sessionId, data);
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "tab") {
      const res = await this.client.request({
        case: "createTabRequest",
        value: create(CreateTabRequestSchema, { windowId: where.windowId, selectTab: false }),
      });
      if (res.submessage.case !== "createTabResponse" || !res.submessage.value.sessionId)
        throw new Error("create tab failed");
      return res.submessage.value.sessionId;
    }
    const res = await this.client.request({
      case: "splitPaneRequest",
      value: create(SplitPaneRequestSchema, {
        session: where.sessionId,
        splitDirection:
          where.direction === "vertical"
            ? SplitPaneRequest_SplitDirection.VERTICAL
            : SplitPaneRequest_SplitDirection.HORIZONTAL,
      }),
    });
    const id =
      res.submessage.case === "splitPaneResponse" ? res.submessage.value.sessionId[0] : undefined;
    if (!id) throw new Error("split failed");
    return id;
  }

  async focus(sessionId: string): Promise<void> {
    await this.client.request({
      case: "activateRequest",
      value: create(ActivateRequestSchema, {
        identifier: { case: "sessionId", value: sessionId },
        orderWindowFront: true,
        selectTab: true,
        selectSession: true,
        activateApp: create(ActivateRequest_AppSchema, {
          raiseAllWindows: false,
          ignoringOtherApps: false,
        }),
      }),
    });
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- internals ----

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.warn("event handler failed", { error: errName(err) });
      }
    }
  }

  private toInfo(n: Native): SessionInfo {
    return {
      id: n.id,
      backend: "iterm2",
      title: n.title,
      cwd: n.cwd,
      cols: n.cols,
      rows: n.rows,
      windowId: n.windowId,
      windowNumber: n.windowNumber,
      tabId: n.tabId,
      tabIndex: n.tabIndex,
      paneIndex: n.paneIndex,
      isFocusedOnMac: this.focused === n.id,
      state: "unknown",
    };
  }

  /** Coalescing single-flight wrapper around `runApplyLayout` -- see `layoutBusy`/`layoutDirty`. */
  private applyLayout(layout: ListSessionsResponse, generation: number): Promise<void> {
    if (!this.ownsConnection(generation)) return Promise.resolve();
    this.layoutDirty = layout;
    if (this.layoutBusy) return this.layoutRefresh;
    this.layoutBusy = true;
    this.layoutRefresh = this.drainLayout(generation);
    return this.layoutRefresh;
  }

  private async drainLayout(generation: number): Promise<void> {
    try {
      while (this.ownsConnection(generation) && this.layoutDirty) {
        const layout = this.layoutDirty;
        this.layoutDirty = null;
        await this.runApplyLayout(layout, generation);
      }
    } finally {
      // Never leave the single-flight lock held: a throw here would wedge every later
      // layout refresh and every reconnect that awaits applyLayout().
      if (generation === this.connectionGeneration) this.layoutBusy = false;
    }
  }

  private async runApplyLayout(layout: ListSessionsResponse, generation: number): Promise<void> {
    const next = new Map<string, Native>();
    const order: string[] = [];
    const windows = [...layout.windows].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    for (const w of windows) {
      w.tabs.forEach((tab, tabIndex) => {
        let paneIndex = 0;
        const walk = (node: SplitTreeNode | undefined) => {
          if (!node) return;
          for (const link of node.links) {
            if (link.child.case === "session") {
              const s = link.child.value;
              const id = s.uniqueIdentifier ?? "";
              const prev = this.sessions.get(id);
              next.set(id, {
                id,
                title: prev?.title || s.title || "Session",
                cwd: prev?.cwd,
                job: prev?.job,
                cols: s.gridSize?.width ?? 80,
                rows: s.gridSize?.height ?? 24,
                windowId: w.windowId ?? "",
                windowNumber: w.number ?? 0,
                tabId: tab.tabId ?? "",
                tabIndex,
                paneIndex: paneIndex++,
                tmuxWindowId: tab.tmuxWindowId || undefined,
              });
              order.push(id);
            } else if (link.child.case === "node") walk(link.child.value);
          }
        };
        walk(tab.root);
      });
    }
    for (const id of this.sessions.keys())
      if (!next.has(id)) {
        this.subscribed.delete(id);
        this.historyOwnership.delete(id);
      }
    for (const [id, native] of next) {
      const previous = this.sessions.get(id);
      if (
        !this.historyOwnership.has(id) ||
        previous?.cols !== native.cols ||
        previous.rows !== native.rows
      )
        this.historyOwnership.set(id, { coordinateRevision: {}, activityRevision: {} });
    }
    this.sessions = next;
    this.order = order;
    await Promise.all(order.map((id) => this.ensureSession(id, generation)));
    if (!this.ownsConnection(generation)) return;
    this.emit({ type: "layout-changed" });
  }

  /**
   * Subscribes to a session's notifications and seeds its title/cwd exactly once -- runs only
   * the first time a session id is seen (`variable_changed_notification` keeps
   * title/cwd fresh afterwards, so re-fetching on every LayoutChange is both wasteful and racy).
   */
  private async ensureSession(id: string, generation: number): Promise<void> {
    const session = this.sessions.get(id);
    const current = () => this.ownsConnection(generation) && this.sessions.get(id) === session;
    if (!session || !current()) return;
    if (this.subscribed.has(id)) return;
    this.subscribed.add(id);
    const subs = [
      create(NotificationRequestSchema, {
        session: id,
        subscribe: true,
        notificationType: NotificationType.NOTIFY_ON_SCREEN_UPDATE,
      }),
      create(NotificationRequestSchema, {
        session: id,
        subscribe: true,
        notificationType: NotificationType.NOTIFY_ON_PROMPT,
        arguments: {
          case: "promptMonitorRequest",
          value: create(PromptMonitorRequestSchema, {
            modes: [
              PromptMonitorMode.PROMPT,
              PromptMonitorMode.COMMAND_START,
              PromptMonitorMode.COMMAND_END,
            ],
          }),
        },
      }),
      ...["session.name", "session.path", "jobName"].map((name) =>
        create(NotificationRequestSchema, {
          session: id,
          subscribe: true,
          notificationType: NotificationType.NOTIFY_ON_VARIABLE_CHANGE,
          arguments: {
            case: "variableMonitorRequest",
            value: create(VariableMonitorRequestSchema, {
              name,
              scope: VariableScope.SESSION,
              identifier: id,
            }),
          },
        }),
      ),
    ];
    for (const s of subs) {
      try {
        await this.client.request({ case: "notificationRequest", value: s });
      } catch (err) {
        if (!current()) return;
        this.log.warn("subscribe failed", { session: id.slice(0, 8), error: errName(err) });
      }
      if (!current()) return;
    }
    // The session may have been removed (terminate-session) while the subscription round
    // trips above were in flight -- re-check before touching it, and again after the variable
    // fetch's own awaits, rather than trusting a reference captured before any `await`.
    if (!current()) return;
    const [name, path, job] = await Promise.all([
      this.variable(id, "session.name"),
      this.variable(id, "session.path"),
      this.variable(id, "jobName"),
    ]);
    if (!current()) return;
    if (name) session.title = name;
    if (path) session.cwd = path;
    if (job) session.job = job;
  }

  private async variable(id: string, name: string): Promise<string | undefined> {
    try {
      const res = await this.client.request({
        case: "variableRequest",
        value: create(VariableRequestSchema, {
          scope: { case: "sessionId", value: id },
          get: [name],
        }),
      });
      if (res.submessage.case !== "variableResponse" || res.submessage.value.status !== 0)
        return undefined;
      const raw = res.submessage.value.values[0];
      if (!raw || raw === "null") return undefined;
      const v = JSON.parse(raw);
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private onNotification(n: Notification): void {
    const generation = this.connectionGeneration;
    if (!this.ownsConnection(generation)) return;
    const now = Date.now();
    if (n.screenUpdateNotification?.session) {
      const ownership = this.historyOwnership.get(n.screenUpdateNotification.session);
      if (ownership) ownership.activityRevision = {};
      this.emit({ type: "screen-changed", sessionId: n.screenUpdateNotification.session });
      return;
    }
    if (n.promptNotification?.session) {
      const p = n.promptNotification;
      const sid = p.session as string;
      if (p.event.case === "commandStart")
        this.emit({
          type: "command-start",
          sessionId: sid,
          command: p.event.value.command ?? "",
          at: now,
        });
      else if (p.event.case === "commandEnd")
        this.emit({
          type: "command-end",
          sessionId: sid,
          exitCode: p.event.value.status ?? 0,
          at: now,
        });
      else if (p.event.case === "prompt") this.emit({ type: "prompt", sessionId: sid, at: now });
      return;
    }
    if (n.layoutChangedNotification?.listSessionsResponse) {
      // Invalidate synchronously, before metadata/subscription awaits can publish a layout.
      for (const id of this.historyOwnership.keys()) this.revokeHistory(id);
      void this.applyLayout(n.layoutChangedNotification.listSessionsResponse, generation).catch(
        (err) => {
          if (!this.ownsConnection(generation)) return;
          this.log.warn("layout refresh failed", { error: errName(err) });
        },
      );
      return;
    }
    if (n.newSessionNotification?.sessionId) {
      void this.client
        .request({ case: "listSessionsRequest", value: create(ListSessionsRequestSchema, {}) })
        .then((ls) => {
          if (!this.ownsConnection(generation)) return;
          if (ls.submessage.case === "listSessionsResponse")
            return this.applyLayout(ls.submessage.value, generation);
        })
        .catch((err) => {
          if (!this.ownsConnection(generation)) return;
          this.log.warn("new-session layout refresh failed", { error: errName(err) });
        });
      this.emit({ type: "session-added", sessionId: n.newSessionNotification.sessionId });
      return;
    }
    if (n.terminateSessionNotification?.sessionId) {
      const id = n.terminateSessionNotification.sessionId;
      this.sessions.delete(id);
      this.historyOwnership.delete(id);
      this.subscribed.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this.emit({ type: "session-removed", sessionId: id });
      this.emit({ type: "layout-changed" });
      return;
    }
    if (n.focusChangedNotification) {
      if (n.focusChangedNotification.event.case === "session")
        this.focused = n.focusChangedNotification.event.value;
      this.emit({ type: "focus-changed" });
      return;
    }
    if (n.variableChangedNotification?.identifier) {
      const v = n.variableChangedNotification;
      const s = this.sessions.get(v.identifier as string);
      if (!s) return;
      try {
        const val = JSON.parse(v.jsonNewValue ?? "null");
        if (v.name === "session.name" && typeof val === "string") s.title = val;
        if (v.name === "session.path" && typeof val === "string") s.cwd = val;
        // Do not log `val` here -- `jobName` can name a private tool.
        if (v.name === "jobName" && typeof val === "string") s.job = val;
      } catch {
        return;
      }
      this.emit({ type: "title-changed", sessionId: s.id });
    }
  }
}
