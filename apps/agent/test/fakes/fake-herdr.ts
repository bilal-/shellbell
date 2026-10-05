import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface FakeHerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

interface Stream {
  socket: Socket;
  /** Subscription entries this connection asked for, verbatim. */
  subscriptions: { type: string; pane_id?: string }[];
}

/**
 * The method list Herdr 0.8.2 actually accepts from the server's own
 * `invalid_request` error text. `pane.copy_motion` is deliberately absent -- it does not exist in
 * this build -- so it falls through the default handler's fallback exactly like the real server's
 * rejection of it.
 */
const KNOWN_HERDR_METHODS = new Set([
  "ping",
  "server.stop",
  "server.live_handoff",
  "server.reload_config",
  "server.agent_manifests",
  "server.reload_agent_manifests",
  "notification.show",
  "client.window_title.set",
  "client.window_title.clear",
  "session.snapshot",
  "agent.list",
  "agent.get",
  "agent.read",
  "agent.explain",
  "agent.send_keys",
  "agent.rename",
  "agent.view.set",
  "agent.view.clear",
  "agent.focus",
  "agent.start",
  "agent.prompt",
  "agent.wait",
  "pane.split",
  "pane.swap",
  "pane.move",
  "pane.zoom",
  "pane.layout",
  "pane.process_info",
  "layout.export",
  "layout.apply",
  "layout.set_split_ratio",
  "pane.neighbor",
  "pane.edges",
  "pane.focus_direction",
  "pane.resize",
  "pane.list",
  "pane.current",
  "pane.get",
  "pane.focus",
  "pane.input.set",
  "pane.rename",
  "pane.send_text",
  "pane.send_keys",
  "pane.send_input",
  "pane.read",
  "pane.report_agent",
  "pane.report_agent_session",
  "pane.report_metadata",
  "pane.clear_agent_authority",
  "pane.release_agent",
  "pane.close",
  "popup.close",
  "events.subscribe",
  "events.wait",
  "pane.wait_for_output",
]);
/** Prefixes Herdr accepts as `namespace.*` (workspace.*, worktree.*, tab.*, pane.graphics.*, …). */
const KNOWN_HERDR_WILDCARDS = [
  "workspace.",
  "worktree.",
  "tab.",
  "pane.graphics.",
  "integration.",
  "plugin.",
];
function isKnownWildcard(method: string): boolean {
  return KNOWN_HERDR_WILDCARDS.some((prefix) => method.startsWith(prefix));
}

/**
 * Stand-in for the Herdr socket server. It models the transport facts that shape our client
 * (research §1): **one request per connection** — the server reads exactly one line, answers it and
 * hangs up — NDJSON framing, and an `events.subscribe` connection that stays open, acks with
 * `subscription_started`, and then streams bare `{"event":…,"data":…}` lines carrying no `id`.
 * Events are delivered only to streams that actually subscribed to them, so subscription bugs
 * surface in tests instead of being papered over.
 */
export class FakeHerdr {
  readonly dir: string;
  readonly path: string;
  readonly requests: FakeHerdrRequest[] = [];
  /** Lines written on a connection after its first one: the real server never reads them. */
  readonly ignoredLines: string[] = [];
  connections = 0;
  /** Per-pane `PaneInfo`, keyed by `pane_id` — the shape `bumpRevision` mutates and re-emits. */
  private readonly panesById = new Map<string, Record<string, unknown>>();
  /**
   * Events to write in the SAME buffer as the next `events.subscribe` ack. A real server can
   * coalesce the ack and the first event lines into one TCP chunk; this is how a test reproduces
   * that exactly, instead of writing them separately and calling it a coalesced chunk.
   */
  readonly ackRider: { event: string; data: Record<string, unknown> }[] = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly failures = new Map<string, { code: string; message: string }>();
  private readonly silenced = new Set<string>();
  private readonly streams = new Set<Stream>();
  /** Per-method reply gates: `dispatch` awaits one, if set, before answering that method. */
  private readonly gates = new Map<string, Promise<void>>();
  /**
   * EVERY accepted connection, not just the event streams. `stop()` must destroy all of them:
   * `server.close()` only stops accepting and its callback fires when the last connection ends,
   * so a connection the fake never answered (`silence()`) would otherwise wedge `stop()` forever.
   */
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  /**
   * `path` lets a test bind a chosen socket file (one that does not exist yet, or a restart). When
   * given, `dir` is attributed to that path's OWN directory rather than a freshly minted one: a
   * restart reuses the previous server's `dir` (recreated by `start()`, see below), and `stop()`'s
   * `rmSync(this.dir, ...)` must clean up that directory, not an unrelated, unused temp dir that
   * would otherwise leak on every restart test.
   */
  constructor(path?: string) {
    this.dir = path ? dirname(path) : mkdtempSync(join(tmpdir(), "sb-herdr-"));
    this.path = path ?? join(this.dir, "herdr.sock");
  }

