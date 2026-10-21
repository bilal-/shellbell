import { z } from "zod";
import { encodeCbor } from "./codec.js";
import { SidSchema } from "./session-id.js";
import { StreamIdSchema } from "./stream-wire.js";

/** Explicit phone opt-in; all messages belong to the authenticated direct route. */
export const CONVERSATION_FEATURE = "conversation-v1";
export const CONVERSATION_LIMITS = {
  envelopeBytes: 32_768,
  /** Leave room for the encrypted frame and direct-route payload wrapper. */
  batchBytes: 31_744,
  entriesPerBatch: 64,
  textBytes: 16_384,
  detailBytes: 8_192,
  queuedBytes: 262_144,
  retainedEntries: 2_000,
  retainedBytes: 4_194_304,
  progressMs: 5_000,
} as const;

const utf8 = new TextEncoder();
const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine((value) => utf8.encode(value).byteLength <= bytes);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = { subscriptionId: StreamIdSchema };
const generation = { ...identity, generation: StreamIdSchema };
const history = z.enum(["complete", "unloaded", "truncated", "unlinked"]);

/** Presentation only. IDs are random per generation, never transcript IDs, paths or byte offsets. */
export const ConversationEntrySchema = z.strictObject({
  id: StreamIdSchema,
  kind: z.enum(["user", "assistant", "tool-call", "tool-result", "status", "group", "unsupported"]),
  text: text(CONVERSATION_LIMITS.textBytes),
  detail: text(CONVERSATION_LIMITS.detailBytes).optional(),
  collapsed: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type ConversationWireEntry = z.infer<typeof ConversationEntrySchema>;

/** One atomic bounded envelope. The sender waits for applied acknowledgement before another batch. */
export const ConversationBatchSchema = z
  .strictObject({
    type: z.literal("conversation.batch"),
    ...generation,
    batchId: StreamIdSchema,
    baseRevision: revision,
    revision: revision,
    operation: z.enum(["reset", "patch", "prepend"]),
    anchor: StreamIdSchema.nullable().optional(),
    /** Optional live range end: retain the existing suffix starting at this ID. */
    after: StreamIdSchema.nullable().optional(),
    requestId: StreamIdSchema.optional(),
    entries: z.array(ConversationEntrySchema).max(CONVERSATION_LIMITS.entriesPerBatch),
    olderCursor: StreamIdSchema.nullable().optional(),
    history: history.optional(),
  })
  .superRefine((batch, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
    if (batch.baseRevision === Number.MAX_SAFE_INTEGER || batch.revision !== batch.baseRevision + 1)
      invalid("conversation revision must advance exactly once");
    if (new Set(batch.entries.map((entry) => entry.id)).size !== batch.entries.length)
      invalid("duplicate conversation entry ID");
    if (batch.operation === "reset") {
      if (batch.baseRevision !== 0 || batch.anchor !== undefined || batch.requestId !== undefined)
        invalid("invalid initial conversation batch");
    } else {
      if (batch.baseRevision === 0 || batch.anchor === undefined)
        invalid("conversation update requires an applied base and anchor");
      if (
        batch.operation === "prepend" &&
        (batch.anchor === null || !batch.requestId || batch.entries.length === 0)
      )
        invalid("older conversation page requires a request, anchor and entries");
      if (batch.operation === "patch" && batch.requestId !== undefined)
        invalid("live conversation update cannot satisfy a history request");
    }
    if (
      batch.operation === "patch" &&
      batch.anchor !== null &&
      (batch.olderCursor !== undefined || batch.history !== undefined)
    )
      invalid("a live suffix update cannot replace the retained older boundary");
    if ((batch.olderCursor === undefined) !== (batch.history === undefined))
      invalid("history and its cursor must be described together");
    if (batch.history === "complete" && batch.olderCursor !== null)
      invalid("complete conversation history cannot have an older cursor");
    if (batch.operation !== "patch" && batch.after !== undefined)
      invalid("only live updates can retain a suffix");
    if (
      batch.after &&
      (batch.after === batch.anchor || batch.entries.some((entry) => entry.id === batch.after))
    )
      invalid("a retained suffix must be outside the incoming range");
    if (
      batch.operation !== "patch" &&
      (batch.olderCursor === undefined || batch.history === undefined)
    )
      invalid("conversation page must describe its older boundary");
    if (batch.anchor && batch.entries.some((entry) => entry.id === batch.anchor))
      invalid("conversation anchor must precede incoming entries");
    if (encodeCbor(batch).byteLength > CONVERSATION_LIMITS.batchBytes)
      invalid("conversation batch exceeds envelope budget");
  });
export type ConversationBatch = z.infer<typeof ConversationBatchSchema>;

export const ConversationMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("conversation.subscribe"), ...identity, sessionId: SidSchema }),
  z.strictObject({ type: z.literal("conversation.cancel"), ...identity }),
  z.strictObject({ type: z.literal("conversation.refresh"), ...identity }),
  z
    .strictObject({
      type: z.literal("conversation.status"),
      ...identity,
      state: z.enum(["checking", "ready", "disabled", "unavailable"]),
      reason: z.enum(["unbound", "unsupported", "source", "busy"]).optional(),
      caughtUp: z.boolean().optional(),
    })
    .superRefine((status, ctx) => {
      if (status.caughtUp !== undefined && status.state !== "ready")
        ctx.addIssue({ code: "custom", message: "only ready conversation can report progress" });
    }),
  z.strictObject({
    type: z.literal("conversation.clear"),
    ...identity,
    clearId: StreamIdSchema,
    reason: z.enum(["disabled", "changed", "unavailable", "skipped", "ended"]),
  }),
  z.strictObject({ type: z.literal("conversation.cleared"), ...identity, clearId: StreamIdSchema }),
  ConversationBatchSchema,
  z
    .strictObject({
      type: z.literal("conversation.applied"),
      ...generation,
      batchId: StreamIdSchema,
      revision: revision.min(1),
      oldestId: StreamIdSchema.nullable(),
      newestId: StreamIdSchema.nullable(),
      retainedCount: z.number().int().nonnegative().max(CONVERSATION_LIMITS.retainedEntries),
    })
    .superRefine((applied, ctx) => {
      if (
        (applied.retainedCount === 0) !==
          (applied.oldestId === null && applied.newestId === null) ||
        (applied.retainedCount > 0 && (!applied.oldestId || !applied.newestId)) ||
        (applied.retainedCount === 1 && applied.oldestId !== applied.newestId) ||
        (applied.retainedCount > 1 && applied.oldestId === applied.newestId)
      )
        ctx.addIssue({ code: "custom", message: "invalid retained conversation boundary" });
    }),
  z.strictObject({
    type: z.literal("conversation.history.get"),
    ...generation,
    requestId: StreamIdSchema,
    cursor: StreamIdSchema,
  }),
  z.strictObject({
    type: z.literal("conversation.history.end"),
    ...generation,
    requestId: StreamIdSchema,
    reason: z.enum(["complete", "unavailable", "changed", "busy"]),
  }),
]);
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type ConversationMessageOf<T extends ConversationMessage["type"]> = Extract<
  ConversationMessage,
  { type: T }
>;
