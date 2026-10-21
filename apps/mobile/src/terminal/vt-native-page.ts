import {
  type Line,
  nativeHistoryProof,
  type Run,
  STREAM_LIMITS,
  stringCells,
} from "@shellbell/protocol";

export interface NativeHistoryPageBytes {
  readonly data: Uint8Array;
  readonly rows: number;
  readonly proof: string;
}

/** Physical rows, with unknown wraps kept as hard boundaries and every row's pen reset. */
export function encodeNativeHistoryPage(
  lines: readonly Line[],
  cols: number,
): NativeHistoryPageBytes | null {
  if (lines.length < 1 || lines.length > STREAM_LIMITS.historyLines) return null;
  const proof = nativeHistoryProof(
    cols,
    lines.map((line) => line.r.map((run) => run.t).join("")),
  );
  if (!proof) return null;
  const rows: string[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const line of lines) {
    // Current native readers cannot supply wrap flags. A future reader must explicitly
    // negotiate how to replay known soft wraps rather than silently turning them hard.
    if (
      line.w === true ||
      line.r.reduce((cells, run) => cells + (run.n ?? stringCells(run.t)), 0) > cols
    )
      return null;
    const row = `${line.r.map((run) => style(run) + run.t).join("")}\x1b[0m`;
    bytes += encoder.encode(row).byteLength + 2;
    if (bytes > 4 * STREAM_LIMITS.historyBytes) return null;
    rows.push(row);
  }
  return { data: encoder.encode(rows.join("\r\n")), rows: lines.length, proof };
}

/** Runs state their complete pen, so capture boundaries never inherit an older row's style. */
function style(run: Run): string {
  const codes = [0];
  if (run.b) codes.push(1);
  if (run.f) codes.push(2);
  if (run.i) codes.push(3);
  if (run.u) codes.push(4);
  if (run.s) codes.push(9);
  for (const [color, base] of [
    [run.fg, 38],
    [run.bg, 48],
  ] as const) {
    if (Array.isArray(color)) codes.push(base, 2, ...color);
    else if (color !== undefined) codes.push(base, 5, color);
  }
  return `\x1b[${codes.join(";")}m`;
}
