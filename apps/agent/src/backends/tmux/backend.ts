import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";
import {
  type Capabilities,
  type CreateWhere,
  type Line,
  parseSgrLine,
  type SessionInfo,
} from "@shellbell/protocol";
// `parseTmuxVersion` is the SHIPPED, unit-tested version comparator (`doctor.test.ts` asserts
// 3.2 <= 3.10). Never re-derive it with parseFloat: parseFloat("3.10") === 3.1 < 3.2.
// No cycle: doctor.ts imports herdr/start.ts and iterm2/*, never the tmux tree.
import { parseTmuxVersion } from "../../doctor.js";
import { type Logger, safeErrorName } from "../../log.js";
import { makeNotificationFacts } from "../../notification-context.js";
import {
  localProjectCommand,
  manualWindowName,
  nameSession,
  type SessionNaming,
  sameNaming,
} from "../../session-naming.js";
import { assertHistoryReadRequest } from "../history.js";
import { hostAppOf, type ProcessEntry, readProcessTable } from "../host-app.js";
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
  Unsupported,
  type VtSource,
} from "../types.js";
import { TmuxControl, tmuxQuote } from "./control.js";
import { tmuxKeyForBytes } from "./keys.js";
import {
  type HistoryDisplay,
  LIST_CLIENTS_FORMAT,
  type PaneRow,
  parseClientRow,
  parseDisplay,
  parseDisplayAlternate,
  parseHistoryDisplay,
  parsePaneRows,
  Q_CLIENTS,
  Q_DISPLAY,
  Q_HISTORY_DISPLAY,
  Q_PANES,
  titleFor,
} from "./parse.js";
import { TmuxVtSource } from "./vt-source.js";

const run = promisify(execFile);
/** tmux 3.2, in `parseTmuxVersion`'s major + minor/100 space. */
const MIN_VERSION = 3.02;
export const TMUX_INSTALL_HINT = "brew install tmux (3.2+), then start a tmux session";
/** Review fix 3: a wedged tmux server must not hang `exec()` (and `syncBusy`) forever. */
const EXEC_TIMEOUT_MS = 5000;
// M-3: `TmuxControl` accumulates a reply block's lines with no size cap of its own -- harmless
// today (`list-panes -a` is one row per pane, `getScreen` captures only the visible pane, and
// `getHistory` is bounded to <=200 rows by the wire schema), but this constant does NOT mirror a
// bound `TmuxControl` enforces. It is only a sane ceiling for THIS process's own `execFile` calls.
/** Sane ceiling for `list-sessions`/`list-panes -a` stdout. */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

/** Row naming: a manual window name or the folder, plus any agent and its task. */
function namingOf(p: PaneRow, host: string): SessionNaming {
  return nameSession({
    cwd: p.cwd || undefined,
    project: manualWindowName(p.windowName, p.currentCommand),
    processName: p.currentCommand,
    title: p.paneTitle,
    ignore: [host],
  });
}

function errName(err: unknown): string {
  return safeErrorName(err);
}

function isHistoryDisplay(value: HistoryDisplay | HistoryReadResult): value is HistoryDisplay {
  return "historySize" in value;
}

/**
 * Bounds any `exec` implementation -- the real `execFile` path below already gets a `timeout`
 * option, but that only helps the real child-process path; an INJECTED `execImpl` (tests, or a
 * future caller) can still hang forever. Without this, a wedged call leaves `syncBusy` stuck
 * `true` permanently (review fix 3), after which no new tmux session ever gets a control client
 * for the life of the process.
 */
function withExecTimeout(p: Promise<string>, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`tmux exec timeout: ${label}`)),
      EXEC_TIMEOUT_MS,
    );
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface TmuxBackendOptions {
  log: Logger;
  socketName?: string;
  hostname?: string;
  controlFactory?: (sessionId: string) => TmuxControl;
  execImpl?: (args: string[]) => Promise<string>;
  watchIntervalMs?: number;
  refreshDebounceMs?: number;
  /** The process table host apps are read from; undefined when it cannot be read. */
  processTable?: () => Promise<ReadonlyMap<number, ProcessEntry> | undefined>;
  platform?: string;
}

/** The process table is read at most this often for the apps showing sessions. */
const HOST_APP_TTL_MS = 10_000;
const MAX_HOST_APPS = 4;

interface TmuxHistoryEvidence {
  paneId: string;
  revision: object;
  channel: TmuxControl;
  facts: Readonly<HistoryDisplay>;
}

export class TmuxBackend implements TerminalBackend {
  readonly name = "tmux" as const;
  private processes:
    | { at: number; table: ReadonlyMap<number, ProcessEntry> | undefined }
    | undefined;
  readonly capabilities: Capabilities = {
    subscribe: true,
    prompts: false,
    createSession: true,
    terminalInput: true,
    terminalPaste: true,
    focus: false,
    history: true,
    absoluteLines: false,
    vtStream: true,
  };

