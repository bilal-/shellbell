import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { CtrlMessageSchema, EventKindSchema } from "./ctrl.js";
import {
  BackendNameSchema,
  CapabilitiesSchema,
  InnerMessageSchema,
  SessionInfoSchema,
  SessionStateSchema,
  SidSchema,
} from "./inner.js";

/**
 * Spec 10.6: a value a newer peer introduced must be opaque, not fatal. The union keeps the strict
 * member first so a known value still parses to its literal type; anything else falls through to a
 * bounded string. Every other constraint on the message is unchanged.
 */
const loose = <T extends z.ZodTypeAny>(strict: T) => z.union([strict, z.string().min(1).max(32)]);

export const BackendNameLooseSchema = loose(BackendNameSchema);
export const SessionStateLooseSchema = loose(SessionStateSchema);
export const EventKindLooseSchema = loose(EventKindSchema);

export type BackendNameLoose = z.infer<typeof BackendNameLooseSchema>;
export type SessionStateLoose = z.infer<typeof SessionStateLooseSchema>;
export type EventKindLoose = z.infer<typeof EventKindLooseSchema>;

export const SessionInfoLooseSchema = SessionInfoSchema.extend({
  backend: BackendNameLooseSchema,
  state: SessionStateLooseSchema,
});
export type SessionInfoLoose = z.infer<typeof SessionInfoLooseSchema>;

/** The only three inner messages that carry one of the three loosened enums. */
const LOOSE_INNER = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    agentVersion: z.string().max(32),
    backends: z
      .array(z.object({ name: BackendNameLooseSchema, capabilities: CapabilitiesSchema }))
      .max(4),
    computerName: z.string().max(64),
    accent: z.string().max(32),
  }),
  z.object({ type: z.literal("sessions"), list: z.array(SessionInfoLooseSchema).max(500) }),
  z.object({
    type: z.literal("event"),
    sessionId: SidSchema,
    kind: EventKindLooseSchema,
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    command: z.string().max(512).optional(),
    at: z.number(),
  }),
]);

const LOOSE_INNER_TYPES: ReadonlySet<string> = new Set(["hello", "sessions", "event"]);

export type InnerMessageLoose =
  | Exclude<z.infer<typeof InnerMessageSchema>, { type: "hello" | "sessions" | "event" }>
  | z.infer<typeof LOOSE_INNER>;
export type InnerMessageLooseOf<T extends InnerMessageLoose["type"]> = Extract<
  InnerMessageLoose,
  { type: T }
>;

function typeOf(u: unknown): string | undefined {
  const t = (u as { type?: unknown } | null | undefined)?.type;
  return typeof t === "string" ? t : undefined;
}

export function parseInnerLoose(u: unknown): InnerMessageLoose {
  const t = typeOf(u);
  const schema = t !== undefined && LOOSE_INNER_TYPES.has(t) ? LOOSE_INNER : InnerMessageSchema;
  const r = schema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `inner: ${z.prettifyError(r.error)}`);
  return r.data as InnerMessageLoose;
}

/**
 * `notify` is agent -> relay only, so the phone never sees it; the loose form exists so every
 * consumer of `EventKind` has a loose counterpart. `auth-fail.reason` and `pairing-reject.reason`
 * stay strict (R54 ruling 1 names three enums) — an unknown reason therefore still throws, and the
 * phone's handlers already fall back to a generic message. Recorded as a known limitation.
 */
const LOOSE_NOTIFY = z.object({
  type: z.literal("notify"),
  sessionId: SidSchema,
  kind: EventKindLooseSchema,
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export type CtrlMessageLoose =
  | Exclude<z.infer<typeof CtrlMessageSchema>, { type: "notify" }>
  | z.infer<typeof LOOSE_NOTIFY>;

export function parseCtrlLoose(u: unknown): CtrlMessageLoose {
  const schema = typeOf(u) === "notify" ? LOOSE_NOTIFY : CtrlMessageSchema;
  const r = schema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `ctrl: ${z.prettifyError(r.error)}`);
  return r.data as CtrlMessageLoose;
}
