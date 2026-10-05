import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { EventKindSchema } from "./ctrl.js";
import { Bytes } from "./envelope.js";
import { NamedKeySchema } from "./keys.js";

export const BackendNameSchema = z.enum(["iterm2", "tmux", "herdr"]);
export type BackendName = z.infer<typeof BackendNameSchema>;

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
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const SidSchema = z.string().min(1).max(128);
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
  z.object({
    kind: z.literal("tab"),
    backend: BackendNameSchema,
    windowId: z.string().max(128).optional(),
  }),
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
  // both directions
  z.object({ type: z.literal("conn.hello"), n: Bytes(16) }),
  // agent -> phone
  z.object({
    type: z.literal("hello"),
    agentVersion: z.string().max(32),
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
    type: z.literal("history.get"),
    reqId,
    sessionId: SidSchema,
    before: z.number().int().nonnegative(),
    count: z.number().int().min(1).max(200),
  }),
  z.object({ type: z.literal("session.create"), reqId, in: CreateWhereSchema }),
  z.object({ type: z.literal("session.focus"), reqId, sessionId: SidSchema }),
  z.object({ type: z.literal("snapshot.get"), reqId, sessionId: SidSchema }),
]);
export type InnerMessage = z.infer<typeof InnerMessageSchema>;
export type InnerMessageOf<T extends InnerMessage["type"]> = Extract<InnerMessage, { type: T }>;

export function parseInner(u: unknown): InnerMessage {
  const r = InnerMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `inner: ${z.prettifyError(r.error)}`);
  return r.data;
}
