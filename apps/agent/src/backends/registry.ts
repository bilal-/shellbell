import {
  type BackendDescriptor,
  BackendDescriptorSchema,
  type BackendName,
  BackendNameSchema,
  BUILTIN_BACKEND_LABELS,
  BuiltinBackendNameSchema,
  type Capabilities,
  type CreateWhere,
  type Line,
  MAX_PAIRINGS,
  MAX_TERMINAL_ADAPTERS,
  type SessionInfo,
  type SessionLaunchTarget,
  SessionLaunchTargetSchema,
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
  TerminalInputError,
  type TerminalOperations,
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
export interface HostedSessionLauncher {
  available(): boolean;
  create(backend: TerminalBackend, firstSessionId?: string): Promise<string>;
}

async function boundedBackendCall<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Terminal adapter deadline exceeded")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function prefixId(name: BackendName, native: string): string {
  return `${name}:${native}`;
}

/** ordering: iTerm2 first, then tmux, then herdr. */
export const BACKEND_ORDER = BuiltinBackendNameSchema.options;

export function splitId(id: string): { name: BackendName; native: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  // Validated against the schema rather than a hard-coded list: adding a backend name to the
  // protocol must never silently leave its ids unroutable here.
  const name = BackendNameSchema.safeParse(id.slice(0, i));
  if (!name.success) return null;
  return { name: name.data, native: id.slice(i + 1) };
}

export class BackendRegistry implements TerminalOperations {
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
  private readonly members = new Map<BackendName, TerminalBackend>();
  private readonly labels = new Map<BackendName, string>();
  private readonly hostCommands = new Map<BackendName, readonly string[]>();
  private readonly hostedLaunchers = new Map<
    string,
    { target: SessionLaunchTarget; launcher: HostedSessionLauncher }
  >();
  private hostedPending = 0;
  private readonly sessionLaunchers = new Map<BackendName, SessionLauncher>();
  private readonly sessionStartups = new Map<BackendName, Promise<SessionStartup>>();
  private readonly startupWaiters = new Map<BackendName, number>();
  private readonly unsubs = new Map<BackendName, () => void>();
  private readonly historyMembership = new Map<BackendName, object>();
  private readonly historyPermits = new Map<string, object>();
  private inputCount = 0;
  private inputBytes = 0;
  private readonly inputQueues = new Map<
    string,
    {
      backend: TerminalBackend;
      membership: object | undefined;
      tail: Promise<void>;
      pending: number;
      valid: boolean;
    }
  >();
  private readonly handlers = new Set<(e: BackendEvent) => void>();

  constructor(
    private readonly log: Logger,
    private readonly listTimeoutMs = 8000,
  ) {}

  private orderedNames(): BackendName[] {
    const names = new Set([...this.members.keys(), ...this.sessionLaunchers.keys()]);
    for (const name of BACKEND_ORDER) names.delete(name);
    return [...BACKEND_ORDER, ...[...names].sort()];
  }

  private defaultLabel(name: BackendName): string {
    const builtin = BuiltinBackendNameSchema.safeParse(name);
    return builtin.success ? BUILTIN_BACKEND_LABELS[builtin.data] : name;
  }

  catalog(): BackendDescriptor[] {
    return this.orderedNames().map((name) => {
      const connected = this.memberConnected(name);
      return {
        name,
        label: this.labels.get(name) ?? this.defaultLabel(name),
        capabilities: this.members.get(name)?.capabilities ?? {
          subscribe: false,
          prompts: false,
          createSession: false,
          focus: false,
          history: false,
          absoluteLines: false,
        },
        connected,
        launchable: !connected && (this.sessionLaunchers.get(name)?.available() ?? false),
      };
    });
  }

