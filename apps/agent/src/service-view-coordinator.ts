import {
  MAX_PAIRINGS,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  StreamMessageSchema,
} from "@shellbell/protocol";
import { AgentScreenStream } from "./agent-screen-stream.js";
import { AgentVtStream } from "./agent-vt-stream.js";
import { BackendRegistry, splitId } from "./backends/registry.js";
import type { Logger } from "./log.js";
import { ScreenTracker } from "./screen-tracker.js";
import { WireScheduler } from "./wire-scheduler.js";

export interface ServiceViewCoordinatorOptions {
  backend: BackendRegistry;
  log: Logger;
  now: () => number;
  newTransferId: () => string;
  onSessionGone?: (sessionId: string) => void;
  onError?: () => void;
}

export interface ServiceViewConnection {
  sendChunk: (message: StreamChunk) => boolean;
  sendControl: (message: StreamMessage) => boolean;
}

export interface ServiceViewLease {
  readonly viewedSessionId: string | null;
  receive(message: StreamMessage, envelopeBytes: number): void;
  close(): void;
}

type View = {
  sessionId: string;
  trackerKey: string;
  subscriptionId: string;
  /** Snapshots prepared by the screen tracker, or the terminal's own bytes. */
  stream: AgentScreenStream | AgentVtStream;
};
type Entry = {
  id: string;
  connection: ServiceViewConnection;
  view: View | null;
  closingView: View | null;
  unregister: () => void;
  revision: number;
};

/** Service view adapter. The endpoint owns handshake/key fences before calling a lease. */
export class ServiceViewCoordinator {
  private readonly options: ServiceViewCoordinatorOptions;
  private readonly tracker: ScreenTracker;
  private readonly scheduler: WireScheduler;
  private readonly entries = new Map<string, Entry>();
  private readonly viewerOwners = new Map<string, { entry: Entry; view: View }>();
  private readonly attachTokens = new Map<string, object>();
  private readonly herdrCaptureFailures = new Map<string, NodeJS.Timeout>();
  private started = false;
  private lifecycle = 0;
  private pumping = false;
  private timer: NodeJS.Timeout | null = null;
  private timerEpoch = 0;
  private nextViewer = 0;

  constructor(options: ServiceViewCoordinatorOptions) {
    if (!(options.backend instanceof BackendRegistry)) {
      throw new TypeError("Service view backend must be a BackendRegistry");
    }
    if (!Number.isFinite(options.now())) throw new RangeError("Service view clock must be finite");
    this.options = { ...options };
    this.scheduler = new WireScheduler({
      now: () => this.options.now(),
      onError: () => this.notifyError(),
    });
    this.tracker = new ScreenTracker({
      backend: this.options.backend,
      log: this.options.log,
      now: () => this.options.now(),
      delivery: "scheduled",
      onReady: () => {
        this.pump();
      },
      onSessionGone: (sessionId, removedConnections) =>
        this.sessionGone(sessionId, removedConnections),
      onCaptureResult: (sessionId, error) => this.captureResult(sessionId, error),
    });
  }

  start(): void {
    if (this.started) return;
    if (!Number.isFinite(this.options.now()))
      throw new RangeError("Service view clock must be finite");
    this.lifecycle++;
    this.started = true;
    this.tracker.start();
  }

  stop(): void {
    if (!this.started) return;
    this.lifecycle++;
    this.started = false;
    this.clearTimer();
    for (const timer of this.herdrCaptureFailures.values()) clearTimeout(timer);
    this.herdrCaptureFailures.clear();
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.unregister();
    this.tracker.stop();
    for (const entry of entries) this.dropView(entry);
  }

