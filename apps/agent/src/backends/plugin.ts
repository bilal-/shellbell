import { lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BackendLabelSchema,
  BackendNameSchema,
  BuiltinBackendNameSchema,
  CapabilitiesSchema,
  CursorSchema,
  LineSchema,
  SessionInfoSchema,
  STREAM_LIMITS,
} from "@shellbell/protocol";
import { z } from "zod";
import { boundedRead } from "../host-files.js";
import { type Logger, safeErrorName } from "../log.js";
import type { BackendRegistry } from "./registry.js";
import {
  type BackendEvent,
  BackendUnavailable,
  type CreateWhere,
  type HistoryReadRequest,
  type HistoryReadResult,
  type Screen,
  type ScreenReadOptions,
  type TerminalBackend,
  Unsupported,
} from "./types.js";

/** Local ESM contract. A plugin is trusted code with the service user's privileges. */
export interface TerminalAdapterPlugin {
  apiVersion: 1;
  id: string;
  label: string;
  platforms: readonly ("darwin" | "linux")[];
  hostCommands?: readonly string[];
  create(context: {
    log: Logger;
    signal: AbortSignal;
  }): Promise<TerminalPluginBackend> | TerminalPluginBackend;
}
export interface TerminalPluginBackend
  extends Omit<
    TerminalBackend,
    "notificationFacts" | "tmuxWindowIds" | "tmuxWindowIdOf" | "hostJob" | "capabilitiesOf"
  > {
  /** Optional, explicit cold start. Discovery must never open an app by itself. */
  launch?(): Promise<void>;
  canLaunch?(): boolean;
}

const manifestSchema = z.object({
  apiVersion: z.literal(1),
  id: BackendNameSchema,
  label: BackendLabelSchema,
  platforms: z
    .array(z.enum(["darwin", "linux"]))
    .min(1)
    .max(2),
  hostCommands: z
    .array(z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/))
    .max(16)
    .optional(),
});
const nativeId = z.string().min(1).max(128);
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("focus-changed") }),
  ...["screen-changed", "session-added", "session-removed", "title-changed"].map((type) =>
    z.object({ type: z.literal(type), sessionId: nativeId }),
  ),
  z.object({ type: z.literal("layout-changed") }),
  z.object({
    type: z.literal("command-start"),
    sessionId: nativeId,
    command: z.string().max(512),
    at: z.number().finite(),
  }),
  z.object({
    type: z.literal("command-end"),
    sessionId: nativeId,
    exitCode: z.number().int(),
    at: z.number().finite(),
  }),
  z.object({ type: z.literal("prompt"), sessionId: nativeId, at: z.number().finite() }),
  z.object({
    type: z.literal("agent-state"),
    sessionId: nativeId,
    state: z.enum(["working", "blocked", "idle", "done", "unknown"]),
    agent: z.string().max(128).optional(),
    at: z.number().finite(),
  }),
]);
const screenSchema = z
  .object({
    cols: z.number().int().min(1).max(STREAM_LIMITS.cols),
    rows: z.number().int().min(1).max(STREAM_LIMITS.rows),
    cursor: CursorSchema,
    lines: z.array(LineSchema).max(STREAM_LIMITS.rows),
    scrollbackTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    historyCapture: z
      .custom<object>(
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      )
      .optional(),
  })
  .refine(
    (screen) => screen.lines.length === screen.rows,
    "screen must contain every viewport row",
  );
const historyIndex = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const historyPageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("page"),
    from: historyIndex,
    to: historyIndex,
    oldestAvailable: historyIndex,
    lines: z.array(LineSchema).max(STREAM_LIMITS.historyLines),
  }),
  z.object({
    status: z.literal("boundary"),
    reason: z.enum(["end", "truncated"]),
    oldestAvailable: historyIndex,
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["unsupported", "unanchored", "busy", "changed", "fetch-window"]),
  }),
  z.object({ status: z.literal("reset") }),
  z.object({ status: z.literal("cancelled") }),
]);

