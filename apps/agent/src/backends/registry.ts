import {
  type BackendName,
  BackendNameSchema,
  type Capabilities,
  type CreateWhere,
  type Line,
  MAX_PAIRINGS,
  type SessionInfo,
  type TerminalMouseClick,
} from "@shellbell/protocol";
import type { LocalBackendStatus } from "../local-status.js";
import { type Logger, safeErrorName } from "../log.js";
import { assertHistoryReadRequest } from "./history.js";
import {
  type BackendEvent,
  BackendUnavailable,
  BadWindow,
  type HistoryReadRequest,
  type HistoryReadResult,
  type Screen,
  type ScreenReadOptions,
  SessionGone,
  type TerminalBackend,
  Unsupported,
} from "./types.js";

interface SessionStartup {
  backend: TerminalBackend;
  sessionId?: string;
}

export interface SessionLauncher {
  available: () => boolean;
  start: () => Promise<SessionStartup>;
}

export function prefixId(name: BackendName, native: string): string {
  return `${name}:${native}`;
}

/** ordering: iTerm2 first, then tmux, then herdr. */
export const BACKEND_ORDER = ["iterm2", "tmux", "herdr"] as const satisfies readonly BackendName[];

export function splitId(id: string): { name: BackendName; native: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  // Validated against the schema rather than a hard-coded list: adding a backend name to the
  // protocol must never silently leave its ids unroutable here.
  const name = BackendNameSchema.safeParse(id.slice(0, i));
  if (!name.success) return null;
  return { name: name.data, native: id.slice(i + 1) };
}

export class BackendRegistry implements TerminalBackend {
  private notificationRevision = 0;

  async notificationFacts(
    sessionId: string,
  ): Promise<import("../notification-context.js").NotificationFacts | undefined> {
    const p = splitId(sessionId);
    if (!p) return undefined;
    const backend = this.members.get(p.name);
    if (!backend || backend.isConnected === false) return undefined;
    const revision = this.notificationRevision;
    const facts = await backend.notificationFacts?.(p.native);
    if (
      !facts ||
      facts.sessionId !== p.native ||
      this.members.get(p.name) !== backend ||
      revision !== this.notificationRevision ||
      !this.connected().some((b) => b.name === p.name)
    )
      return undefined;
    return { ...facts, sessionId, revision: JSON.stringify([revision, facts.revision]) };
  }
  readonly name = "iterm2" as const;
  private readonly members = new Map<BackendName, TerminalBackend>();
  private readonly sessionLaunchers = new Map<BackendName, SessionLauncher>();
  private readonly sessionStartups = new Map<BackendName, Promise<SessionStartup>>();
  private readonly startupWaiters = new Map<BackendName, number>();
  private readonly unsubs = new Map<BackendName, () => void>();
  private readonly historyMembership = new Map<BackendName, object>();
  private readonly historyPermits = new Map<string, object>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();

  constructor(private readonly log: Logger) {}

  get capabilities(): Capabilities {
    // M-8: computed only over members that are actually connected right now, the same way
    // `connected()` excludes a disconnected member from `hello.backends` -- `startHerdrBackend`
    // registers before `connect()`, so a Herdr that is not yet (or no longer) reachable
    // must not permanently degrade the aggregate for every OTHER, unrelated backend. A member whose
    // transport is down still routes calls (`target()` below does not consult `isConnected`); only
    // this AGGREGATE view treats it as absent.
    const all = [...this.members.values()]
      .filter((b) => b.isConnected !== false)
      .map((b) => b.capabilities);
    const or = (k: keyof Capabilities) => all.some((c) => c[k]);
    return {
      subscribe: or("subscribe"),
      prompts: or("prompts"),
      createSession:
        or("createSession") ||
        [...this.sessionLaunchers.values()].some((launcher) => launcher.available()),
      focus: or("focus"),
      history: or("history"),
      // `Array.every` on an empty array is vacuously true; with no backend connected there is no
      // basis to claim absolute line numbering, so an empty set must report `false` here.
      absoluteLines: all.length > 0 && all.every((c) => c.absoluteLines),
    };
  }