  /**
   * Delays the fake's reply to `method` until the test calls the returned release function.
   * Lets a test create a race between an in-flight RPC and events arriving before it resolves
   * (e.g. `session.snapshot` vs. a `pane_agent_status_changed` event landing while it is pending).
   */
  gate(method: string): () => void {
    let release = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(method, gated);
    return () => {
      this.gates.delete(method);
      release();
    };
  }

  reply(method: string, fn: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, fn);
    this.failures.delete(method);
    this.silenced.delete(method);
  }
  fail(method: string, code: string, message = code): void {
    this.failures.set(method, { code, message });
  }
  /** Accept the request and never answer it — drives the timeout tests. */
  silence(method: string): void {
    this.silenced.add(method);
  }
  called(method: string): FakeHerdrRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
  get streamCount(): number {
    return this.streams.size;
  }
  /** The subscription list of the most recently opened stream. */
  get lastSubscriptions(): { type: string; pane_id?: string }[] {
    return [...this.streams].at(-1)?.subscriptions ?? [];
  }

  /** Deliver an event to every stream that subscribed to it (dotted subscription names). */
  pushEvent(event: string, data: Record<string, unknown> = {}): number {
    const dotted = event.replaceAll("_", ".");
    const line = `${JSON.stringify({ event, data })}\n`;
    let delivered = 0;
    for (const s of this.streams) {
      const match = s.subscriptions.some(
        (sub) =>
          (sub.type === event || sub.type === dotted) &&
          (sub.pane_id === undefined || sub.pane_id === data.pane_id),
      );
      if (!match) continue;
      s.socket.write(line);
      delivered++;
    }
    return delivered;
  }
  /**
   * Queue a captured-event replay immediately after the subscription acknowledgement.
   * Tests can include stale agent-state and revisioned pane updates in one chunk.
   */
  replay(events: { event: string; data: Record<string, unknown> }[]): void {
    this.ackRider.push(...events);
  }

  /** Write a raw line to every stream, bypassing subscription filtering (framing tests). */
  pushRaw(line: string): void {
    this.pushBytes(Buffer.from(line, "utf8"));
  }
  /** Write raw bytes to every stream — lets a test choose exactly where a chunk is split. */
  pushBytes(bytes: Buffer): void {
    for (const s of this.streams) s.socket.write(bytes);
  }
  /** `herdr server stop`: every open connection dies with EOF. */
  dropStreams(): void {
    for (const s of this.streams) s.socket.destroy();
    this.streams.clear();
  }

  start(): Promise<void> {
    // A restart test rebinds `this.path` after the ORIGINAL FakeHerdr's own temp dir has been
    // `rmSync`ed in `stop()`. On macOS, `net.Server.listen()` on a unix socket whose parent
    // directory does not exist fails with EACCES (not ENOENT), so the directory must be recreated
    // here rather than assumed to exist.
    mkdirSync(dirname(this.path), { recursive: true });
    const server = createServer((socket) => {
      this.connections++;
      this.sockets.add(socket);
      let first = true;
      let buf = "";
      const decoder = new StringDecoder("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        buf += decoder.write(chunk);
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (first) {
            first = false;
            this.dispatch(socket, line);
          } else {
            this.ignoredLines.push(line);
          }
          i = buf.indexOf("\n");
        }
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        for (const s of this.streams) if (s.socket === socket) this.streams.delete(s);
      });
    });
    this.server = server;
    return new Promise((resolve) => server.listen(this.path, () => resolve()));
  }

  /**
   * Closes the listener and removes the socket file, exactly like a herdr server exiting; also
   * removes the temp directory it was created in, so tests don't leak `sb-herdr-*` dirs.
   *
   * Every accepted connection is destroyed first — not just the registered event streams. A
   * connection parked by `silence()` was never added to `streams`, and `server.close()` waits for
   * the last connection to end before firing its callback, so without this `stop()` never resolves
   * and the test (plus its `afterEach`) hangs.
   */
  stop(): Promise<void> {
    this.dropStreams();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    const cleanup = () => rmSync(this.dir, { recursive: true, force: true });
    if (!server) {
      cleanup();
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      server.close(() => {
        cleanup();
        resolve();
      }),
    );
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let msg: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      socket.end();
      return;
    }
    const method = msg.method ?? "";
    const params = msg.params ?? {};
    this.requests.push({ method, params });
    // `called(method)` already reflects this request; `gate()` only delays the ANSWER, so a test
    // can wait for the request to have arrived before racing something else against its reply.
    const gated = this.gates.get(method);
    if (gated) await gated;
    if (this.silenced.has(method)) return;
    const failure = this.failures.get(method);
    if (failure) {
      socket.end(`${JSON.stringify({ id: msg.id, error: failure })}\n`);
      return;
    }
    if (method === "events.subscribe") {
      const subscriptions = (params.subscriptions ?? []) as { type: string; pane_id?: string }[];
      this.streams.add({ socket, subscriptions });
      // NB: `events.subscribe` is handled HERE, before `this.handlers` is consulted, so a
      // `reply("events.subscribe", …)` would be dead code. `fail("events.subscribe", …)` above
      // still works, and `ackRider` is how a test makes the ack share a chunk with its events.
      let out = `${JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })}\n`;
      for (const e of this.ackRider.splice(0)) out += `${JSON.stringify(e)}\n`;
      socket.write(out); // ONE write: ack + riders land in the same chunk
      return;
    }
    const handler = this.handlers.get(method) ?? this.defaultHandler(method);
    const value = handler(params);
    // A handler may answer with an error for SOME parameters by returning `{ __error: {…} }`
    // (e.g. `pane.read` refusing only `source:"recent"`), which `fail()` cannot express.
    if (value && typeof value === "object" && "__error" in value) {
      const error = (value as { __error: { code: string; message?: string } }).__error;
      socket.end(`${JSON.stringify({ id: msg.id, error })}\n`);
      return;
    }
    // Remember every pane a `session.snapshot` reply describes, so `bumpRevision` seeds a bump
    // from the pane's REAL current fields (agent_status included) instead of a hardcoded stub --
    // a bump on a pane the test's own fixture already reports as e.g. "working" must not emit a
    // spurious `agent-state` by claiming "unknown".
    if (method === "session.snapshot") this.rememberPanes(value);
    socket.end(`${JSON.stringify({ id: msg.id, result: value })}\n`);
  }

  private rememberPanes(snapshotResult: unknown): void {
    const panes = (snapshotResult as { snapshot?: { panes?: unknown } } | undefined)?.snapshot
      ?.panes;
    if (!Array.isArray(panes)) return;
    for (const pane of panes) {
      if (
        pane &&
        typeof pane === "object" &&
        typeof (pane as { pane_id?: unknown }).pane_id === "string"
      ) {
        const paneId = (pane as { pane_id: string }).pane_id;
        this.panesById.set(paneId, { ...(pane as Record<string, unknown>) });
      }
    }
  }

  /**
   * Captured behavior: mutates the pane's `revision` and emits `pane_updated` with
   * a full `PaneInfo` to every stream subscribed to `pane.updated` -- exactly what the real server
   * does on every shell command (two bumps: output, then prompt). `pane.send_text`/`pane.send_keys`
   * call this once each; a test that wants to drive change detection directly calls it too.
   */
  bumpRevision(paneId: string, n = 1): void {
    const prev = this.panesById.get(paneId) ?? {
      pane_id: paneId,
      terminal_id: paneId,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      agent_status: "unknown",
      revision: 0,
    };
    const pane = { ...prev, pane_id: paneId, revision: (prev.revision as number) + n };
    this.panesById.set(paneId, pane);
    this.pushEvent("pane_updated", { pane });
  }

  private defaultHandler(method: string): (params: Record<string, unknown>) => unknown {
    switch (method) {
      case "ping":
        return () => ({
          type: "pong",
          version: "0.8.2",
          // Local capture: the real server answered protocol 20, not the early fixture's
          // synthetic 22 -- this is Herdr's non-authoritative BINARY generation, so
          // nothing depends on the exact number, but the fake should still model the real server.
          protocol: 20,
          capabilities: { live_handoff: true, detached_server_daemon: true },
        });
      case "pane.send_text":
      case "pane.send_keys":
        return (p) => {
          if (typeof p.pane_id === "string") this.bumpRevision(p.pane_id);
          return { type: "ok" };
        };
      default:
        // Herdr 0.8.2 rejects any method it does not recognise with `invalid_request: unknown
        // variant` -- `pane.copy_motion` no longer exists, so it lands
        // here like any other name outside the server's real method list; everything the server
        // DOES accept but this fake does not specifically model still answers `ok`.
        return KNOWN_HERDR_METHODS.has(method) || isKnownWildcard(method)
          ? () => ({ type: "ok" })
          : () => ({
              __error: { code: "invalid_request", message: `unknown variant \`${method}\`` },
            });
    }
  }
}