  registerHostedLauncher(target: SessionLaunchTarget, launcher: HostedSessionLauncher): () => void {
    const validated = SessionLaunchTargetSchema.parse(target);
    const key = `${validated.backend}:${validated.host}`;
    if (!this.hostedLaunchers.has(key) && this.hostedLaunchers.size >= 64)
      throw new BackendUnavailable(
        "Too many terminal launch targets",
        "Disable a launch target first.",
      );
    const entry = { target: validated, launcher };
    this.hostedLaunchers.set(key, entry);
    this.emit({ type: "layout-changed" });
    return () => {
      if (this.hostedLaunchers.get(key) !== entry) return;
      this.hostedLaunchers.delete(key);
      this.emit({ type: "layout-changed" });
    };
  }

  launchTargets(): SessionLaunchTarget[] {
    return [...this.hostedLaunchers.values()]
      .filter(
        ({ target, launcher }) =>
          launcher.available() &&
          (this.memberConnected(target.backend) ||
            this.sessionLaunchers.get(target.backend)?.available()),
      )
      .map(({ target }) => ({ ...target }))
      .sort((a, b) => `${a.backend}:${a.host}`.localeCompare(`${b.backend}:${b.host}`));
  }

  private async createHostedSession(where: Extract<CreateWhere, { kind: "tab" }>): Promise<string> {
    const key = `${where.backend}:${where.host}`;
    const entry = this.hostedLaunchers.get(key);
    if (where.windowId !== undefined || !entry?.launcher.available())
      throw new BackendUnavailable(
        "Terminal launch target is unavailable",
        "Check the selected terminal app on your computer.",
      );
    if (this.hostedPending >= 8)
      throw new BackendUnavailable(
        "Terminal startup is busy",
        "Wait for the current startup to finish.",
      );
    this.hostedPending++;
    const operation = (async () => {
      if (this.hostedLaunchers.get(key) !== entry) throw new SessionGone(key);
      let backend = this.members.get(where.backend);
      let firstSessionId: string | undefined;
      if (!backend || backend.isConnected === false) {
        const started = await this.startSession(where.backend);
        backend = started.backend;
        firstSessionId = started.sessionId;
      }
      if (this.hostedLaunchers.get(key) !== entry || this.members.get(where.backend) !== backend)
        throw new SessionGone(key);
      const id = await entry.launcher.create(backend, firstSessionId);
      if (
        this.hostedLaunchers.get(key) !== entry ||
        this.members.get(where.backend) !== backend ||
        backend.isConnected === false
      )
        throw new SessionGone(key);
      return prefixId(where.backend, id);
    })().finally(() => {
      this.hostedPending--;
    });
    return boundedBackendCall(() => operation, 30_000);
  }

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

  add(backend: TerminalBackend, label?: string, hostCommands?: readonly string[]): void {
    const descriptor = BackendDescriptorSchema.parse({
      name: backend.name,
      label: label ?? this.defaultLabel(backend.name),
      capabilities: backend.capabilities,
      connected: false,
      launchable: false,
    });
    if (
      !this.orderedNames().includes(backend.name) &&
      this.orderedNames().length >= MAX_TERMINAL_ADAPTERS
    )
      throw new BackendUnavailable(
        "Too many terminal adapters",
        "Disable an adapter before adding another.",
      );
    const membership = {};
    const unsubscribe = backend.on((event) => {
      if (
        this.members.get(backend.name) === backend &&
        this.historyMembership.get(backend.name) === membership
      )
        this.emit(prefixEvent(backend.name, event));
    });
    if (typeof unsubscribe !== "function")
      throw new Error("Terminal adapter subscription is invalid");
    const previous = this.unsubs.get(backend.name);
    this.labels.set(backend.name, descriptor.label);
    this.hostCommands.set(
      backend.name,
      hostCommands ?? (backend.name === "tmux" || backend.name === "herdr" ? [backend.name] : []),
    );
    this.members.set(backend.name, backend);
    this.historyMembership.set(backend.name, membership);
    this.unsubs.set(backend.name, unsubscribe);
    try {
      previous?.();
    } catch (error) {
      this.log.warn("backend subscription cleanup failed", {
        backend: backend.name,
        err: safeErrorName(error),
      });
    }
    this.emit({ type: "layout-changed" });
  }