  add(backend: TerminalBackend): void {
    this.members.set(backend.name, backend);
    this.historyMembership.set(backend.name, {});
    this.unsubs.get(backend.name)?.();
    this.unsubs.set(
      backend.name,
      backend.on((e) => this.emit(prefixEvent(backend.name, e))),
    );
    this.emit({ type: "layout-changed" });
  }

  remove(name: BackendName): void {
    this.unsubs.get(name)?.();
    this.unsubs.delete(name);
    this.members.delete(name);
    this.historyMembership.delete(name);
    this.emit({ type: "layout-changed" });
  }

  /**
   * only the backends that can actually serve a phone right now. A member whose
   * transport is down (`connected === false`) stays registered -- it reconnects itself and its
   * sessions must keep routing -- but it is not advertised in `hello.backends`.
   *
   * Ordered by `BACKEND_ORDER`, not insertion order: `startHerdrBackend` registers synchronously
   * while iTerm2 only joins after its own `await connect()` (`cli.ts`), so insertion order alone
   * would make `hello.backends` read `[herdr, iterm2]` in production -- not spec-ordered, and not
   * deterministic across runs.
   */
  connected(): { name: BackendName; capabilities: Capabilities }[] {
    const out: { name: BackendName; capabilities: Capabilities }[] = [];
    for (const name of BACKEND_ORDER) {
      const b = this.members.get(name);
      if (b && b.isConnected !== false) out.push({ name: b.name, capabilities: b.capabilities });
    }
    return out;
  }

  registerSessionLauncher(name: BackendName, launcher: SessionLauncher): () => void {
    this.sessionLaunchers.set(name, launcher);
    this.sessionStartups.delete(name);
    this.emit({ type: "layout-changed" });
    return () => {
      if (this.sessionLaunchers.get(name) !== launcher) return;
      this.sessionLaunchers.delete(name);
      this.sessionStartups.delete(name);
      this.emit({ type: "layout-changed" });
    };
  }

  launchable(): BackendName[] {
    return BACKEND_ORDER.filter(
      (name) => !this.memberConnected(name) && this.sessionLaunchers.get(name)?.available(),
    );
  }

  private async startSession(name: BackendName): Promise<SessionStartup> {
    const launcher = this.sessionLaunchers.get(name);
    if (!launcher?.available()) throw new SessionGone(`backend ${name}`);
    const waiters = this.startupWaiters.get(name) ?? 0;
    if (waiters >= 8)
      throw new BackendUnavailable(
        "Terminal startup is busy",
        "Try again after the current startup finishes.",
      );
    this.startupWaiters.set(name, waiters + 1);
    try {
      let startup = this.sessionStartups.get(name);
      if (!startup) {
        const owned: Promise<SessionStartup> = Promise.resolve()
          .then(() => {
            if (this.sessionLaunchers.get(name) !== launcher)
              throw new SessionGone(`backend ${name}`);
            return launcher.start();
          })
          .then((result) => ({ ...result }))
          .finally(() => {
            if (this.sessionStartups.get(name) === owned) this.sessionStartups.delete(name);
          });
        startup = owned;
        this.sessionStartups.set(name, owned);
      }
      const result = await startup;
      if (
        this.sessionLaunchers.get(name) !== launcher ||
        this.members.get(name) !== result.backend ||
        result.backend.isConnected === false
      )
        throw new SessionGone(`backend ${name}`);
      const sessionId = result.sessionId;
      result.sessionId = undefined;
      return { backend: result.backend, sessionId };
    } finally {
      const remaining = (this.startupWaiters.get(name) ?? 1) - 1;
      if (remaining === 0) this.startupWaiters.delete(name);
      else this.startupWaiters.set(name, remaining);
    }
  }

  member(name: BackendName): TerminalBackend | undefined {
    return this.members.get(name);
  }

  /** Complete synchronous health snapshot; false means only "not connected right now". */
  status(): LocalBackendStatus[] {
    return BACKEND_ORDER.map((name) => ({
      name,
      connected: this.memberConnected(name),
    }));
  }

  nameOf(id: string): BackendName | null {
    return splitId(id)?.name ?? null;
  }

  capabilitiesOf(id: string): Capabilities | null {
    const n = this.nameOf(id);
    return n ? (this.members.get(n)?.capabilities ?? null) : null;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    this.sessionLaunchers.clear();
    this.historyMembership.clear();
    await Promise.all([...this.members.values()].map((b) => b.close()));
    for (const unsub of this.unsubs.values()) unsub();
    this.unsubs.clear();
    this.members.clear();
  }