  attach(connectionId: string, connection: ServiceViewConnection): ServiceViewLease {
    if (!this.started) throw new TypeError("Service view coordinator is stopped");
    if (
      typeof connectionId !== "string" ||
      connectionId.length === 0 ||
      connectionId.length > 256 ||
      !connection
    ) {
      throw new TypeError("Invalid service view connection");
    }
    if (!this.entries.has(connectionId) && this.entries.size >= MAX_PAIRINGS) {
      throw new RangeError("Too many service view connections");
    }
    const lifecycle = this.lifecycle;
    const token = {};
    this.attachTokens.set(connectionId, token);
    try {
      const previous = this.entries.get(connectionId);
      if (previous) this.retire(previous);
      const copied = { ...connection };
      const entry: Entry = {
        id: connectionId,
        connection: copied,
        view: null,
        closingView: null,
        unregister: () => {},
        revision: 0,
      };
      if (
        this.started &&
        this.lifecycle === lifecycle &&
        this.attachTokens.get(connectionId) === token &&
        !this.entries.has(connectionId)
      ) {
        // Retirement and connection getter access can reenter attach with a
        // different ID, so admission must be checked at installation too.
        if (this.entries.size >= MAX_PAIRINGS)
          throw new RangeError("Too many service view connections");
        this.entries.set(connectionId, entry);
        entry.unregister = this.scheduler.register(connectionId, () => this.produce(entry));
      }
      const coordinator = this;
      return {
        get viewedSessionId() {
          return coordinator.current(entry) ? (entry.view?.sessionId ?? null) : null;
        },
        receive: (message, envelopeBytes) => this.receive(entry, message, envelopeBytes),
        close: () => this.retire(entry),
      };
    } finally {
      if (this.attachTokens.get(connectionId) === token) this.attachTokens.delete(connectionId);
    }
  }

  setIntervalMs(ms: number): void {
    if (!Number.isFinite(ms)) throw new TypeError("Invalid service view interval");
    this.tracker.setIntervalMs(ms);
  }

  pump(): number {
    if (!this.started || this.pumping) return 0;
    this.pumping = true;
    let admitted = 0;
    try {
      if (!Number.isFinite(this.options.now()))
        throw new RangeError("Service view clock must be finite");
      for (const entry of [...this.entries.values()]) {
        if (this.current(entry) && entry.view) entry.view.stream.tick();
      }
      if (this.started) admitted = this.scheduler.pump();
      return admitted;
    } catch {
      this.stop();
      this.notifyError();
      return 0;
    } finally {
      this.pumping = false;
      this.arm();
    }
  }

  private current(entry: Entry): boolean {
    return this.started && this.entries.get(entry.id) === entry;
  }

