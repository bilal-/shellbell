import type {
  BackendName,
  Capabilities,
  CreateWhere,
  Line,
  SessionInfo,
} from "@shellbell/protocol";
import {
  type BackendEvent,
  type Screen,
  SessionGone,
  type TerminalBackend,
  Unsupported,
} from "../../src/backends/types.js";

interface S {
  cols: number;
  rows: number;
  lines: string[];
  scrollbackTotal: number;
  history: string[];
}

export class FakeBackend implements TerminalBackend {
  capabilities: Capabilities = {
    subscribe: true,
    prompts: true,
    createSession: true,
    focus: true,
    history: true,
    absoluteLines: true,
  };
  saturated = false;
  sentText: { id: string; text: string }[] = [];
  getScreenCalls = 0;
  /** Every `setWatched` call the tracker or registry made, in order. */
  watched: string[][] = [];
  /** Every `setReported` call routed to this backend, in order. */
  reported: [string, number][] = [];
  /** `false` hides this backend from `hello.backends` without unregistering it. */
  isConnected = true;
  /**
   * Declared as optional properties (not methods) so tests can assign them. `TerminalBackend`
   * declares them as optional methods, which a property of function type satisfies.
   */
  tmuxWindowIds?: () => Set<string>;
  tmuxWindowIdOf?: (nativeId: string) => string | undefined;
  hostJob?: (sessionId: string) => string | undefined;
  /** Set to make `getScreen` await it before resolving; used to test races against `stop()`. */
  getScreenGate: Promise<void> | null = null;
  private sessions = new Map<string, S>();
  private handlers = new Set<(e: BackendEvent) => void>();
  private pendingErrors = new Map<string, Error>();

  /** Pass "tmux" to stand in for the tmux backend in registry tests. */
  constructor(readonly name: BackendName = "iterm2") {}

  addSession(
    id: string,
    o: { cols?: number; rows?: number; lines?: string[]; scrollbackTotal?: number },
  ): void {
    const rows = o.rows ?? 3;
    const lines = (o.lines ?? []).slice(0, rows);
    while (lines.length < rows) lines.push("");
    this.sessions.set(id, {
      cols: o.cols ?? 20,
      rows,
      lines,
      scrollbackTotal: o.scrollbackTotal ?? 0,
      history: [],
    });
  }
  setLines(id: string, lines: string[]): void {
    const s = this.sessions.get(id) as S;
    s.lines = lines.slice(0, s.rows);
    while (s.lines.length < s.rows) s.lines.push("");
    this.emit({ type: "screen-changed", sessionId: id });
  }
  appendLine(id: string, text: string): void {
    const s = this.sessions.get(id) as S;
    s.history.push(s.lines.shift() as string);
    s.lines.push(text);
    if (!this.saturated) s.scrollbackTotal += 1;
    this.emit({ type: "screen-changed", sessionId: id });
  }
  clear(id: string): void {
    const s = this.sessions.get(id) as S;
    s.lines = s.lines.map(() => "");
    s.scrollbackTotal = 0;
    s.history = [];
    this.emit({ type: "screen-changed", sessionId: id });
  }
  emit(e: BackendEvent): void {
    for (const h of this.handlers) h(e);
  }
  /** The next `getScreen(id)` call throws `err` once, instead of returning a screen. */
  throwOnNextGetScreen(id: string, err: Error): void {
    this.pendingErrors.set(id, err);
  }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.entries()].map(([id, s], i) => ({
      id,
      backend: this.name,
      title: id,
      cols: s.cols,
      rows: s.rows,
      windowId: "w",
      windowNumber: 1,
      tabId: `t${i}`,
      tabIndex: i,
      paneIndex: 0,
      isFocusedOnMac: i === 0,
      state: "unknown",
    }));
  }
  async getScreen(id: string): Promise<Screen> {
    this.getScreenCalls++;
    if (this.getScreenGate) await this.getScreenGate;
    const pending = this.pendingErrors.get(id);
    if (pending) {
      this.pendingErrors.delete(id);
      throw pending;
    }
    const s = this.sessions.get(id);
    if (!s) throw new SessionGone(id);
    return {
      cols: s.cols,
      rows: s.rows,
      cursor: { x: 0, y: s.rows - 1 },
      lines: s.lines.map((t): Line => (t ? { r: [{ t }] } : { r: [] })),
      scrollbackTotal: s.scrollbackTotal,
    };
  }
  async getHistory(
    id: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const s = this.sessions.get(id) as S;
    const all = s.history.map((t): Line => ({ r: [{ t }] }));
    const end = Math.min(before, all.length);
    const start = Math.max(0, end - count);
    return { lines: all.slice(start, end), oldestAvailable: 0 };
  }
  async sendText(id: string, text: string): Promise<void> {
    if (!this.sessions.has(id)) throw new Error(`session gone: ${id}`);
    this.sentText.push({ id, text });
  }
  async createSession(where: CreateWhere): Promise<string> {
    const id = `new${this.sessions.size}`;
    this.addSession(id, {});
    void where;
    return id;
  }
  async focus(_id: string): Promise<void> {
    if (!this.capabilities.focus) throw new Unsupported("focus");
  }
  setWatched(ids: string[]): void {
    this.watched.push([...ids]);
  }
  setReported(id: string, value: number): void {
    this.reported.push([id, value]);
  }
  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
