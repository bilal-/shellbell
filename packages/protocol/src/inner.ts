import { z } from "zod";
import { ProtocolError } from "./codec.js";
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
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const CreateWhereSchema = z.union([
  z
    .object({
      kind: z.literal("tab"),
      backend: BackendNameSchema,
      windowId: z.string().max(128).optional(),
      host: BackendNameSchema.optional(),
    })
    .refine(
      (where) => where.host === undefined || where.windowId === undefined,
      "host launch requires a new independent session",
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

export const InnerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notification.enroll"), generation: NotificationGenerationSchema }),
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
  z.object({
    type: z.literal("hello"),
    agentVersion: z.string().max(32),
    features: NotificationFeaturesSchema.optional(),
    hostPlatform: HostPlatformSchema.optional(),
    launchableBackends: z.array(BackendNameSchema).max(4).optional(),
    /** Additive catalog: legacy peers retain their bounded built-in backend list. */
    backendCatalog: BackendCatalogSchema.optional(),
    sessionLaunchTargets: SessionLaunchTargetsSchema.optional(),
    backends: z
      .array(z.object({ name: BackendNameSchema, capabilities: CapabilitiesSchema }))
      .max(4),
    computerName: z.string().max(64),
    accent: z.string().max(32),
  }),
  z.object({ type: z.literal("sessions"), list: z.array(SessionInfoSchema).max(500) }),
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
  z.object({
    type: z.literal("event"),
    sessionId: SidSchema,
    kind: EventKindSchema,
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    command: z.string().max(512).optional(),
    at: z.number(),
  }),
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
    text: z.string().max(8192),
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
]);
export type InnerMessage = z.infer<typeof InnerMessageSchema>;
export type InnerMessageOf<T extends InnerMessage["type"]> = Extract<InnerMessage, { type: T }>;

export function parseInner(u: unknown): InnerMessage {
  const r = InnerMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `inner: ${z.prettifyError(r.error)}`);
  return r.data;
}