  private receive(entry: Entry, message: StreamMessage, envelopeBytes: number): void {
    if (!this.current(entry)) return;
    const revision = entry.revision;
    const initialView = entry.view;
    let validated: StreamMessage | null = null;
    try {
      if (
        Number.isSafeInteger(envelopeBytes) &&
        envelopeBytes >= 1 &&
        envelopeBytes <= STREAM_LIMITS.envelopeBytes
      ) {
        const parsed = StreamMessageSchema.safeParse(message);
        if (parsed.success) validated = parsed.data;
      }
    } catch {
      // A hostile getter is malformed input, not authority to keep a view alive.
    }
    if (!this.current(entry) || entry.revision !== revision || entry.view !== initialView) return;
    if (!validated) {
      initialView?.stream.terminate("invalid-transfer");
      return;
    }
    if (validated.type === "stream.subscribe") {
      const old = entry.view;
      if (old && old.subscriptionId === validated.subscriptionId) {
        if (old.sessionId !== validated.sessionId) old.stream.terminate("invalid-transfer");
        return;
      }
      // Only a new subscription may supersede an in-progress creation. Ignored
      // controls delivered by cleanup callbacks must not steal that authority.
      const creationRevision = ++entry.revision;
      this.dropView(entry);
      if (!this.current(entry) || entry.revision !== creationRevision) return;
      const view: View = {
        sessionId: validated.sessionId,
        subscriptionId: validated.subscriptionId,
        trackerKey: this.viewerKey(),
        stream: null as unknown as AgentScreenStream,
      };
      if (validated.mode === "vt" && this.openVtView(entry, view, creationRevision)) return;
      view.stream = new AgentScreenStream({
        subscriptionId: view.subscriptionId,
        sessionId: view.sessionId,
        now: () => this.options.now(),
        newTransferId: () => this.options.newTransferId(),
        sendChunk: (chunk) =>
          this.current(entry) && entry.view === view && entry.connection.sendChunk(chunk),
        sendControl: (control) =>
          this.current(entry) &&
          (entry.view === view || entry.closingView === view) &&
          entry.connection.sendControl(control),
        requestSnapshot: () => {
          if (this.current(entry) && entry.view === view)
            this.tracker.forceSnapshot(view.trackerKey, view.sessionId);
        },
        onClosed: () => {
          if (this.current(entry) && entry.view === view) this.dropView(entry);
        },
        history: {
          read: (sessionId, request) => this.options.backend.getHistoryPage(sessionId, request),
          onReady: () => {
            if (this.current(entry) && entry.view === view) this.pump();
          },
        },
      });
      if (!this.current(entry) || entry.revision !== creationRevision) {
        view.stream.cancel();
        return;
      }
      entry.view = view;
      this.viewerOwners.set(view.trackerKey, { entry, view });
      this.tracker.setViewed(view.trackerKey, view.sessionId, {
        history: true,
        preparation: "bounded",
      });
      if (!this.current(entry) || entry.revision !== creationRevision || entry.view !== view)
        return;
      this.arm();
      return;
    }
    if (initialView?.subscriptionId !== validated.subscriptionId) return;
    try {
      initialView.stream.receive(message, envelopeBytes);
    } catch {
      if (this.current(entry) && entry.revision === revision && entry.view === initialView)
        initialView.stream.terminate("invalid-transfer");
    }
    this.pump();
  }

  /**
   * Starts a raw terminal view when the session's backend streams its own bytes; false leaves
   * the caller to start a snapshot view, which every subscriber also understands.
   */
  private openVtView(entry: Entry, view: View, creationRevision: number): boolean {
    if (!this.options.backend.capabilitiesOf(view.sessionId)?.vtStream) return false;
    let stream: AgentVtStream;
    try {
      stream = new AgentVtStream({
        subscriptionId: view.subscriptionId,
        sessionId: view.sessionId,
        source: this.options.backend.openVtStream(view.sessionId),
        now: () => this.options.now(),
        newTransferId: () => this.options.newTransferId(),
        sendChunk: (chunk) =>
          this.current(entry) && entry.view === view && entry.connection.sendChunk(chunk),
        sendControl: (control) =>
          this.current(entry) &&
          (entry.view === view || entry.closingView === view) &&
          entry.connection.sendControl(control),
        onReady: () => {
          if (this.current(entry) && entry.view === view) this.pump();
        },
        onClosed: () => {
          if (this.current(entry) && entry.view === view) this.dropView(entry);
        },
      });
    } catch {
      return false;
    }
    if (!this.current(entry) || entry.revision !== creationRevision) {
      stream.cancel();
      return true;
    }
    view.stream = stream;
    entry.view = view;
    this.viewerOwners.set(view.trackerKey, { entry, view });
    stream.start().catch(() => stream.terminate("invalid-transfer"));
    this.arm();
    return true;
  }

  private produce(entry: Entry): boolean {
    if (!this.current(entry)) return false;
    try {
      const view = entry.view;
      if (!view) return false;
      if (view.stream instanceof AgentScreenStream && view.stream.canOfferScreen()) {
        this.tracker.offerPrepared(view.trackerKey, (message, context) => {
          if (message.type !== "screen.snapshot" && message.type !== "screen.diff") return false;
          return view.stream instanceof AgentScreenStream && view.stream.offer(message, context);
        });
      }
      if (!this.current(entry) || entry.view !== view) return false;
      return view.stream.sendOne();
    } catch {
      this.retire(entry);
      throw new Error("Service view producer failed");
    }
  }

  private viewerKey(): string {
    return `service-view-${++this.nextViewer}`;
  }

