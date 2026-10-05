import { z } from "zod";
import { decodeBoundedRecord } from "./bounded-cbor.js";
import { encodeCbor, ProtocolError } from "./codec.js";
import { CursorSchema } from "./inner.js";
import {
  codePoints,
  emptyLine,
  type Line,
  type ScreenDiff,
  type ScreenSnapshot,
  stripStyles,
} from "./screen.js";
import {
  StreamSourceLineSchema as sourceLine,
  StreamLineSchema as strictLine,
} from "./stream-line.js";
import { STREAM_LIMITS, type StreamTransferMeta, StreamTransferMetaSchema } from "./stream-wire.js";

const safeNonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safePositive = safeNonnegative.min(1);

const strictCursor = CursorSchema.extend({
  x: safeNonnegative,
  y: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const sourceSnapshot = z.strictObject({
  cols: safePositive,
  rows: safePositive,
  cursor: strictCursor,
  lines: z.array(sourceLine),
  scrollbackTotal: safeNonnegative,
  gen: safeNonnegative,
  reset: z.boolean().optional(),
  degraded: z.boolean().optional(),
});

function geometry(screen: ScreenSnapshot): boolean {
  return (
    screen.lines.length === screen.rows &&
    screen.cursor.x <= screen.cols &&
    screen.cursor.y < screen.rows &&
    linesFit(screen.lines, screen.cols)
  );
}

function linesFit(lines: Line[], cols: number): boolean {
  return lines.every((line) => {
    let cells = 0;
    for (const run of line.r) {
      cells += run.n ?? codePoints(run.t);
      if (cells > cols) return false;
    }
    return true;
  });
}

function totals(lines: Line[]): { runs: number; points: number } {
  let runs = 0;
  let points = 0;
  for (const line of lines) {
    runs += line.r.length;
    for (const run of line.r) points += codePoints(run.t);
  }
  return { runs, points };
}

function boundedTotals(lines: Line[]): boolean {
  const { runs, points } = totals(lines);
  return runs <= STREAM_LIMITS.runs && points <= STREAM_LIMITS.codePoints;
}

const snapshotRecord = sourceSnapshot
  .extend({
    kind: z.literal("snapshot"),
    cols: safePositive.max(STREAM_LIMITS.cols),
    rows: safePositive.max(STREAM_LIMITS.rows),
    lines: z.array(strictLine).max(STREAM_LIMITS.rows),
  })
  .refine((value) => geometry(value) && boundedTotals(value.lines));

const sourceDiff = z.strictObject({
  scroll: safeNonnegative.max(STREAM_LIMITS.rows),
  changed: z
    .array(
      z.strictObject({
        i: safeNonnegative.max(STREAM_LIMITS.rows - 1),
        line: strictLine,
      }),
    )
    .max(STREAM_LIMITS.rows),
  cursor: strictCursor.extend({
    x: safeNonnegative.max(STREAM_LIMITS.cols),
    y: strictCursor.shape.y.max(STREAM_LIMITS.rows - 1),
  }),
  scrollbackTotal: safeNonnegative,
  gen: safePositive,
});
const diffRecord = sourceDiff.extend({ kind: z.literal("diff") }).refine((value) => {
  const indices = new Set(value.changed.map((change) => change.i));
  const lines = value.changed.map((change) => change.line);
  return (
    indices.size === value.changed.length &&
    linesFit(lines, STREAM_LIMITS.cols) &&
    boundedTotals(lines)
  );
});

export const StreamScreenRecordSchema = z.discriminatedUnion("kind", [snapshotRecord, diffRecord]);
export type StreamScreenRecord = z.infer<typeof StreamScreenRecordSchema>;
export type StreamScreenResult =
  | { ok: true; screen: ScreenSnapshot }
  | { ok: false; code: "missing-baseline" | "invalid-transfer" };

/** Full validation for direct local callers as well as bounded wire decoding. */
function checkedRecord(value: unknown): { record: StreamScreenRecord; bytes: Uint8Array } {
  const parsed = StreamScreenRecordSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError("malformed");
  let bytes: Uint8Array;
  try {
    bytes = encodeCbor(parsed.data);
  } catch {
    throw new ProtocolError("malformed");
  }
  if (bytes.length > STREAM_LIMITS.screenBytes) throw new ProtocolError("malformed");
  return { record: parsed.data, bytes };
}

function viewport(record: Extract<StreamScreenRecord, { kind: "snapshot" }>): ScreenSnapshot {
  const { kind: _kind, ...screen } = record;
  return screen;
}

export function decodeStreamScreen(
  meta: StreamTransferMeta,
  bytes: Uint8Array,
): StreamScreenRecord {
  const metadata = StreamTransferMetaSchema.safeParse(meta);
  if (!metadata.success || metadata.data.kind === "history") throw new ProtocolError("malformed");
  const parsed = StreamScreenRecordSchema.safeParse(
    decodeBoundedRecord(bytes, STREAM_LIMITS.screenBytes),
  );
  if (
    !parsed.success ||
    parsed.data.kind !== metadata.data.kind ||
    parsed.data.gen !== metadata.data.generation
  )
    throw new ProtocolError("malformed");
  return parsed.data;
}

export function applyStreamScreen(
  previous: ScreenSnapshot | undefined,
  record: StreamScreenRecord,
): StreamScreenResult {
  try {
    const incoming = checkedRecord(record).record;
    if (incoming.kind === "snapshot") return { ok: true, screen: viewport(incoming) };
    if (!previous) return { ok: false, code: "missing-baseline" };
    const parsedPrevious = sourceSnapshot.safeParse(previous);
    if (!parsedPrevious.success) return { ok: false, code: "invalid-transfer" };
    const baseline = checkedRecord({ kind: "snapshot", ...parsedPrevious.data }).record;
    if (baseline.kind !== "snapshot") return { ok: false, code: "invalid-transfer" };
    if (incoming.gen !== baseline.gen + 1) return { ok: false, code: "missing-baseline" };
    if (
      incoming.scroll > baseline.rows ||
      incoming.changed.some((change) => change.i >= baseline.rows)
    )
      return { ok: false, code: "invalid-transfer" };
    const lines = baseline.lines.slice(incoming.scroll);
    for (let i = 0; i < incoming.scroll; i++) lines.push(emptyLine());
    for (const change of incoming.changed) lines[change.i] = change.line;
    const next = checkedRecord({
      kind: "snapshot",
      cols: baseline.cols,
      rows: baseline.rows,
      lines,
      cursor: incoming.cursor,
      scrollbackTotal: incoming.scrollbackTotal,
      gen: incoming.gen,
      ...(baseline.degraded === undefined ? {} : { degraded: baseline.degraded }),
    }).record;
    if (next.kind !== "snapshot") return { ok: false, code: "invalid-transfer" };
    return { ok: true, screen: viewport(next) };
  } catch {
    return { ok: false, code: "invalid-transfer" };
  }
}

export function prepareStreamSnapshot(
  snapshot: ScreenSnapshot,
):
  | { ok: true; snapshot: ScreenSnapshot; bytes: Uint8Array }
  | { ok: false; code: "screen-too-large" | "invalid-transfer" } {
  const parsed = sourceSnapshot.safeParse(snapshot);
  if (!parsed.success || !geometry(parsed.data)) return { ok: false, code: "invalid-transfer" };
  const source = parsed.data;
  if (
    source.cols > STREAM_LIMITS.cols ||
    source.rows > STREAM_LIMITS.rows ||
    totals(source.lines).points > STREAM_LIMITS.codePoints
  )
    return { ok: false, code: "screen-too-large" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate =
      attempt === 0 ? source : { ...source, lines: source.lines.map(stripStyles), degraded: true };
    try {
      const { record, bytes } = checkedRecord({ kind: "snapshot", ...candidate });
      if (record.kind === "snapshot") return { ok: true, snapshot: viewport(record), bytes };
    } catch {
      // Shape/geometry/individual runs were checked above. Only size can fail here.
    }
  }
  return { ok: false, code: "screen-too-large" };
}

export function encodeStreamDiff(diff: ScreenDiff): Uint8Array {
  const parsed = sourceDiff.safeParse(diff);
  if (!parsed.success) throw new ProtocolError("malformed");
  return checkedRecord({ kind: "diff", ...parsed.data }).bytes;
}