  async listSessions(): Promise<SessionInfo[]> {
    const iterm = this.members.get("iterm2");
    let hidden = new Set<string>();
    if (iterm) {
      try {
        hidden = iterm.tmuxWindowIds?.() ?? new Set<string>();
      } catch (err) {
        this.log.warn("tmuxWindowIds failed; tmux panes will not be de-duped this round", {
          err: safeErrorName(err),
        });
      }
    }
    // hide the iTerm2 session hosting a herdr/tmux client while that multiplexer's
    // backend is connected -- computed once, not per session, since it depends only on which
    // members are registered and connected right now.
    const herdrHostHidden = this.memberConnected("herdr");
    const tmuxHostHidden = this.memberConnected("tmux");
    // one backend's failure must never affect the others -- settle each member's
    // `listSessions()` independently, log the failure, and return whatever the survivors have.
    const lists = await Promise.all(
      BACKEND_ORDER.map(
        (name): Promise<[BackendName, SessionInfo[]]> =>
          this.safeListSessions(this.members.get(name), name).then((sessions) => [name, sessions]),
      ),
    );
    const out: SessionInfo[] = [];
    for (const [name, sessions] of lists) {
      for (const s of sessions) {
        if (name === "tmux") {
          const w = this.members.get("tmux")?.tmuxWindowIdOf?.(s.id);
          if (w && hidden.has(w)) continue;
        }
        if (name === "iterm2" && iterm) {
          let job: string | undefined;
          try {
            job = iterm.hostJob?.(s.id);
          } catch (err) {
            this.log.warn("hostJob failed; host session will not be de-duped this round", {
              err: safeErrorName(err),
            });
          }
          if ((job === "herdr" && herdrHostHidden) || (job === "tmux" && tmuxHostHidden)) continue;
        }
        out.push(withPrefix(name, s));
      }
    }
    return out;
  }

  /** present and its transport is not known to be down. */
  private memberConnected(name: BackendName): boolean {
    const b = this.members.get(name);
    return !!b && b.isConnected !== false;
  }

  private async safeListSessions(
    backend: TerminalBackend | undefined,
    name: BackendName,
  ): Promise<SessionInfo[]> {
    if (!backend) return [];
    try {
      return await backend.listSessions();
    } catch (err) {
      this.log.warn("listSessions failed for backend; returning the other backends' sessions", {
        backend: name,
        err: safeErrorName(err),
      });
      return [];
    }
  }

  private target(id: string): { backend: TerminalBackend; native: string } {
    const p = splitId(id);
    const backend = p ? this.members.get(p.name) : undefined;
    if (!p || !backend) throw new SessionGone(id);
    return { backend, native: p.native };
  }

  // NB: these must be `async` (not a bare function returning the callee's promise) so that a
  // synchronous throw from `target()` (unknown/gone session) becomes a rejected promise rather
  // than an exception thrown at call time -- callers always get a Promise to `.catch`/`await`.
  async getScreen(id: string, options?: ScreenReadOptions): Promise<Screen> {
    const { backend, native } = this.target(id);
    return options === undefined ? backend.getScreen(native) : backend.getScreen(native, options);
  }
  async getHistory(
    id: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const { backend, native } = this.target(id);
    return backend.getHistory(native, before, count);
  }