  private dropView(entry: Entry): void {
    const view = entry.view;
    if (!view) return;
    entry.view = null;
    if (this.viewerOwners.get(view.trackerKey)?.view === view)
      this.viewerOwners.delete(view.trackerKey);
    this.tracker.dropViewer(view.trackerKey);
    view.stream.cancel();
  }

  private retire(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id);
    entry.unregister();
    this.dropView(entry);
    this.arm();
  }

  private captureResult(sessionId: string, error?: unknown): void {
    if (splitId(sessionId)?.name !== "herdr") return;
    const pending = this.herdrCaptureFailures.get(sessionId);
    if (error === undefined) {
      if (pending) clearTimeout(pending);
      this.herdrCaptureFailures.delete(sessionId);
      return;
    }
    if (pending || !this.started) return;
    const affected = [...this.entries.values()].flatMap((entry) => {
      const view = entry.view;
      return view &&
        view.sessionId === sessionId &&
        this.current(entry) &&
        view.stream instanceof AgentScreenStream &&
        view.stream.hasAcceptedSnapshot()
        ? [{ entry, view, stream: view.stream }]
        : [];
    });
    if (affected.length === 0) return;
    // Independent of the next getScreen call: a hung read must not extend the
    // post-first-screen deadline. The first screen has its own admission timer.
    const timer = setTimeout(() => {
      if (this.herdrCaptureFailures.get(sessionId) !== timer) return;
      this.herdrCaptureFailures.delete(sessionId);
      for (const { entry, view, stream } of affected) {
        if (!this.current(entry) || entry.view !== view) continue;
        stream.terminate("stalled");
      }
    }, 3_000);
    timer.unref?.();
    this.herdrCaptureFailures.set(sessionId, timer);
  }

  private sessionGone(sessionId: string, removedConnections: readonly string[]): void {
    const pending = this.herdrCaptureFailures.get(sessionId);
    if (pending) clearTimeout(pending);
    this.herdrCaptureFailures.delete(sessionId);
    const affected: { entry: Entry; view: View }[] = [];
    for (const key of removedConnections) {
      const owner = this.viewerOwners.get(key);
      if (
        owner &&
        owner.view.sessionId === sessionId &&
        this.current(owner.entry) &&
        owner.entry.view === owner.view
      ) {
        this.viewerOwners.delete(key);
        owner.entry.view = null;
        affected.push(owner);
      }
    }
    for (const { entry, view } of affected) {
      entry.closingView = view;
      view.stream.terminate("session-gone");
      if (entry.closingView === view) entry.closingView = null;
    }
    if (affected.length > 0) {
      try {
        observeRejection(this.options.onSessionGone?.(sessionId));
      } catch {
        /* observer is best effort */
      }
    }
    this.arm();
  }

  private notifyError(): void {
    try {
      observeRejection(this.options.onError?.());
    } catch {
      /* observer is best effort */
    }
  }

  private clearTimer(): void {
    this.timerEpoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.clearTimer();
    if (!this.started) return;
    try {
      const views = [...this.entries.values()].flatMap((entry) => (entry.view ? [entry.view] : []));
      if (views.length === 0) return;
      const now = this.options.now();
      if (!Number.isFinite(now)) throw new RangeError("Service view clock must be finite");
      const deadlines = [
        this.scheduler.nextBudgetAt(),
        ...views.map((view) => view.stream.nextDeadline()),
      ];
      let delay = 25;
      for (const deadline of deadlines)
        if (deadline !== null && deadline > now) delay = Math.min(delay, deadline - now);
      const epoch = this.timerEpoch;
      this.timer = setTimeout(
        () => {
          if (!this.started || epoch !== this.timerEpoch) return;
          this.timer = null;
          this.pump();
        },
        Math.max(1, delay),
      );
    } catch {
      this.stop();
      this.notifyError();
    }
  }
}

function observeRejection(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  void new Promise((resolve) => resolve(value)).catch(() => {});
}