  remove(name: BackendName): void {
    const unsubscribe = this.unsubs.get(name);
    this.unsubs.delete(name);
    this.members.delete(name);
    this.labels.delete(name);
    this.hostCommands.delete(name);
    this.historyMembership.delete(name);
    try {
      unsubscribe?.();
    } catch (error) {
      this.log.warn("backend subscription cleanup failed", {
        backend: name,
        err: safeErrorName(error),
      });
    }
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
    for (const name of this.orderedNames()) {
      const b = this.members.get(name);
      if (b && b.isConnected !== false) out.push({ name: b.name, capabilities: b.capabilities });
    }
    return out;
  }

  registerSessionLauncher(name: BackendName, launcher: SessionLauncher): () => void {
    BackendNameSchema.parse(name);
    if (!this.orderedNames().includes(name) && this.orderedNames().length >= MAX_TERMINAL_ADAPTERS)
      throw new BackendUnavailable(
        "Too many terminal adapters",
        "Disable an adapter before adding another.",
      );
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
    return this.orderedNames().filter(
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
    return this.orderedNames().map((name) => ({
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
    const members = [...this.members.values()];
    const unsubs = [...this.unsubs.values()];
    this.sessionLaunchers.clear();
    this.hostedLaunchers.clear();
    this.sessionStartups.clear();
    this.historyMembership.clear();
    this.unsubs.clear();
    this.members.clear();
    this.labels.clear();
    this.hostCommands.clear();
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch (error) {
        this.log.warn("backend subscription cleanup failed", { err: safeErrorName(error) });
      }
    }
    await Promise.all(
      members.map(async (backend) => {
        try {
          await boundedBackendCall(() => backend.close(), this.listTimeoutMs);
        } catch (error) {
          this.log.warn("backend close failed", {
            backend: backend.name,
            err: safeErrorName(error),
          });
        }
      }),
    );
  }

  async listSessions(): Promise<SessionInfo[]> {
    const snapshot = this.orderedNames().map((name) => ({
      name,
      backend: this.members.get(name),
      membership: this.historyMembership.get(name),
    }));
    const lists = await Promise.all(
      snapshot.map(async (entry) => ({
        ...entry,
        sessions: await this.safeListSessions(entry.backend, entry.name),
      })),
    );
    const live = lists.filter(
      ({ name, backend, membership }) =>
        backend &&
        this.members.get(name) === backend &&
        this.historyMembership.get(name) === membership,
    );
    const represented = new Set<string>();
    for (const { name, backend } of live) {
      try {
        for (const window of backend?.representedWindows?.() ?? [])
          represented.add(JSON.stringify([window.backend, window.windowId]));
      } catch (error) {
        this.log.warn("terminal window relationships unavailable", {
          backend: name,
          err: safeErrorName(error),
        });
      }
    }
    const out: SessionInfo[] = [];
    for (const { name, backend, sessions } of live) {
      for (const session of sessions) {
        try {
          const windowId = backend?.nativeWindowIdOf?.(session.id);
          if (windowId && represented.has(JSON.stringify([name, windowId]))) continue;
          const process = backend?.hostedProcess?.(session.id);
          if (
            process &&
            live.some(
              (other) =>
                other.name !== name &&
                this.memberConnected(other.name) &&
                this.hostCommands.get(other.name)?.includes(process),
            )
          )
            continue;
        } catch (error) {
          this.log.warn("terminal host relationship unavailable", {
            backend: name,
            err: safeErrorName(error),
          });
        }
        out.push(withPrefix(name, session));
      }
    }
    return out;
  }
  private memberConnected(name: BackendName): boolean {
    const b = this.members.get(name);
    return !!b && b.isConnected !== false;
  }

  private async safeListSessions(
    backend: TerminalBackend | undefined,
    name: BackendName,
  ): Promise<SessionInfo[]> {
    if (!backend) return [];
    const membership = this.historyMembership.get(name);
    try {
      const sessions = await boundedBackendCall(() => backend.listSessions(), this.listTimeoutMs);
      if (this.members.get(name) !== backend || this.historyMembership.get(name) !== membership)
        return [];
      return sessions;
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
  async sendText(id: string, text: string, canExecute?: () => boolean): Promise<void> {
    const { backend, native } = this.target(id);
    return this.enqueueInput(id, backend, text, () => backend.sendText(native, text), canExecute);
  }
  async clickMouse(
    id: string,
    click: TerminalMouseClick,
    canExecute?: () => boolean,
  ): Promise<void> {
    const { backend, native } = this.target(id);
    if (!backend.capabilities.mouseClick || !backend.clickMouse)
      throw new Unsupported("mouse input");
    return this.enqueueInput(id, backend, "", () => backend.clickMouse!(native, click), canExecute);
  }
  async sendInput(id: string, data: string, canExecute?: () => boolean): Promise<void> {
    const { backend, native } = this.target(id);
    if (!backend.capabilities.terminalInput || !backend.sendInput)
      throw new Unsupported("terminal input");
    return this.enqueueInput(id, backend, data, () => backend.sendInput!(native, data), canExecute);
  }
  async paste(
    id: string,
    text: string,
    submit: boolean,
    canExecute?: () => boolean,
  ): Promise<void> {
    const { backend, native } = this.target(id);
    if (!backend.capabilities.terminalPaste || !backend.paste)
      throw new Unsupported("terminal paste");
    return this.enqueueInput(
      id,
      backend,
      text,
      () => backend.paste!(native, text, submit),
      canExecute,
    );
  }

  private enqueueInput(
    id: string,
    backend: TerminalBackend,
    text: string,
    operation: () => Promise<void>,
    canExecute?: () => boolean,
  ): Promise<void> {
    const bytes = Buffer.byteLength(text);
    if (this.inputCount >= 256 || this.inputBytes + bytes > 1024 * 1024)
      return Promise.reject(new TerminalInputError("busy"));
    let queue = this.inputQueues.get(id);
    if (!queue) {
      queue = {
        backend,
        membership: this.historyMembership.get(backend.name),
        tail: Promise.resolve(),
        pending: 0,
        valid: true,
      };
      this.inputQueues.set(id, queue);
    }
    if (!queue.valid || queue.backend !== backend)
      return Promise.reject(new TerminalInputError("cancelled"));
    const owned = queue;
    owned.pending++;
    this.inputCount++;
    this.inputBytes += bytes;
    const ownsBackend = () =>
      this.members.get(backend.name) === backend &&
      backend.isConnected !== false &&
      this.historyMembership.get(backend.name) === owned.membership;
    const work = owned.tail.then(async () => {
      if (!owned.valid || canExecute?.() === false) throw new TerminalInputError("cancelled");
      if (!ownsBackend()) throw new SessionGone(id);
      await operation();
      // Wake the existing bounded capture loop after accepted input. Herdr's
      // observer otherwise adds another polling interval before echo is read.
      if (owned.valid && ownsBackend()) this.emit({ type: "input-accepted", sessionId: id });
    });
    // A failed paste must not be followed by a queued Return against unknown content.
    owned.tail = work.catch(() => {
      owned.valid = false;
    });
    return work.finally(() => {
      this.inputCount--;
      this.inputBytes -= bytes;
      if (--owned.pending === 0 && this.inputQueues.get(id) === owned) this.inputQueues.delete(id);
    });
  }
  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "tab" && where.host !== undefined) return this.createHostedSession(where);
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
    if (e.type === "session-removed") {
      const queue = this.inputQueues.get(e.sessionId);
      if (queue) queue.valid = false;
    }
    for (const queue of this.inputQueues.values()) {
      if (
        queue.backend.isConnected === false ||
        this.members.get(queue.backend.name) !== queue.backend
      )
        queue.valid = false;
    }
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
