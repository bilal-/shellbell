import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { ConversationMessageSchema } from "./conversation-wire.js";
import { EventKindSchema } from "./ctrl.js";
import { Bytes } from "./envelope.js";
import { NamedKeySchema } from "./keys.js";
import { NotificationFeaturesSchema, NotificationGenerationSchema } from "./notification.js";
import { SidSchema } from "./session-id.js";
import { MAX_TERMINAL_MESSAGE_BYTES } from "./session-v2-route-wire.js";
import { STREAM_LIMITS, StreamMessageSchema } from "./stream-wire.js";

export { SidSchema } from "./session-id.js";

export const BuiltinBackendNameSchema = z.enum(["iterm2", "tmux", "herdr"]);
export type BuiltinBackendName = z.infer<typeof BuiltinBackendNameSchema>;
/** Adapter IDs are local namespaces, never executable names or launch commands. */
export const BackendNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type BackendName = z.infer<typeof BackendNameSchema>;
export const MAX_TERMINAL_ADAPTERS = 32;
/** Longest `input.line` text, in UTF-16 code units; a longer line is rejected unacknowledged. */
export const MAX_INPUT_LINE_LENGTH = 8192;
export const BUILTIN_BACKEND_LABELS = {
  iterm2: "iTerm2",
  tmux: "tmux",
  herdr: "Herdr",
} as const satisfies Record<BuiltinBackendName, string>;

/** Service host only; does not identify an SSH/container guest or session shell. */
export const HostPlatformSchema = z.enum(["darwin", "linux", "win32", "unknown"]);
export type HostPlatform = z.infer<typeof HostPlatformSchema>;

const byte = z.number().int().min(0).max(255);
export const ColorSchema = z.union([byte, z.tuple([byte, byte, byte])]);
export const RunSchema = z.object({
  t: z.string().max(4096),
  fg: ColorSchema.optional(),
  bg: ColorSchema.optional(),
  b: z.boolean().optional(),
  i: z.boolean().optional(),
  u: z.boolean().optional(),
  s: z.boolean().optional(),
  f: z.boolean().optional(),
  n: z.number().int().min(0).max(4096).optional(),
});
export const LineSchema = z.object({ r: z.array(RunSchema).max(2048), w: z.boolean().optional() });
export const CursorSchema = z.object({ x: z.number().int(), y: z.number().int() });

