import { z } from "zod";
import { Bytes } from "./envelope.js";
import { SidSchema } from "./session-id.js";

export const BOUNDED_STREAM_FEATURE = "bounded-stream-v1";

/** These extensions are one contract; a partial acceptance leaves the legacy view in use. */
export const CONTINUATION_EXTENSIONS = [
  "continuation-v1",
  "source-status-v1",
  "checkpoint-v1",
  "applied-v1",
] as const;
/** Optional on top of the complete continuation contract. Never implied by base acceptance. */
export const NATIVE_HISTORY_EXTENSION = "native-history-v1";

const StreamExtensionsSchema = z.array(z.string().min(1).max(64)).max(16);

export const STREAM_LIMITS = {
  envelopeBytes: 32768,
  chunkBytes: 16384,
  screenBytes: 524288,
  historyBytes: 65536,
  historyLines: 200,
  historyCells: 4096,
  chunks: 32,
  unacked: 4,
  progressMs: 5000,
  totalMs: 15000,
  ackDelayMs: 500,
  cols: 512,
  rows: 256,
  runs: 32768,
  codePoints: 131072,
  cacheLines: 5000,
  cacheBytes: 4194304,
} as const;

export type StreamId = string;

export const StreamIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const safeNonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safePositive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const StreamTransferMetaSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot"), generation: safeNonnegative }),
  z.strictObject({ kind: z.literal("diff"), generation: safeNonnegative }),
  z.strictObject({
    kind: z.literal("history"),
    generation: safeNonnegative,
    requestId: StreamIdSchema,
    before: safeNonnegative,
    /** Only for negotiated raw history; snapshot history retains its existing coordinates. */
    capture: StreamIdSchema.optional(),
  }),
  /**
   * A raw terminal stream's starting point: the receiver resets an xterm of this size and writes
   * the payload. Sent only to a subscriber that asked for `mode: "vt"`.
   */
  z.strictObject({
    kind: z.literal("vt-state"),
    generation: safeNonnegative,
    cols: z.number().int().min(1).max(STREAM_LIMITS.cols),
    rows: z.number().int().min(1).max(STREAM_LIMITS.rows),
  }),
  /** Raw terminal bytes continuing `generation`'s state; `offset` counts bytes since it. */
  z.strictObject({ kind: z.literal("vt"), generation: safeNonnegative, offset: safeNonnegative }),
  /** Only after the complete continuation extension set has been accepted. */
  z
    .strictObject({
      kind: z.literal("vt-seed"),
      generation: safeNonnegative,
      cols: z.number().int().min(1).max(STREAM_LIMITS.cols),
      rows: z.number().int().min(1).max(STREAM_LIMITS.rows),
      capture: StreamIdSchema,
      disposition: z.enum(["initial", "discontinuity", "replace"]),
      reason: z.enum([
        "start",
        "resize",
        "reconnect",
        "refresh",
        "overflow",
        "herdr-idle",
        "source-gap",
      ]),
      cursor: z.enum(["real", "guessed", "unknown"]),
      alternate: z.enum(["real", "unknown"]),
      /** First retained source row, certified only after the phone verifies the whole prefix. */
      historyBefore: safeNonnegative.optional(),
      historyRows: z.number().int().min(0).max(2000).optional(),
      historyProof: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .refine((seed) => {
      const { historyBefore: before, historyRows: rows, historyProof: proof } = seed;
      if (before === undefined || rows === undefined || proof === undefined)
        return before === undefined && rows === undefined && proof === undefined;
      return seed.disposition !== "discontinuity" && before <= Number.MAX_SAFE_INTEGER - rows;
    }),
]);
export type StreamTransferMeta = z.infer<typeof StreamTransferMetaSchema>;

