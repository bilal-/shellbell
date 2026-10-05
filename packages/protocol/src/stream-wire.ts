import { z } from "zod";
import { Bytes } from "./envelope.js";
import { SidSchema } from "./session-id.js";

export const BOUNDED_STREAM_FEATURE = "bounded-stream-v1";

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
  }),
  z.object({ type: z.literal("stream.cancel"), subscriptionId: StreamIdSchema }),
  z.object({ type: z.literal("stream.refresh"), subscriptionId: StreamIdSchema }),
  z.object({
    type: z.literal("stream.ack"),
    subscriptionId: StreamIdSchema,
    through: safePositive,
  }),
  z.object({
    type: z.literal("stream.history.get"),
    subscriptionId: StreamIdSchema,
    requestId: StreamIdSchema,
    before: safeNonnegative,
    count: z.number().int().min(1).max(STREAM_LIMITS.historyLines),
  }),
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
  }),
  StreamChunkSchema,
]);
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

export function supportsBoundedStream(
  local: readonly string[] | undefined,
  remote: readonly string[] | undefined,
): boolean {
  return (
    local?.includes(BOUNDED_STREAM_FEATURE) === true &&
    remote?.includes(BOUNDED_STREAM_FEATURE) === true
  );
}