  async getHistoryPage(id: string, request: HistoryReadRequest): Promise<HistoryReadResult> {
    const { backend, native } = this.target(id);
    assertHistoryReadRequest(request);
    if (request.signal.aborted) return { status: "cancelled" };
    const read = backend.getHistoryPage;
    if (!read) return { status: "unavailable", reason: "unsupported" };
    if (this.historyPermits.has(id) || this.historyPermits.size >= MAX_PAIRINGS) {
      return { status: "unavailable", reason: "busy" };
    }
    const permit = {};
    this.historyPermits.set(id, permit);
    const ownership = this.historyMembership.get(backend.name);
    try {
      const result = await read.call(backend, native, request);
      if (request.signal.aborted) return { status: "cancelled" };
      if (this.historyMembership.get(backend.name) !== ownership) return { status: "reset" };
      return result;
    } catch (error) {
      if (request.signal.aborted) return { status: "cancelled" };
      if (this.historyMembership.get(backend.name) !== ownership) return { status: "reset" };
      throw error;
    } finally {
      if (this.historyPermits.get(id) === permit) this.historyPermits.delete(id);
    }
  }
  async sendText(id: string, text: string): Promise<void> {
    const { backend, native } = this.target(id);
    return backend.sendText(native, text);
  }
  async clickMouse(id: string, click: TerminalMouseClick): Promise<void> {
    const { backend, native } = this.target(id);
    if (!backend.capabilities.mouseClick || !backend.clickMouse)
      throw new Unsupported("mouse input");
    return backend.clickMouse(native, click);
  }
  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const { backend, native } = this.target(where.sessionId);
      return prefixId(
        backend.name,
        await backend.createSession({
          kind: "split",
          sessionId: native,
          direction: where.direction,
        }),
      );
    }
    let windowId: string | undefined;
    if (where.windowId) {
      const p = splitId(where.windowId);
      // a windowId whose prefix does not match `where.backend` must reach the phone as
      // ack.ok=false, error:"bad-window" -- a typed error, so the Agent can map it exactly. Checked
      // before the backend lookup below so it fires even when `where.backend` isn't registered.
      if (!p || p.name !== where.backend) throw new BadWindow(where.windowId);
      windowId = p.native;
    }
    let backend = this.members.get(where.backend);
    if (!backend || backend.isConnected === false) {
      // An existing window must never be replaced with a fresh one after losing its backend.
      if (where.windowId) throw new SessionGone(where.windowId);
      const started = await this.startSession(where.backend);
      if (started.sessionId) return prefixId(where.backend, started.sessionId);
      backend = started.backend;
    }
    return prefixId(
      backend.name,
      await backend.createSession({ kind: "tab", backend: where.backend, windowId }),
    );
  }
  async focus(id: string): Promise<void> {
    const { backend, native } = this.target(id);
    return backend.focus(native);
  }
  /**
   * fan the tracker's watched set out to every member, each with its own native ids.
   * Every member is called on every change, including with an empty array -- that is how a backend
   * learns that its last viewer went away and it can stop polling.
   */
  setWatched(ids: string[]): void {
    const byBackend = new Map<BackendName, string[]>();
    for (const name of this.members.keys()) byBackend.set(name, []);
    for (const id of ids) {
      const p = splitId(id);
      if (!p) continue;
      byBackend.get(p.name)?.push(p.native);
    }
    for (const [name, natives] of byBackend) {
      try {
        this.members.get(name)?.setWatched?.(natives);
      } catch (err) {
        this.log.warn("setWatched failed for backend", {
          backend: name,
          err: safeErrorName(err),
        });
      }
    }
  }
  /**
   * route the tracker's monotonic `scrollbackTotal` to the owning member, stripping the
   * `"<name>:"` prefix on the way -- the same contract as `setWatched` above, but per-session
   * rather than fanned out. An unknown prefix, or a member that does not implement it, is a no-op.
   */
  setReported(id: string, reported: number): void {
    const p = splitId(id);
    if (!p) return;
    try {
      this.members.get(p.name)?.setReported?.(p.native, reported);
    } catch (err) {
      this.log.warn("setReported failed for backend", {
        backend: p.name,
        err: safeErrorName(err),
      });
    }
  }
  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  private emit(e: BackendEvent): void {
    if (["layout-changed", "session-added", "session-removed", "title-changed"].includes(e.type))
      this.notificationRevision++;
    for (const h of [...this.handlers]) {
      if (!this.handlers.has(h)) continue;
      try {
        h(e);
      } catch (err) {
        this.log.error("backend event handler threw", { err: safeErrorName(err) });
      }
    }
  }
}

function withPrefix(name: BackendName, s: SessionInfo): SessionInfo {
  return {
    ...s,
    id: prefixId(name, s.id),
    windowId: prefixId(name, s.windowId),
    tabId: prefixId(name, s.tabId),
    backend: name,
  };
}

function prefixEvent(name: BackendName, e: BackendEvent): BackendEvent {
  return "sessionId" in e ? { ...e, sessionId: prefixId(name, e.sessionId) } : e;
}