export const StreamChunkSchema = z
  .object({
    type: z.literal("stream.chunk"),
    subscriptionId: StreamIdSchema,
    transferId: StreamIdSchema,
    sessionId: SidSchema,
    sequence: safePositive,
    index: z
      .number()
      .int()
      .min(0)
      .max(STREAM_LIMITS.chunks - 1),
    count: z.number().int().min(1).max(STREAM_LIMITS.chunks),
    totalBytes: safePositive.max(STREAM_LIMITS.screenBytes),
    data: Bytes(),
    meta: StreamTransferMetaSchema,
  })
  .superRefine((chunk, ctx) => {
    const limit =
      chunk.meta.kind === "history" ? STREAM_LIMITS.historyBytes : STREAM_LIMITS.screenBytes;
    if (chunk.totalBytes > limit) {
      ctx.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "transfer exceeds kind limit",
      });
    }
    const expectedCount = Math.ceil(chunk.totalBytes / STREAM_LIMITS.chunkBytes);
    if (chunk.count !== expectedCount) {
      ctx.addIssue({ code: "custom", path: ["count"], message: "chunk count mismatch" });
    }
    if (chunk.index >= chunk.count) {
      ctx.addIssue({ code: "custom", path: ["index"], message: "chunk index exceeds count" });
    }
    const expectedLength =
      chunk.index === chunk.count - 1
        ? chunk.totalBytes - chunk.index * STREAM_LIMITS.chunkBytes
        : STREAM_LIMITS.chunkBytes;
    if (chunk.data.length !== expectedLength) {
      ctx.addIssue({ code: "custom", path: ["data"], message: "chunk payload length mismatch" });
    }
  });
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

export const StreamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stream.subscribe"),
    subscriptionId: StreamIdSchema,
    sessionId: SidSchema,
    /**
     * Optional: asks for `vt-state` and `vt` transfers where the session's backend reports
     * `vtStream`. Older hosts drop it and send snapshots, which a subscriber must still accept.
     */
    mode: z.literal("vt").optional(),
    /** Unknown extension names are ignored. No answer means legacy behavior. */
    extensions: StreamExtensionsSchema.optional(),
    /** A negotiated phone already holds a terminal buffer; never import seed history into it. */
    retained: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("stream.accepted"),
    subscriptionId: StreamIdSchema,
    extensions: StreamExtensionsSchema,
  }),
  z.object({
    type: z.literal("stream.applied"),
    subscriptionId: StreamIdSchema,
    capture: StreamIdSchema,
    generation: safeNonnegative,
    /** Bytes after the seed, committed to xterm and its in-memory checkpoint. */
    offset: safeNonnegative,
  }),
  z.object({
    type: z.literal("stream.status"),
    subscriptionId: StreamIdSchema,
    capture: StreamIdSchema,
    generation: safeNonnegative,
    offset: safeNonnegative,
    /** Quiescent certifies a source probe caught up through this delivered offset. */
    state: z.enum(["quiescent", "catching-up", "paused"]),
  }),
  z.object({ type: z.literal("stream.cancel"), subscriptionId: StreamIdSchema }),
  z.object({
    type: z.literal("stream.refresh"),
    subscriptionId: StreamIdSchema,
    /** Explicitly replace raw history with a fresh native capture; requires native-history-v1. */
    history: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("stream.ack"),
    subscriptionId: StreamIdSchema,
    through: safePositive,
  }),
  z
    .object({
      type: z.literal("stream.history.get"),
      subscriptionId: StreamIdSchema,
      requestId: StreamIdSchema,
      before: safeNonnegative,
      count: z.number().int().min(1).max(STREAM_LIMITS.historyLines),
      /** Both are required by the raw-history owner; legacy snapshot requests omit them. */
      capture: StreamIdSchema.optional(),
      generation: safeNonnegative.optional(),
    })
    .refine((request) => (request.capture === undefined) === (request.generation === undefined)),
  z.object({
    type: z.literal("stream.error"),
    subscriptionId: StreamIdSchema,
    code: z.enum([
      "screen-too-large",
      "history-unavailable",
      "history-reset",
      "history-line-too-large",
      "stalled",
      "invalid-transfer",
      "unsupported",
      "session-gone",
    ]),
    requestId: StreamIdSchema.optional(),
    /** Optional detail for history-unavailable; older peers retain the generic error. */
    historyReason: z.literal("fetch-window").optional(),
  }),
  StreamChunkSchema,
]);
export type StreamMessage = z.infer<typeof StreamMessageSchema>;