export const CapabilitiesSchema = z.object({
  subscribe: z.boolean(),
  prompts: z.boolean(),
  createSession: z.boolean(),
  focus: z.boolean(),
  history: z.boolean(),
  absoluteLines: z.boolean(),
  /** Optional: old hosts remain usable and never receive mouse requests. */
  mouseClick: z.boolean().optional(),
  /** Exact terminal input, including paste delimiters and newlines, without line submission. */
  terminalInput: z.boolean().optional(),
  /** Host-native paste honors the application's live paste mode. */
  terminalPaste: z.boolean().optional(),
  /** Streams the terminal's own bytes to a `mode: "vt"` subscriber instead of snapshots. */
  vtStream: z.boolean().optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const BackendLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
export const BackendDescriptorSchema = z.object({
  name: BackendNameSchema,
  label: BackendLabelSchema,
  capabilities: CapabilitiesSchema,
  connected: z.boolean(),
  launchable: z.boolean(),
});
export const BackendCatalogSchema = z
  .array(BackendDescriptorSchema)
  .max(MAX_TERMINAL_ADAPTERS)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
    "adapter IDs must be unique",
  );
export type BackendDescriptor = z.infer<typeof BackendDescriptorSchema>;
export const SessionLaunchTargetSchema = z.object({
  backend: BackendNameSchema,
  host: BackendNameSchema,
  label: BackendLabelSchema,
});
export type SessionLaunchTarget = z.infer<typeof SessionLaunchTargetSchema>;
export const SessionLaunchTargetsSchema = z
  .array(SessionLaunchTargetSchema)
  .max(64)
  .refine(
    (targets) =>
      new Set(targets.map((target) => `${target.backend}:${target.host}`)).size === targets.length,
    "launch targets must be unique",
  );

/**
 * Why the computer cannot open a backend's new sessions right now, in one plain sentence the
 * phone shows as is, such as a Herdr program that does not match the running Herdr.
 */
export const SessionLaunchIssueSchema = z.object({
  backend: BackendNameSchema,
  reason: z
    .string()
    .min(1)
    .max(240)
    .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
});
export type SessionLaunchIssue = z.infer<typeof SessionLaunchIssueSchema>;
export const SessionLaunchIssuesSchema = z
  .array(SessionLaunchIssueSchema)
  .max(16)
  .refine(
    (issues) => new Set(issues.map((issue) => issue.backend)).size === issues.length,
    "one launch issue per backend",
  );

/**
 * Why a supported terminal is not fully working, as a fixed code. Each surface (the Mac app,
 * the command line, the phone) turns it into plain words with `terminalSetupText`.
 */
export const TerminalSetupIssueSchema = z.enum([
  "not-installed",
  "not-running",
  "no-session",
  "api-off",
  "needs-consent",
  "connecting",
  "automation-denied",
  "iterm2-denied",
  "timed-out",
  "too-old",
  "limited",
  "failed",
]);
export type TerminalSetupIssue = z.infer<typeof TerminalSetupIssueSchema>;

export const TerminalSetupSchema = z.strictObject({
  name: BackendNameSchema,
  connected: z.boolean(),
  /** Absent when connected with nothing to fix. */
  issue: TerminalSetupIssueSchema.optional(),
  /** A specific sentence from the computer, such as why new Herdr sessions cannot open. */
  detail: SessionLaunchIssueSchema.shape.reason.optional(),
});
export type TerminalSetup = z.infer<typeof TerminalSetupSchema>;
/** Terminals one hello or local reply describes; computers send built-in terminals first. */
export const TERMINAL_SETUP_MAX = 16;
export const TerminalSetupListSchema = z
  .array(TerminalSetupSchema)
  .max(TERMINAL_SETUP_MAX)
  .refine((list) => new Set(list.map((setup) => setup.name)).size === list.length);

/** Desktop apps for a new session, most preferred first; unknown apps follow alphabetically. */
export const PREFERRED_WINDOW_HOSTS: readonly string[] = ["iterm2", "ghostty"];

/** Orders two launch hosts by `PREFERRED_WINDOW_HOSTS`, then by name. */
export function compareWindowHosts(a: string, b: string): number {
  const rank = (host: string) => {
    const index = PREFERRED_WINDOW_HOSTS.indexOf(host);
    return index === -1 ? PREFERRED_WINDOW_HOSTS.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The launch target a request that names no app uses. The computer picks it, and the phone
 * names the same one so its explicit choice never disagrees with the computer's default.
 */
export function preferredLaunchTarget<T extends { backend: string; host: string }>(
  backend: string,
  launchTargets: readonly T[] = [],
): T | undefined {
  return launchTargets
    .filter((target) => target.backend === backend)
    .sort((a, b) => compareWindowHosts(a.host, b.host))[0];
}

/** One atomic press/release in the current live terminal grid; not a desktop pointer. */
export const TerminalMouseClickSchema = z.object({
  column: z
    .number()
    .int()
    .min(0)
    .max(STREAM_LIMITS.cols - 1),
  row: z
    .number()
    .int()
    .min(0)
    .max(STREAM_LIMITS.rows - 1),
  cols: z.number().int().min(1).max(STREAM_LIMITS.cols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.rows),
  button: z.enum(["left", "right", "middle"]),
  /** Shift=1, Control=2, Alt=4. */
  modifiers: z.number().int().min(0).max(7),
});
export type TerminalMouseClick = z.infer<typeof TerminalMouseClickSchema>;

export const SessionStateSchema = z.enum(["unknown", "editing", "running", "finished", "blocked"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

const reqId = z.string().min(1).max(64);

export const SessionInfoSchema = z.object({
  id: SidSchema,
  backend: BackendNameSchema,
  title: z.string().max(256),
  cwd: z.string().max(1024).optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  windowId: z.string().max(128),
  windowNumber: z.number().int(),
  tabId: z.string().max(128),
  tabIndex: z.number().int(),
  paneIndex: z.number().int(),
  isFocusedOnMac: z.boolean(),
  // spec 8.13: `blocked` is Herdr's "an agent is waiting for a human" state. It is a first-class
  // session state, not a flavour of `running`: the app renders it differently and it rings.
  state: SessionStateSchema,
  // Display names, all optional so older peers interoperate: an older phone drops them and keeps
  // showing `title`/`cwd`; an older computer omits them. `title` keeps its earlier meaning because
  // phones cache it for notification fallback; the task text below must stay live-only.
  /** Project shown as the row title: a repository or folder name, or a deliberate manual name. */
  project: z.string().min(1).max(128).optional(),
  /** Name of the group this session's `windowId` belongs to, such as a Herdr workspace label. */
  windowLabel: z.string().min(1).max(128).optional(),
  /** A recognised coding agent running in the session and what it reports working on. */
  agent: z
    .object({
      kind: z.string().min(1).max(32),
      task: z.string().min(1).max(256).optional(),
      /**
       * The terminal reports this agent's own state, such as Herdr's agent states, so `state`
       * says whether it works or waits. Absent where only the terminal's output is known; the
       * phone then shows the agent's state as unknown rather than guessing it is busy.
       */
      reportsState: z.literal(true).optional(),
    })
    .optional(),
  /** When `state` last changed, in Unix milliseconds; only for a change the computer saw. */
  stateSince: z.number().int().nonnegative().optional(),
  /** When the session's screen last changed, in Unix milliseconds, for "most recently active". */
  activeAt: z.number().int().nonnegative().optional(),
  /**
   * Optional: the pane currently shows the terminal's alternate screen (vim, less, top and other
   * full-screen programs). Absent when the backend cannot tell; phones treat absence as unknown.
   */
  alternateScreen: z.boolean().optional(),
  /**
   * Optional: desktop apps currently running a client of this session's terminal server, such as
   * Ghostty for a Herdr server. Absent when the computer cannot tell or no client is attached.
   */
  shownIn: z.array(BackendLabelSchema).min(1).max(4).optional(),
  /**
   * Optional: which terminal holds `id`, where a backend can give the same id to a different
   * terminal, such as tmux after its server restarts. A different value under the same id is a
   * different terminal. Absent when the backend never reuses ids or cannot tell.
   */
  instance: z.string().min(1).max(64).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/** A preferred initial grid for a new desktop window, never a resize of an existing one. */
export const INITIAL_TERMINAL_SIZE_LIMITS = Object.freeze({
  minCols: 40,
  maxCols: 240,
  minRows: 24,
  maxRows: 100,
});
export const InitialTerminalSizeSchema = z.object({
  cols: z
    .number()
    .int()
    .min(INITIAL_TERMINAL_SIZE_LIMITS.minCols)
    .max(INITIAL_TERMINAL_SIZE_LIMITS.maxCols),
  rows: z
    .number()
    .int()
    .min(INITIAL_TERMINAL_SIZE_LIMITS.minRows)
    .max(INITIAL_TERMINAL_SIZE_LIMITS.maxRows),
});
export type InitialTerminalSize = z.infer<typeof InitialTerminalSizeSchema>;

export const CreateWhereSchema = z.union([
  z
    .object({
      kind: z.literal("tab"),
      backend: BackendNameSchema,
      windowId: z.string().max(128).optional(),
      host: BackendNameSchema.optional(),
      initialSize: InitialTerminalSizeSchema.optional(),
    })
    .refine(
      (where) => where.host === undefined || where.windowId === undefined,
      "host launch requires a new independent session",
    )
    .refine(
      (where) => where.initialSize === undefined || where.windowId === undefined,
      "initial size applies only to a new independent window",
    ),
  z.object({
    kind: z.literal("split"),
    sessionId: SidSchema,
    direction: z.enum(["vertical", "horizontal"]),
  }),
]);
export type CreateWhere = z.infer<typeof CreateWhereSchema>;

const screenCommon = {
  sessionId: SidSchema,
  cursor: CursorSchema,
  scrollbackTotal: z.number().int().nonnegative(),
  gen: z.number().int().nonnegative(),
};

/**
 * The three messages that carry an enum a newer peer may extend. The phone parses them through
 * `loose.ts`, which derives its versions from these, so a field added here reaches both.
 */
/** In `hello.features`: this computer sends `alive` on the direct route. */
export const ALIVE_FEATURE = "alive-v1";
/** How often a computer sends `alive`. */
export const ALIVE_INTERVAL_MS = 5000;

export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  agentVersion: z.string().max(32),
  features: NotificationFeaturesSchema.optional(),
  /** Owner-local consent. Feature support alone never grants transcript access. */
  conversationEnabled: z.boolean().optional(),
  hostPlatform: HostPlatformSchema.optional(),
  launchableBackends: z.array(BackendNameSchema).max(4).optional(),
  /** Additive catalog: legacy peers retain their bounded built-in backend list. */
  backendCatalog: BackendCatalogSchema.optional(),
  sessionLaunchTargets: SessionLaunchTargetsSchema.optional(),
  sessionLaunchIssues: SessionLaunchIssuesSchema.optional(),
  /** Optional: each terminal's setup state, so the phone can say what to fix on the computer. */
  terminalSetup: TerminalSetupListSchema.optional(),
  backends: z.array(z.object({ name: BackendNameSchema, capabilities: CapabilitiesSchema })).max(4),
  computerName: z.string().max(64),
  accent: z.string().max(32),
});
export const SessionsMessageSchema = z.object({
  type: z.literal("sessions"),
  list: z.array(SessionInfoSchema).max(500),
  /**
   * Whether `list` names every session with its agent. False when the list had to drop agents
   * or sessions to fit one message: a session missing from it may still exist. Older computers
   * omit it.
   */
  complete: z.boolean().optional(),
});
export const EventMessageSchema = z.object({
  type: z.literal("event"),
  sessionId: SidSchema,
  kind: EventKindSchema,
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  command: z.string().max(512).optional(),
  at: z.number(),
});

export const InnerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notification.enroll"),
    generation: NotificationGenerationSchema,
    /** What this phone's notification code reads beyond the first version. */
    features: NotificationFeaturesSchema.optional(),
  }),
  z.object({ type: z.literal("notification.enrolled"), generation: NotificationGenerationSchema }),
  // both directions
  z.object({
    type: z.literal("conn.hello"),
    n: Bytes(16),
    features: z.array(z.string().min(1).max(32)).max(8).optional(),
  }),
  // Opaque paired-v1 carrier. The endpoint dispatcher must decode/admit v2 state separately.
  z.object({
    type: z.literal("session.v2.bootstrap"),
    bytes: Bytes().refine((value) => value.length > 0 && value.length <= 1_024),
  }),
  // agent -> phone
  HelloMessageSchema,
  // Sent every `ALIVE_INTERVAL_MS` on the direct route. A phone that stops hearing anything
  // knows the computer stopped answering, say because it went to sleep, while the route itself
  // still looks open. Older phones skip a message they can't read.
  z.object({ type: z.literal("alive") }),
  SessionsMessageSchema,
  z.object({
    type: z.literal("screen.snapshot"),
    ...screenCommon,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    lines: z.array(LineSchema).max(1000),
    reset: z.boolean().optional(),
    degraded: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("screen.diff"),
    ...screenCommon,
    scroll: z.number().int().nonnegative().max(1000),
    changed: z.array(z.object({ i: z.number().int().nonnegative(), line: LineSchema })).max(1000),
  }),
  z.object({
    type: z.literal("history"),
    sessionId: SidSchema,
    before: z.number().int().nonnegative(),
    lines: z.array(LineSchema).max(200),
    oldestAvailable: z.number().int().nonnegative(),
  }),
  EventMessageSchema,
  z.object({
    type: z.literal("ack"),
    reqId,
    ok: z.boolean(),
    error: z.string().max(256).optional(),
    sessionId: SidSchema.optional(),
  }),
  // phone -> agent (every one carries reqId except subscribe)
  z.object({ type: z.literal("subscribe"), sessionId: SidSchema.nullable() }),
  z.object({
    type: z.literal("input.line"),
    reqId,
    sessionId: SidSchema,
    text: z.string().max(MAX_INPUT_LINE_LENGTH),
  }),
  z.object({
    type: z.literal("input.text"),
    reqId,
    sessionId: SidSchema,
    text: z.string().max(65536),
  }),
  z.object({ type: z.literal("input.key"), reqId, sessionId: SidSchema, key: NamedKeySchema }),
  z.object({
    type: z.literal("input.terminal"),
    reqId,
    sessionId: SidSchema,
    data: z.string().min(1).max(MAX_TERMINAL_MESSAGE_BYTES),
  }),
  z.object({
    type: z.literal("input.paste"),
    reqId,
    sessionId: SidSchema,
    text: z.string().min(1).max(MAX_TERMINAL_MESSAGE_BYTES),
    submit: z.boolean(),
  }),
  TerminalMouseClickSchema.extend({
    type: z.literal("input.mouse"),
    reqId,
    sessionId: SidSchema,
  }).refine(
    (click) => click.column < click.cols && click.row < click.rows,
    "Mouse coordinates must be inside the source grid",
  ),
  z.object({
    type: z.literal("history.get"),
    reqId,
    sessionId: SidSchema,
    before: z.number().int().nonnegative(),
    count: z.number().int().min(1).max(200),
  }),
  z.object({ type: z.literal("session.create"), reqId, in: CreateWhereSchema }),
  z.object({ type: z.literal("session.focus"), reqId, sessionId: SidSchema }),
  z.object({ type: z.literal("snapshot.get"), reqId, sessionId: SidSchema }),
  ...StreamMessageSchema.options,
  ...ConversationMessageSchema.options,
]);
export type InnerMessage = z.infer<typeof InnerMessageSchema>;
export type InnerMessageOf<T extends InnerMessage["type"]> = Extract<InnerMessage, { type: T }>;

export function parseInner(u: unknown): InnerMessage {
  const r = InnerMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `inner: ${z.prettifyError(r.error)}`);
  return r.data;
}