  /** Why the last connection attempt failed, for the Terminals settings and `doctor`. */
  setupIssue: "not-installed" | "no-session" | "too-old" | undefined = "no-session";
  private controls = new Map<string, TmuxControl>();
  private panes = new Map<string, PaneRow>();
  private readonly paneRevisions = new Map<string, object>();
  private readonly historyEvidence = new WeakMap<HistoryCapture, TmuxHistoryEvidence>();
  private reported = new Map<string, number>();
  /** Last `#{alternate_on}` observed while capturing each pane; absent until first observed. */
  private readonly alternate = new Map<string, boolean>();
  private sessionIndex = new Map<string, number>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private watcher: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshBusy = false;
  private refreshDirty = false;
  private syncBusy = false;
  private closed = true;
  /** Advanced by every `close()`, so a `connect()` that was waiting on detection can tell. */
  private closes = 0;
  private readonly log: Logger;
  private readonly exec: (args: string[]) => Promise<string>;

  constructor(private readonly opts: TmuxBackendOptions) {
    this.log = opts.log.child({ backend: "tmux" });
    const rawExec: (args: string[]) => Promise<string> =
      opts.execImpl ??
      (async (args) =>
        (
          await run("tmux", [...(opts.socketName ? ["-L", opts.socketName] : []), ...args], {
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: EXEC_MAX_BUFFER,
          })
        ).stdout);
    this.exec = (args) => withExecTimeout(rawExec(args), args[0] ?? "tmux");
  }

  /** false once every control client is gone, so the registry drops us from `hello`. */
  get isConnected(): boolean {
    return !this.closed && [...this.controls.values()].some((c) => c.alive);
  }

