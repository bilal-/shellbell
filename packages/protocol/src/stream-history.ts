import { z } from "zod";
import { decodeBoundedRecord } from "./bounded-cbor.js";
import { encodeCbor, ProtocolError } from "./codec.js";
import { codePoints, type Line } from "./screen.js";
import { StreamRunSchema } from "./stream-line.js";
import {
  STREAM_LIMITS,
  StreamIdSchema,
  type StreamTransferMeta,
  StreamTransferMetaSchema,
} from "./stream-wire.js";

const safeNonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const common = {
  kind: z.literal("history"),
  generation: safeNonnegative,
  requestId: StreamIdSchema,
  before: safeNonnegative,
};
// Check the container before any schema walks or copies its elements.
const candidateLines = z.custom<unknown[]>(
  (value) => Array.isArray(value) && value.length > 0 && value.length <= STREAM_LIMITS.historyLines,
);
const pageShape = z.strictObject({
  ...common,
  status: z.literal("page"),
  from: safeNonnegative,
  to: safeNonnegative,
  oldestAvailable: safeNonnegative,
  lines: candidateLines,
});
function range(value: z.infer<typeof pageShape>): boolean {
  return (
    value.to === value.before &&
    value.lines.length <= Number.MAX_SAFE_INTEGER - value.from &&
    value.from + value.lines.length === value.to &&
    value.oldestAvailable <= value.from
  );
}
const sourcePage = pageShape.refine(range);
const recordPage = pageShape
  .extend({ nextBefore: safeNonnegative })
  .refine((value) => range(value) && value.nextBefore === value.from);
const boundary = z
  .strictObject({
    ...common,
    status: z.literal("boundary"),
    reason: z.enum(["end", "truncated"]),
    oldestAvailable: safeNonnegative,
  })
  .refine((value) =>
    value.reason === "end"
      ? value.before === value.oldestAvailable
      : value.before < value.oldestAvailable,
  );
const sourceShape = z.discriminatedUnion("status", [sourcePage, boundary]);
const recordShape = z.discriminatedUnion("status", [recordPage, boundary]);
const lineShape = z.strictObject({ r: z.unknown(), w: z.boolean().optional() });

export interface StreamHistoryCommon {
  kind: "history";
  generation: number;
  requestId: string;
  before: number;
}
export interface StreamHistoryPage extends StreamHistoryCommon {
  status: "page";
  from: number;
  to: number;
  oldestAvailable: number;
  nextBefore: number;
  lines: Line[];
}
export interface StreamHistoryBoundary extends StreamHistoryCommon {
  status: "boundary";
  reason: "end" | "truncated";
  oldestAvailable: number;
}
export type StreamHistoryRecord = StreamHistoryPage | StreamHistoryBoundary;
export type PreparedStreamHistory =
  | { ok: true; record: StreamHistoryRecord; bytes: Uint8Array }
  | { ok: false; code: "history-line-too-large"; before: number }
  | { ok: false; code: "invalid-transfer" };

type CheckedLine =
  | { ok: true; line: Line; bytes: number }
  | { ok: false; code: "invalid-transfer" | "history-line-too-large" };
const invalid = { ok: false, code: "invalid-transfer" } as const;
const tooLarge = { ok: false, code: "history-line-too-large" } as const;

/** Bound each temporary encoding before assembling a whole row. Zod owns RGB copies. */
function checkedLine(value: unknown): CheckedLine {
  const shell = lineShape.safeParse(value);
  if (!shell.success || !Array.isArray(shell.data.r)) return invalid;
  if (shell.data.r.length > 2048) return tooLarge;
  const line: Line = { r: [], ...(shell.data.w === undefined ? {} : { w: shell.data.w }) };
  let cells = 0;
  let runBytes = 0;
  for (const value of shell.data.r) {
    const run = StreamRunSchema.safeParse(value);
    if (!run.success) return invalid;
    cells += run.data.n ?? codePoints(run.data.t);
    if (cells > STREAM_LIMITS.historyCells) return tooLarge;
    runBytes += encodeCbor(run.data).length;
    if (runBytes > STREAM_LIMITS.historyBytes) return tooLarge;
    line.r.push(run.data);
  }
  const bytes = encodeCbor(line).length;
  return bytes > STREAM_LIMITS.historyBytes ? tooLarge : { ok: true, line, bytes };
}

// Direct schema callers receive the same bounded validation and independent ownership as decode.
export const StreamHistoryRecordSchema: z.ZodType<StreamHistoryRecord> = z
  .unknown()
  .transform((value, ctx) => {
    const reject = () => {
      ctx.addIssue({ code: "custom", message: "invalid history record" });
      return z.NEVER;
    };
    try {
      const parsed = recordShape.safeParse(value);
      if (!parsed.success) return reject();
      let record: StreamHistoryRecord;
      if (parsed.data.status === "boundary") record = parsed.data;
      else {
        const lines: Line[] = [];
        let rowBytes = 0;
        for (const value of parsed.data.lines) {
          const result = checkedLine(value);
          if (!result.ok) return reject();
          rowBytes += result.bytes;
          if (rowBytes > STREAM_LIMITS.historyBytes) return reject();
          lines.push(result.line);
        }
        record = { ...parsed.data, lines };
      }
      if (encodeCbor(record).length > STREAM_LIMITS.historyBytes) return reject();
      return record;
    } catch {
      return reject();
    }
  });

export function prepareStreamHistory(source: unknown): PreparedStreamHistory {
  try {
    const parsed = sourceShape.safeParse(source);
    if (!parsed.success) return invalid;
    if (parsed.data.status === "boundary") {
      const record = parsed.data;
      return { ok: true, record, bytes: encodeCbor(record) };
    }
    const sourcePage = parsed.data;
    const lines: Line[] = [];
    let rowBytes = 0;
    let best: Extract<PreparedStreamHistory, { ok: true }> | undefined;
    for (let i = sourcePage.lines.length - 1; i >= 0; i--) {
      const result = checkedLine(sourcePage.lines[i]);
      if (!result.ok) {
        if (result.code === "invalid-transfer") return invalid;
        break;
      }
      rowBytes += result.bytes;
      if (rowBytes > STREAM_LIMITS.historyBytes) break;
      lines.unshift(result.line);
      const from = sourcePage.from + i;
      const record: StreamHistoryPage = {
        ...sourcePage,
        from,
        nextBefore: from,
        lines: lines.slice(),
      };
      const bytes = encodeCbor(record);
      // Counter headers can shrink while extending a suffix: do not stop at full-record overflow.
      if (bytes.length <= STREAM_LIMITS.historyBytes) best = { ok: true, record, bytes };
    }
    return best ?? { ...tooLarge, before: sourcePage.before };
  } catch {
    return invalid;
  }
}

export function decodeStreamHistory(
  meta: StreamTransferMeta,
  bytes: Uint8Array,
): StreamHistoryRecord {
  const metadata = StreamTransferMetaSchema.safeParse(meta);
  if (!metadata.success || metadata.data.kind !== "history") throw new ProtocolError("malformed");
  const parsed = StreamHistoryRecordSchema.safeParse(
    decodeBoundedRecord(bytes, STREAM_LIMITS.historyBytes),
  );
  if (
    !parsed.success ||
    parsed.data.generation !== metadata.data.generation ||
    parsed.data.requestId !== metadata.data.requestId ||
    parsed.data.before !== metadata.data.before
  )
    throw new ProtocolError("malformed");
  return parsed.data;
}