class AdapterDeadline extends Error {}
async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AdapterDeadline("Terminal adapter deadline exceeded")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounds asynchronous calls and fences replies/events after retirement. Not a code sandbox. */
export class PluginBackend implements TerminalBackend {
  readonly name: string;
  readonly capabilities: TerminalBackend["capabilities"];
  private connected = false;
  private closed = false;
  private generation = 0;
  private pending = 0;
  private readonly handlers = new Set<(event: BackendEvent) => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly raw: TerminalPluginBackend,
    id: string,
    private readonly abort: AbortController,
    private readonly timeoutMs = 5000,
  ) {
    this.name = BackendNameSchema.parse(id);
    if (raw.name !== id) throw new Error("Adapter identity does not match its manifest");
    this.capabilities = Object.freeze(CapabilitiesSchema.parse(raw.capabilities));
    for (const method of [
      "connect",
      "close",
      "listSessions",
      "getScreen",
      "getHistory",
      "sendText",
      "createSession",
      "focus",
      "on",
    ] as const) {
      if (typeof raw[method] !== "function")
        throw new Error("Adapter is missing a required method");
    }
    if (
      (this.capabilities.terminalInput && !raw.sendInput) ||
      (this.capabilities.terminalPaste && !raw.paste) ||
      (this.capabilities.mouseClick && !raw.clickMouse)
    )
      throw new Error("Adapter capability has no implementation");
    this.unsubscribe = raw.on((input) => {
      if (this.closed) return;
      const parsed = eventSchema.safeParse(input);
      if (!parsed.success || ("sessionId" in parsed.data && !this.validId(parsed.data.sessionId)))
        return;
      const event = parsed.data as BackendEvent;
      if (!this.isConnected && event.type !== "layout-changed") return;
      for (const handler of [...this.handlers]) if (this.handlers.has(handler)) handler(event);
    });
    if (typeof this.unsubscribe !== "function") throw new Error("Adapter subscription is invalid");
  }
  get isConnected(): boolean {
    try {
      return !this.closed && this.connected && this.raw.isConnected !== false;
    } catch {
      return false;
    }
  }
  private validId(id: string): boolean {
    return (
      id.length > 0 &&
      id.length + this.name.length + 1 <= 128 &&
      [...id].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    );
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.pending >= 4)
      throw new BackendUnavailable(
        "Terminal adapter is busy",
        "Try again after the adapter recovers.",
      );
    const generation = this.generation;
    this.pending++;
    const native = Promise.resolve()
      .then(() => {
        if (this.closed || generation !== this.generation)
          throw new Error("Terminal adapter generation retired");
        return operation();
      })
      .finally(() => {
        this.pending--;
      });
    try {
      const result = await deadline(native, this.timeoutMs);
      if (this.closed || generation !== this.generation)
        throw new Error("Terminal adapter generation retired");
      return result;
    } catch (error) {
      if (error instanceof AdapterDeadline) {
        this.connected = false;
        this.generation++;
        for (const handler of [...this.handlers])
          if (this.handlers.has(handler)) handler({ type: "layout-changed" });
      }
      throw error;
    }
  }
  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.closed || this.pending > 0)
      throw new BackendUnavailable(
        "Terminal adapter is unavailable",
        "Wait for its pending operation or restart the service.",
      );
    await this.call(() => this.raw.connect());
    this.connected = true;
    for (const handler of [...this.handlers])
      if (this.handlers.has(handler)) handler({ type: "layout-changed" });
  }
  canLaunch(): boolean {
    try {
      return !this.closed && !!this.raw.launch && (this.raw.canLaunch?.() ?? true);
    } catch {
      return false;
    }
  }
  async launch(): Promise<void> {
    if (!this.canLaunch()) throw new Unsupported("terminal startup");
    await this.call(() => this.raw.launch!());
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.generation++;
    this.abort.abort();
    this.handlers.clear();
    try {
      this.unsubscribe();
    } finally {
      await deadline(
        Promise.resolve().then(() => this.raw.close()),
        this.timeoutMs,
      );
    }
  }
  async listSessions() {
    if (!this.isConnected) return [];
    const sessions = z
      .array(SessionInfoSchema)
      .max(500)
      .parse(await this.call(() => this.raw.listSessions()));
    if (
      sessions.some((session) => session.backend !== this.name || !this.validId(session.id)) ||
      new Set(sessions.map((session) => session.id)).size !== sessions.length
    )
      throw new Error("Adapter returned invalid session identities");
    return sessions;
  }
  async getScreen(id: string, options?: ScreenReadOptions): Promise<Screen> {
    return screenSchema.parse(await this.call(() => this.raw.getScreen(id, options)));
  }
  async getHistory(id: string, before: number, count: number) {
    return z
      .object({
        lines: z.array(LineSchema).max(1000),
        oldestAvailable: z.number().int().nonnegative(),
      })
      .parse(await this.call(() => this.raw.getHistory(id, before, count)));
  }
  async getHistoryPage(id: string, request: HistoryReadRequest): Promise<HistoryReadResult> {
    if (!this.raw.getHistoryPage) return { status: "unavailable", reason: "unsupported" };
    const result = historyPageSchema.parse(
      await this.call(() => this.raw.getHistoryPage!(id, request)),
    );
    if (
      result.status === "page" &&
      (result.to - result.from !== result.lines.length ||
        result.from < result.oldestAvailable ||
        result.to > request.before ||
        result.lines.length > request.count)
    )
      throw new Error("Adapter returned an invalid history range");
    return result;
  }
  async sendText(id: string, text: string) {
    await this.call(() => this.raw.sendText(id, text));
  }
  async sendInput(id: string, data: string) {
    if (!this.raw.sendInput) throw new Unsupported("terminal input");
    await this.call(() => this.raw.sendInput!(id, data));
  }
  async paste(id: string, text: string, submit: boolean) {
    if (!this.raw.paste) throw new Unsupported("terminal paste");
    await this.call(() => this.raw.paste!(id, text, submit));
  }
  async clickMouse(id: string, click: Parameters<NonNullable<TerminalBackend["clickMouse"]>>[1]) {
    if (!this.raw.clickMouse) throw new Unsupported("mouse input");
    await this.call(() => this.raw.clickMouse!(id, click));
  }
  async createSession(where: CreateWhere) {
    const id = await this.call(() => this.raw.createSession(where));
    if (!this.validId(id)) throw new Error("Adapter returned an invalid session identity");
    return id;
  }
  async focus(id: string) {
    await this.call(() => this.raw.focus(id));
  }
  on(handler: (event: BackendEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  setWatched(ids: string[]) {
    this.raw.setWatched?.(ids);
  }
  setReported(id: string, reported: number) {
    this.raw.setReported?.(id, reported);
  }
  hostedProcess(id: string) {
    const value = this.raw.hostedProcess?.(id);
    return value === undefined
      ? undefined
      : z
          .string()
          .max(128)
          .refine((value) =>
            [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
          )
          .parse(value);
  }
  representedWindows() {
    return z
      .array(z.object({ backend: BackendNameSchema, windowId: z.string().min(1).max(128) }))
      .max(500)
      .parse(this.raw.representedWindows?.() ?? []);
  }
  nativeWindowIdOf(id: string) {
    const value = this.raw.nativeWindowIdOf?.(id);
    return value === undefined ? undefined : z.string().min(1).max(128).parse(value);
  }
}

export function startTerminalPlugins(options: {
  paths: readonly string[];
  registry: BackendRegistry;
  log: Logger;
  platform?: string;
  timeoutMs?: number;
  retryMs?: number;
  importModule?: (url: string) => Promise<{ default: unknown }>;
  admitPath?: (path: string) => void;
}) {
  let stopped = false;
  const cleanups: (() => void)[] = [];
  const occupied = new Set<string>(BuiltinBackendNameSchema.options);
  const timeoutMs = options.timeoutMs ?? 5000;
  const ready = (async () => {
    for (const path of options.paths) {
      if (stopped) break;
      const abort = new AbortController();
      cleanups.push(() => abort.abort());
      let backend: PluginBackend | undefined;
      let raw: TerminalPluginBackend | undefined;
      let rawCloseStarted = false;
      const closeRaw = async (value: TerminalPluginBackend) => {
        if (rawCloseStarted) return;
        rawCloseStarted = true;
        await deadline(
          Promise.resolve().then(() => value.close()),
          timeoutMs,
        ).catch(() => {});
      };
      try {
        if (options.admitPath) options.admitPath(path);
        else {
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || realpathSync(path) !== path)
            throw new Error("Adapter path must be canonical");
          boundedRead(path, 262_144, process.getuid!());
        }
        const module = await deadline(
          (options.importModule ?? ((url) => import(url)))(pathToFileURL(path).href),
          timeoutMs,
        );
        const manifest = manifestSchema.parse(module.default);
        if (occupied.has(manifest.id)) throw new Error("Adapter identity is already registered");
        if (
          !manifest.platforms.includes((options.platform ?? process.platform) as "darwin" | "linux")
        ) {
          abort.abort();
          continue;
        }
        const plugin = module.default as TerminalAdapterPlugin;
        if (typeof plugin.create !== "function") throw new Error("Adapter factory is missing");
        const creation = Promise.resolve().then(() =>
          plugin.create({ log: options.log.child({ adapter: manifest.id }), signal: abort.signal }),
        );
        void creation.then(
          async (raw) => {
            if (abort.signal.aborted) await closeRaw(raw);
          },
          () => {},
        );
        raw = await deadline(creation, timeoutMs);
        if (stopped) {
          abort.abort();
          await closeRaw(raw);
          break;
        }
        backend = new PluginBackend(raw, manifest.id, abort, timeoutMs);
        occupied.add(manifest.id);
        options.registry.add(backend, manifest.label, manifest.hostCommands ?? []);
        const removeLauncher = raw.launch
          ? options.registry.registerSessionLauncher(manifest.id, {
              available: () => backend?.canLaunch() ?? false,
              start: async () => {
                await current.launch();
                await current.connect();
                return { backend: current };
              },
            })
          : undefined;
        let timer: NodeJS.Timeout | undefined;
        const current = backend;
        const attempt = async () => {
          if (stopped) return;
          if (options.registry.member(manifest.id) !== current) {
            await current.close().catch(() => {});
            return;
          }
          try {
            await current.connect();
          } catch (error) {
            options.log.debug("terminal adapter unavailable", {
              adapter: manifest.id,
              error: safeErrorName(error),
            });
          }
          if (!stopped) {
            timer = setTimeout(() => {
              void attempt();
            }, options.retryMs ?? 10_000);
            timer.unref();
          }
        };
        cleanups.push(() => {
          removeLauncher?.();
          if (timer) clearTimeout(timer);
          if (options.registry.member(manifest.id) === current)
            options.registry.remove(manifest.id);
          void current.close().catch((error) =>
            options.log.warn("terminal adapter cleanup failed", {
              adapter: manifest.id,
              error: safeErrorName(error),
            }),
          );
        });
        void attempt();
      } catch (error) {
        abort.abort();
        if (backend) await backend.close().catch(() => {});
        else if (raw) await closeRaw(raw);
        options.log.warn("terminal plugin could not be loaded", { error: safeErrorName(error) });
      }
    }
  })();
  return {
    ready,
    stop() {
      stopped = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