  static async detect(
    execImpl?: (args: string[]) => Promise<string>,
    { requireServer = true }: { requireServer?: boolean } = {},
  ): Promise<{ ok: boolean; version: string; reason?: string }> {
    const rawExec: (args: string[]) => Promise<string> =
      execImpl ??
      (async (args) =>
        (await run("tmux", args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER })).stdout);
    // Bounded the same way as the instance's `this.exec` (review fix 3): `detect()` is called
    // both standalone (doctor.ts) and via `connect()`, and either caller's `execImpl` can
    // hang.
    const exec = (args: string[]) => withExecTimeout(rawExec(args), args[0] ?? "tmux");
    let raw: string;
    try {
      raw = await exec(["-V"]);
    } catch {
      return { ok: false, version: "", reason: "tmux not found" };
    }
    const version = /(\d+\.\d+)/.exec(raw)?.[1] ?? "";
    const parsed = parseTmuxVersion(raw);
    if (parsed === null || parsed < MIN_VERSION) {
      return {
        ok: false,
        version,
        reason: `tmux 3.2+ required for Shellbell (found ${version || raw.trim()})`,
      };
    }
    if (!requireServer) return { ok: true, version };
    try {
      await exec(["list-sessions", "-F", "#{session_id}"]);
    } catch {
      return { ok: false, version, reason: "no tmux server running" };
    }
    return { ok: true, version };
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    const closes = this.closes;
    const d = await TmuxBackend.detect(this.exec);
    // A close() during detection wins: reopening here would revive a stopped, unregistered backend.
    if (closes !== this.closes) return;
    this.setupIssue = d.ok
      ? undefined
      : d.reason === "tmux not found"
        ? "not-installed"
        : d.reason === "no tmux server running"
          ? "no-session"
          : "too-old";
    if (!d.ok) throw new BackendUnavailable(d.reason ?? "tmux unavailable", TMUX_INSTALL_HINT);
    // Review fix 7: idempotent -- a second `connect()` on an already-connected instance must not
    // leak the previous watcher interval.
    if (this.watcher) clearInterval(this.watcher);
    this.closed = false;
    await this.syncControls();
    await this.refreshPanes();
    // M-4: a close()/stop() that lands here (during either await above) already set `closed = true`
    // and cleared any watcher. Installing a new one unconditionally would leak it past the close --
    // it would be inert (unref'd, and both callees bail on `closed`), but still armed forever.
    if (this.closed || closes !== this.closes) return;
    this.watcher = setInterval(() => {
      void this.syncControls()
        .then(() => this.refreshPanes())
        .catch((err) => this.log.warn("tmux watcher failed", { error: errName(err) }));
    }, this.opts.watchIntervalMs ?? 5000);
    this.watcher.unref?.();
  }

  /** Idempotent (spec: `close()` may be called from `stop()` and again by the host). */
  async close(): Promise<void> {
    this.closed = true;
    this.closes++;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshDirty = false;
    // Review fix 3: never leave either single-flight lock held past `close()` -- a future
    // `connect()` on the SAME instance must start with both locks free.
    this.syncBusy = false;
    this.refreshBusy = false;
    for (const c of this.controls.values()) c.stop();
    this.controls.clear();
    this.panes.clear();
    this.invalidateAllHistory();
    this.reported.clear();
    this.alternate.clear();
    this.sessionIndex.clear();
    this.handlers.clear();
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
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

  // ---- control clients ----

  /**
   * the first control client is also the command channel; when it exits, another is
   * promoted. Realised as "any alive client, chosen per command", which is the same guarantee
   * without a promotion step that could race the watcher.
   *
   * NOT `SessionGone`: no channel is a TRANSIENT fault (the watcher re-attaches within 5 s), and
   * `ScreenTracker.tick` deletes a session from every viewer when it sees `SessionGone`.
   */
  private channelForSession(sessionId?: string): TmuxControl {
    if (sessionId) {
      const own = this.controls.get(sessionId);
      if (own?.alive) return own;
    }
    const c = [...this.controls.values()].find((x) => x.alive);
    if (!c) throw new Error("tmux command channel unavailable");
    return c;
  }

  /**
   * Review fix 5: prefer the pane's OWN tmux session's control client over an unrelated alive
   * one, so traffic for a given pane doesn't all funnel through one session's client (a shared
   * FIFO with a 5 s per-command timeout) and one client stalling can't starve every other pane.
   * Falls back to any alive client -- including for calls with no specific pane (`list-panes -a`,
   * `list-clients`) -- which is what keeps a `%exit`'d session's panes servable via a survivor.
   */
  private channel(paneId?: string): TmuxControl {
    return this.channelForSession(paneId ? this.panes.get(paneId)?.sessionId : undefined);
  }

  private async syncControls(): Promise<void> {
    if (this.syncBusy || this.closed) return;
    this.syncBusy = true;
    try {
      let ids: string[];
      try {
        ids = (await this.exec(["list-sessions", "-F", "#{session_id}"]))
          .split("\n")
          .filter(Boolean);
      } catch (err) {
        // I-1: a FAILED probe (timeout, EAGAIN/ENOMEM on fork, a momentarily busy server) is not
        // "no sessions" -- treating it as such tore down every alive control client and flushed
        // the phone's whole tmux session list on a single hiccup. Real server death arrives via
        // `%exit` on each control client, which removes it and reaches `runRefresh`'s empty branch
        // on its own; leave every client, `sessionIndex` and pane untouched here and try again on
        // the next tick.
        this.log.debug("tmux list-sessions failed; keeping the existing clients", {
          error: errName(err),
        });
        return;
      }
      // `windowNumber` is the session's index in `list-sessions`, captured here.
      this.sessionIndex = new Map(ids.map((id, i) => [id, i]));
      for (const [id, c] of this.controls) {
        if (!ids.includes(id) || !c.alive) {
          c.stop();
          this.controls.delete(id);
          this.invalidateAllHistory();
        }
      }
      for (const id of ids) {
        if (this.closed || this.controls.has(id)) continue;
        const c = (
          this.opts.controlFactory ??
          ((sid: string) =>
            new TmuxControl({
              sessionId: sid,
              socketName: this.opts.socketName,
              log: this.opts.log,
            }))
        )(id);
        c.on("output", (pane) => {
          // A pane we have not listed yet (created between two refreshes) would make `getScreen`
          // throw SessionGone and destroy the phone's session; refresh instead of emitting.
          if (!this.panes.has(pane)) this.scheduleRefresh();
          else {
            this.invalidatePane(pane);
            this.emit({ type: "screen-changed", sessionId: pane });
          }
        });
        c.on("layout", () => {
          this.invalidateAllHistory();
          this.scheduleRefresh();
        });
        c.on("exit", () => {
          this.controls.delete(id);
          this.invalidateAllHistory();
          this.scheduleRefresh();
        });
        // Registered before `await`, so a concurrent tick cannot spawn a second client for `id`.
        this.controls.set(id, c);
        this.invalidateAllHistory();
        await c.start();
      }
    } finally {
      this.syncBusy = false;
    }
  }

  // ---- pane map ----

  /** layout notifications are debounced 100 ms into one refresh. */
  private scheduleRefresh(): void {
    if (this.closed) return;
    // Review fix 6: a refresh already in flight will pick up this change on its own via
    // `refreshPanes`'s dirty-loop -- arming a SEPARATE 100 ms timer here would let it fire
    // independently afterwards and run a second, redundant `runRefresh()` back to back with the
    // dirty-loop's own catch-up. Feed the same flag directly instead.
    if (this.refreshBusy) {
      this.refreshDirty = true;
      return;
    }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshPanes().catch((err) =>
        this.log.warn("tmux refresh failed", { error: errName(err) }),
      );
    }, this.opts.refreshDebounceMs ?? 100);
    this.refreshTimer.unref?.();
  }

  /**
   * Coalescing single-flight, like `ITerm2Backend.applyLayout`: at most one refresh runs, and a
   * request that arrives while one is in flight is collapsed into exactly one more afterwards.
   */
  private async refreshPanes(): Promise<void> {
    if (this.closed) return;
    if (this.refreshBusy) {
      this.refreshDirty = true;
      return;
    }
    this.refreshBusy = true;
    try {
      do {
        this.refreshDirty = false;
        await this.runRefresh();
      } while (this.refreshDirty && !this.closed);
    } finally {
      // Never leave the lock held: a throw here would wedge every later refresh.
      this.refreshBusy = false;
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.controls.size === 0) {
      const had = [...this.panes.keys()];
      this.panes.clear();
      this.alternate.clear();
      this.invalidateAllHistory();
      for (const id of had) this.emit({ type: "session-removed", sessionId: id });
      if (had.length > 0) this.emit({ type: "layout-changed" });
      return;
    }
    let rows: PaneRow[];
    try {
      rows = parsePaneRows(await this.channel().command(`list-panes -a -F ${Q_PANES}`));
    } catch (err) {
      this.log.warn("list-panes failed", { error: errName(err) });
      return;
    }
    const prev = this.panes;
    const next = new Map(rows.filter((r) => !r.dead).map((r) => [r.paneId, r]));
    const removed = [...prev.keys()].filter((id) => !next.has(id));
    const added = [...next.keys()].filter((id) => !prev.has(id));
    // R52 (Task 3 re-review): a RETAINED pane (present before and after) whose displayed title or
    // cwd moved gets the same event Herdr emits for a renamed pane (`herdr/backend.ts:854`), so
    // `Agent.onBackendEvent` re-broadcasts `sessions` for it too -- without this, a `cd` or a
    // window rename inside an already-known pane would never reach the phone.
    const host = this.opts.hostname ?? osHostname();
    const titleChanged = [...next.keys()].filter((id) => {
      const was = prev.get(id);
      if (!was) return false;
      const now = next.get(id) as PaneRow;
      return (
        titleFor(was, host) !== titleFor(now, host) ||
        was.cwd !== now.cwd ||
        !sameNaming(namingOf(was, host), namingOf(now, host))
      );
    });
    this.panes = next;
    for (const id of removed) {
      this.reported.delete(id);
      this.alternate.delete(id);
      this.invalidatePane(id);
      this.emit({ type: "session-removed", sessionId: id });
    }
    for (const id of added) {
      this.revisionFor(id);
      this.emit({ type: "session-added", sessionId: id });
    }
    for (const id of titleChanged) this.emit({ type: "title-changed", sessionId: id });
    // Review fix 1: only wake `Agent.onBackendEvent` -> `broadcast({type:"sessions"})` for the
    // WHOLE-list `sessions` frame when the pane SET actually changed (herdr's precedent,
    // `herdr/backend.ts:855`) -- a lone title/cwd rename on an unchanged set is carried by the
    // `title-changed` event above instead, not by a full `layout-changed` (idle sessions should emit no frames).
    if (removed.length > 0 || added.length > 0) this.emit({ type: "layout-changed" });
  }

  private pane(paneId: string): PaneRow {
    const p = this.panes.get(paneId);
    // The one place `SessionGone` is correct: tmux itself does not have this pane.
    if (!p) throw new SessionGone(paneId);
    return p;
  }

  private revisionFor(paneId: string): object {
    let revision = this.paneRevisions.get(paneId);
    if (!revision) {
      revision = {};
      this.paneRevisions.set(paneId, revision);
    }
    return revision;
  }

  private invalidatePane(paneId: string): void {
    this.paneRevisions.delete(paneId);
  }

  private invalidateAllHistory(): void {
    this.paneRevisions.clear();
  }

  private ownsEvidence(evidence: TmuxHistoryEvidence): boolean {
    return (
      this.panes.has(evidence.paneId) &&
      this.paneRevisions.get(evidence.paneId) === evidence.revision &&
      evidence.channel.alive &&
      this.channel(evidence.paneId) === evidence.channel
    );
  }

  private sameFacts(a: HistoryDisplay, b: HistoryDisplay): boolean {
    return (
      a.cursorX === b.cursorX &&
      a.cursorY === b.cursorY &&
      a.historySize === b.historySize &&
      a.width === b.width &&
      a.height === b.height &&
      a.historyLimit === b.historyLimit &&
      a.alternate === b.alternate
    );
  }

  private async checkedFacts(
    evidence: TmuxHistoryEvidence,
    signal: AbortSignal,
  ): Promise<HistoryDisplay | HistoryReadResult> {
    if (signal.aborted) return { status: "cancelled" };
    if (!this.ownsEvidence(evidence)) return { status: "reset" };
    let row: string | undefined;
    try {
      row = (
        await evidence.channel.command(
          `display-message -p -t ${evidence.paneId} ${Q_HISTORY_DISPLAY}`,
        )
      )[0];
    } catch {
      if (signal.aborted) return { status: "cancelled" };
      return this.ownsEvidence(evidence)
        ? { status: "unavailable", reason: "changed" }
        : { status: "reset" };
    }
    if (signal.aborted) return { status: "cancelled" };
    if (!this.ownsEvidence(evidence)) return { status: "reset" };
    const facts = parseHistoryDisplay(row ?? "");
    if (!facts) return { status: "unavailable", reason: "changed" };
    if (!this.sameFacts(facts, evidence.facts)) {
      this.invalidatePane(evidence.paneId);
      return { status: "reset" };
    }
    return facts;
  }

  private readOutcome(
    evidence: TmuxHistoryEvidence,
    signal: AbortSignal,
  ): Extract<HistoryReadResult, { status: "cancelled" | "reset" }> | undefined {
    if (signal.aborted) return { status: "cancelled" };
    if (!this.ownsEvidence(evidence)) return { status: "reset" };
    return undefined;
  }

  // ---- sessions ----

  async notificationFacts(sessionId: string) {
    const p = this.panes.get(sessionId);
    if (!p || !this.isConnected) return undefined;
    return makeNotificationFacts(
      {
        sessionId,
        cwd: p.cwd,
        title: titleFor(p, this.opts.hostname ?? osHostname()),
        sessionLabel: `tmux · ${p.sessionId} · Tab ${p.windowIndex + 1} · Pane ${p.paneIndex + 1}`,
      },
      p.currentCommand,
      "local-process",
    );
  }

  async listSessions(): Promise<SessionInfo[]> {
    let attached = new Set<string>();
    let shownIn = new Map<string, string[]>();
    try {
      const rows = (await this.channel().command(`list-clients -F ${Q_CLIENTS}`)).map(
        parseClientRow,
      );
      // our own control clients (`client_control_mode == 1`) never count as focus.
      const visible = rows.filter((r) => !r.controlMode);
      attached = new Set(visible.map((r) => r.sessionId));
      shownIn = await this.hostApps(visible);
    } catch (err) {
      this.log.debug("list-clients failed; no pane reported focused", { error: errName(err) });
    }
    const host = this.opts.hostname ?? osHostname();
    const indexOf = (sid: string) => this.sessionIndex.get(sid) ?? Number.MAX_SAFE_INTEGER;
    return [...this.panes.values()]
      .sort(
        (a, b) =>
          indexOf(a.sessionId) - indexOf(b.sessionId) ||
          a.windowIndex - b.windowIndex ||
          a.paneIndex - b.paneIndex,
      )
      .map((p) => ({
        id: p.paneId,
        backend: "tmux" as const,
        title: titleFor(p, host),
        cwd: p.cwd || undefined,
        ...namingOf(p, host),
        cols: Math.max(1, p.width),
        rows: Math.max(1, p.height),
        windowId: p.sessionId,
        windowNumber: this.sessionIndex.get(p.sessionId) ?? 0,
        tabId: p.windowId,
        tabIndex: p.windowIndex,
        paneIndex: p.paneIndex,
        isFocusedOnMac: p.paneActive && p.windowActive && attached.has(p.sessionId),
        state: "unknown" as const,
        ...(this.alternate.has(p.paneId) && { alternateScreen: this.alternate.get(p.paneId) }),
        ...(shownIn.has(p.sessionId) && { shownIn: shownIn.get(p.sessionId) }),
      }));
  }

  /** The desktop apps whose windows run each session's clients, such as Ghostty. */
  private async hostApps(
    clients: readonly { sessionId: string; pid?: number }[],
  ): Promise<Map<string, string[]>> {
    const apps = new Map<string, string[]>();
    if (!clients.some((client) => client.pid)) return apps;
    const now = Date.now();
    if (!this.processes || now - this.processes.at > HOST_APP_TTL_MS) {
      this.processes = {
        at: now,
        table: await (this.opts.processTable ?? readProcessTable)().catch(() => undefined),
      };
    }
    const table = this.processes.table;
    if (!table) return apps;
    for (const { sessionId, pid } of clients) {
      const app = pid ? hostAppOf(pid, table) : undefined;
      if (!app) continue;
      const list = apps.get(sessionId) ?? [];
      if (!list.includes(app) && list.length < MAX_HOST_APPS) list.push(app);
      apps.set(
        sessionId,
        list.sort((a, b) => a.localeCompare(b)),
      );
    }
    return apps;
  }

  /**
   * The folder whose Git top level may name this pane: tmux reads `pane_current_path` from the
   * local process, but a pane running `ssh` or a container describes another machine, and a manual
   * window name always wins.
   */
  /** The pane's own output after a seed, through a control client of its own. */
  openVtStream(paneId: string): VtSource {
    const pane = this.pane(paneId);
    return new TmuxVtSource({
      tmuxSessionId: pane.sessionId,
      paneId,
      socketName: this.opts.socketName,
      log: this.opts.log,
    });
  }

  projectFolder(nativeId: string): string | undefined {
    const p = this.panes.get(nativeId);
    if (!p?.cwd || manualWindowName(p.windowName, p.currentCommand)) return undefined;
    return localProjectCommand(p.currentCommand) ? p.cwd : undefined;
  }

  /** the registry hides any tmux pane whose tmux window id iTerm2 already shows. */
  tmuxWindowIdOf(nativeId: string): string | undefined {
    return this.panes.get(nativeId)?.windowId;
  }
  nativeWindowIdOf(nativeId: string) {
    return this.tmuxWindowIdOf(nativeId);
  }
  hostedProcess(nativeId: string) {
    return this.panes.get(nativeId)?.currentCommand;
  }

  /**
   * tmux has no notification for entering or leaving the alternate screen, so the flag is read
   * with every capture of a pane the phone is watching. A change re-publishes `sessions` through
   * the same event a title change uses; the first `false` observation stays quiet.
   */
  private observeAlternate(paneId: string, on: boolean | undefined): void {
    if (on === undefined || !this.panes.has(paneId)) return;
    const was = this.alternate.get(paneId);
    if (was === on) return;
    this.alternate.set(paneId, on);
    if (was !== undefined || on) this.emit({ type: "title-changed", sessionId: paneId });
  }

  /** the tracker's monotonic `scrollbackTotal`; needed for history offsets. */
  setReported(paneId: string, reported: number): void {
    this.reported.set(paneId, reported);
  }

  // ---- screen / history ----

  async getScreen(paneId: string, options?: ScreenReadOptions): Promise<Screen> {
    this.pane(paneId);
    const ch = this.channel(paneId);
    // Review fix 4: query size/cursor/history_size BEFORE capturing the screen. Output arriving
    // between the two commands would otherwise leave `history_size` one ahead of the captured
    // rows, producing a phantom `backendDelta` for the tracker (self-corrects next frame, but the
    // skew is avoidable by ordering these correctly).
    const wantsHistory = options?.history === true;
    const revision = wantsHistory ? this.revisionFor(paneId) : undefined;
    const displayQuery = wantsHistory ? Q_HISTORY_DISPLAY : Q_DISPLAY;
    const disp = await ch.command(`display-message -p -t ${paneId} ${displayQuery}`);
    const rows = await ch.command(`capture-pane -p -e -N -t ${paneId}`);
    const d = parseDisplay(disp[0] ?? "");
    this.observeAlternate(
      paneId,
      wantsHistory
        ? parseHistoryDisplay(disp[0] ?? "")?.alternate
        : parseDisplayAlternate(disp[0] ?? ""),
    );
    const height = Math.max(1, d.height);
    const lines: Line[] = rows.map(parseSgrLine);
    while (lines.length < height) lines.push({ r: [] });
    if (lines.length > height) lines.length = height;
    const screen: Screen = {
      cols: Math.max(1, d.width),
      rows: height,
      cursor: { x: d.cursorX, y: d.cursorY },
      lines,
      scrollbackTotal: d.historySize,
    };
    if (!wantsHistory) return screen;

    const facts = parseHistoryDisplay(disp[0] ?? "");
    if (
      !facts ||
      facts.alternate ||
      !this.panes.has(paneId) ||
      this.channel(paneId) !== ch ||
      !ch.alive
    )
      return screen;
    let post: HistoryDisplay | null;
    try {
      post = parseHistoryDisplay(
        (await ch.command(`display-message -p -t ${paneId} ${Q_HISTORY_DISPLAY}`))[0] ?? "",
      );
    } catch {
      return screen;
    }
    if (
      !post ||
      !this.sameFacts(facts, post) ||
      post.alternate ||
      this.paneRevisions.get(paneId) !== revision ||
      this.channel(paneId) !== ch ||
      !ch.alive
    )
      return screen;
    const capture: HistoryCapture = Object.freeze({});
    this.historyEvidence.set(capture, {
      paneId,
      revision: revision!,
      channel: ch,
      facts: Object.freeze(facts),
    });
    return { ...screen, historyCapture: capture };
  }

  /**
   * with `H = history_size` and the tracker's `reported`, the oldest retrievable
   * absolute line is `reported - H`, so `s = before - count - reported`, `e = before - 1 - reported`
   * (both <= -1, clamp `s >= -H`). tmux's `history_size` SATURATES at `history-limit` while
   * `reported` keeps climbing, which is exactly what makes `oldestAvailable` non-zero.
   */
  async getHistory(
    paneId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    this.pane(paneId);
    const reported = this.reported.get(paneId);
    if (reported === undefined) {
      // M-7: `reported` is set on every screen frame the tracker actually processes, so this
      // only happens for a pane the phone has never viewed. The -S/-E arithmetic below has no
      // honest baseline without it -- falling back to `d.historySize` (the old behaviour) silently
      // returned the WRONG lines rather than an empty result. Refuse instead of guessing.
      return { lines: [], oldestAvailable: 0 };
    }
    const ch = this.channel(paneId);
    const d = parseDisplay(
      (await ch.command(`display-message -p -t ${paneId} ${Q_DISPLAY}`))[0] ?? "",
    );
    const oldestAvailable = Math.max(0, reported - d.historySize);
    const e = before - 1 - reported;
    const s = Math.max(before - count - reported, -d.historySize);
    if (e < s || e > -1) return { lines: [], oldestAvailable };
    const rows = await ch.command(`capture-pane -p -e -N -t ${paneId} -S ${s} -E ${e}`);
    return { lines: rows.map(parseSgrLine), oldestAvailable };
  }

  async getHistoryPage(paneId: string, request: HistoryReadRequest): Promise<HistoryReadResult> {
    assertHistoryReadRequest(request);
    if (request.signal.aborted) return { status: "cancelled" };
    this.pane(paneId);
    const evidence = this.historyEvidence.get(request.capture);
    if (!evidence || evidence.paneId !== paneId) {
      return { status: "unavailable", reason: "unanchored" };
    }
    const initialOutcome = this.readOutcome(evidence, request.signal);
    if (initialOutcome) return initialOutcome;
    if (request.reported < evidence.facts.historySize) {
      return { status: "unavailable", reason: "unanchored" };
    }

    const beforeFacts = await this.checkedFacts(evidence, request.signal);
    const afterBeforeFacts = this.readOutcome(evidence, request.signal);
    if (afterBeforeFacts) return afterBeforeFacts;
    if (!isHistoryDisplay(beforeFacts)) return beforeFacts;
    const oldestAvailable = Math.max(0, request.reported - evidence.facts.historySize);
    if (request.before < oldestAvailable) {
      const afterFacts = await this.checkedFacts(evidence, request.signal);
      const afterBoundaryFacts = this.readOutcome(evidence, request.signal);
      if (afterBoundaryFacts) return afterBoundaryFacts;
      if (!isHistoryDisplay(afterFacts)) return afterFacts;
      return { status: "boundary", reason: "truncated", oldestAvailable };
    }
    if (request.before === oldestAvailable) {
      const afterFacts = await this.checkedFacts(evidence, request.signal);
      const afterBoundaryFacts = this.readOutcome(evidence, request.signal);
      if (afterBoundaryFacts) return afterBoundaryFacts;
      if (!isHistoryDisplay(afterFacts)) return afterFacts;
      return { status: "boundary", reason: "end", oldestAvailable };
    }

    const from = Math.max(request.before - request.count, oldestAvailable);
    const start = from - request.reported;
    const end = request.before - 1 - request.reported;
    if (start < -2_147_483_648 || end < -2_147_483_648 || start > -1 || end > -1) {
      return { status: "unavailable", reason: "fetch-window" };
    }
    if (request.signal.aborted) return { status: "cancelled" };
    if (!this.ownsEvidence(evidence)) return { status: "reset" };
    let rows: string[];
    try {
      rows = await evidence.channel.command(
        `capture-pane -p -e -N -t ${paneId} -S ${start} -E ${end}`,
      );
    } catch {
      if (request.signal.aborted) return { status: "cancelled" };
      return this.ownsEvidence(evidence)
        ? { status: "unavailable", reason: "changed" }
        : { status: "reset" };
    }
    if (request.signal.aborted) return { status: "cancelled" };
    if (!this.ownsEvidence(evidence)) return { status: "reset" };
    const afterFacts = await this.checkedFacts(evidence, request.signal);
    const afterPageFacts = this.readOutcome(evidence, request.signal);
    if (afterPageFacts) return afterPageFacts;
    if (!isHistoryDisplay(afterFacts)) return afterFacts;
    if (rows.length !== request.before - from) {
      return { status: "unavailable", reason: "changed" };
    }
    return {
      status: "page",
      from,
      to: request.before,
      oldestAvailable,
      lines: rows.map(parseSgrLine),
    };
  }

  // ---- input ----

  /**
   * "Input". `agent.ts` turns `input.key` into raw bytes before we see it, so a payload
   * that is exactly one key's byte string goes out as a tmux key NAME; anything else is literal
   * text via `-l`, with every CR/LF becoming a real `Enter` (`-l` writes bytes and never submits).
   */
  async sendText(paneId: string, text: string): Promise<void> {
    this.pane(paneId);
    const ch = this.channel(paneId);
    const key = tmuxKeyForBytes(text);
    if (key) {
      // NEVER log which key. Record only that one was sent.
      this.log.debug("tmux key");
      await ch.command(`send-keys -t ${paneId} ${key}`);
      return;
    }
    // Never log the text itself -- only its length.
    this.log.debug("tmux text", { len: text.length });
    const parts = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < parts.length; i++) {
      const body = parts[i] as string;
      if (body) await ch.command(`send-keys -t ${paneId} -l -- ${tmuxQuote(body)}`);
      if (i < parts.length - 1) await ch.command(`send-keys -t ${paneId} Enter`);
    }
  }

  async sendInput(paneId: string, data: string): Promise<void> {
    this.pane(paneId);
    // Control commands are line framed. Never interpolate terminal bytes into a quoted
    // command: CR/LF would break framing, and NUL/escapes are meaningful input too.
    const bytes = [...Buffer.from(data, "utf8")]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
    await this.channel(paneId).command(`send-keys -t ${paneId} -H -- ${bytes}`);
  }

  // ---- create / focus ----

  async paste(paneId: string, text: string, submit: boolean): Promise<void> {
    this.pane(paneId);
    // tmux's string arguments cannot represent NUL: reject before sending anything.
    if (text.includes("\0")) throw new Unsupported("paste containing NUL");
    const name = `shellbell-${randomUUID()}`;
    const quoted = `"${[...Buffer.from(text, "utf8")].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("")}"`;
    const channel = this.channel(paneId);
    try {
      // Control mode produces one reply block per command, not per command line.
      // Await each operation so a failed paste never submits Enter or misaligns screen replies.
      await channel.command(`set-buffer -b ${name} -- ${quoted}`);
      await channel.command(`paste-buffer -p -d -b ${name} -t ${paneId}`);
      if (submit) await channel.command(`send-keys -t ${paneId} Enter`);
    } finally {
      await channel.command(`delete-buffer -b ${name}`).catch(() => {});
    }
  }

  async createFirstSession(): Promise<string> {
    const detected = await TmuxBackend.detect(this.exec, { requireServer: false });
    if (!detected.ok)
      throw new BackendUnavailable(detected.reason ?? "tmux unavailable", TMUX_INSTALL_HINT);
    const id = (await this.exec(["new-session", "-d", "-P", "-F", "#{pane_id}"])).trim();
    if (!/^%\d+$/.test(id)) throw new Error("tmux new-session returned an invalid pane id");
    try {
      await this.connect();
    } catch (error) {
      // A session nobody can reach from Shellbell would stay behind unseen.
      await this.exec(["kill-pane", "-t", id]).catch(() => undefined);
      throw error;
    }
    return id;
  }

  async hostedSessionTarget(paneId: string): Promise<{ sessionId: string; socketName?: string }> {
    if (!/^%\d+$/.test(paneId)) throw new SessionGone(paneId);
    const sessionId = (
      await this.exec(["display-message", "-p", "-t", paneId, "#{session_id}"])
    ).trim();
    if (!/^\$\d+$/.test(sessionId)) throw new SessionGone(paneId);
    return { sessionId, socketName: this.opts.socketName };
  }

  /**
   * Close a session this service just created when its desktop window could not open. Takes the
   * session id, or the pane id of its only pane when the session id could not be read.
   */
  async discardHostedSession(id: string): Promise<void> {
    if (/^\$\d+$/.test(id)) await this.exec(["kill-session", "-t", id]);
    else if (/^%\d+$/.test(id)) await this.exec(["kill-pane", "-t", id]);
    else throw new SessionGone(id);
    this.scheduleRefresh();
  }

  /**
   * A split or new window lands in an existing tmux session; it is visible on this computer only
   * while an ordinary (non-control) client is attached to that session. Shellbell's own clients
   * are control-mode clients, so they never count.
   */
  /**
   * Waits until a desktop client (not a control client like Shellbell's) is attached to the
   * session. Starting a terminal app does not prove its window attached: an app that never opens
   * its window or a failed command can leave the session with no visible window.
   */
  async waitForVisibleClient(
    sessionId: string,
    {
      timeoutMs = 15_000,
      intervalMs = 250,
    }: { timeoutMs?: number | undefined; intervalMs?: number } = {},
  ): Promise<boolean> {
    if (!/^\$\d+$/.test(sessionId)) throw new SessionGone(sessionId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.hasDesktopClient(sessionId).catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async shownOnComputer(where: CreateWhere): Promise<boolean> {
    let sessionId: string;
    if (where.kind === "split") sessionId = this.pane(where.sessionId).sessionId;
    else if (where.windowId !== undefined) {
      if (!this.sessionIndex.has(where.windowId)) throw new SessionGone(where.windowId);
      sessionId = where.windowId;
    } else return false;
    return this.hasDesktopClient(sessionId);
  }

  /**
   * An ordinary (non-control) client is attached to the session from a window on this computer.
   * On macOS the client must run inside a desktop app, so a client over `ssh` does not count;
   * without a process table (other systems) any ordinary client counts. Fails closed on macOS.
   */
  private async hasDesktopClient(sessionId: string): Promise<boolean> {
    const format = LIST_CLIENTS_FORMAT.replace(/\\t/g, "\t");
    const rows = (await this.exec(["list-clients", "-t", sessionId, "-F", format]))
      .split("\n")
      .filter(Boolean)
      .map(parseClientRow)
      .filter((row) => !row.controlMode);
    if (rows.length === 0) return false;
    const table = await (this.opts.processTable ?? readProcessTable)().catch(() => undefined);
    if (!table) return (this.opts.platform ?? process.platform) !== "darwin";
    return rows.some((row) => row.pid !== undefined && hostAppOf(row.pid, table) !== undefined);
  }

  async createSession(where: CreateWhere): Promise<string> {
    let ch: TmuxControl;
    let line: string;
    if (where.kind === "split") {
      // Review fix 2: resolve the target through the pane map BEFORE it ever reaches a command
      // line. The registry only strips the `"tmux:"` prefix (`registry.ts` `target`/`splitId`) --
      // it does not validate the remainder -- so an unvalidated, unquoted phone-supplied string
      // interpolated straight into `-t <id>` would let e.g. `"%1 ; kill-server"` inject a second
      // tmux command. `this.pane()` throws the correct `SessionGone` for anything not a known id.
      this.pane(where.sessionId);
      ch = this.channel(where.sessionId);
      line = `split-window -P -F '#{pane_id}' -t ${where.sessionId} ${
        where.direction === "vertical" ? "-h" : "-v"
      }`;
    } else if (where.windowId) {
      // Same validation for the "new tab in an existing tmux session" path: `windowId` must be a
      // tmux session id we actually know about (keys of `this.sessionIndex`), never interpolated
      // unchecked.
      if (!this.sessionIndex.has(where.windowId)) throw new SessionGone(where.windowId);
      ch = this.channelForSession(where.windowId);
      line = `new-window -P -F '#{pane_id}' -t ${where.windowId}`;
    } else {
      ch = this.channel();
      line = "new-session -d -P -F '#{pane_id}'";
    }
    const out = await ch.command(line);
    const id = out[0]?.trim();
    // Never resolve "" -- the registry would prefix it to `"tmux:"` and ack it as a real session.
    if (!id) throw new Error(`tmux ${line.split(" ")[0]} returned no pane id`);
    this.scheduleRefresh();
    return id;
  }

  async focus(_paneId: string): Promise<void> {
    throw new Unsupported("focus");
  }
}
