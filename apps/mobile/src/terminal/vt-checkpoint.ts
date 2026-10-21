import { STREAM_LIMITS, VT_CONTINUATION_PREAMBLE } from "@shellbell/protocol";
import type { ISerializeOptions } from "@xterm/addon-serialize";
import { TERMINAL_BUFFER_LIMIT, VT_HISTORY_BYTES, VT_MESSAGE_BYTES } from "./vt-limits";

/** One shared budget for retained history, the current seed and its exact byte tail. */
export { VT_CHECKPOINT_BYTES, VT_HISTORY_BYTES } from "./vt-limits";

export interface VtHistoryCheckpoint {
  readonly data: Uint8Array;
  readonly rows: number;
  readonly dropped: boolean;
}

/** Public xterm APIs shared by the browser terminal and the headless conformance tests. */
export interface CheckpointTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly normal: { readonly baseY: number; readonly cursorY: number } };
  readonly options: { scrollback?: number };
  write(data: Uint8Array, callback: () => void): void;
  resize(cols: number, rows: number): void;
  registerMarker(
    cursorYOffset?: number,
  ): { readonly isDisposed: boolean; readonly line: number; dispose(): void } | undefined;
}

export interface HistorySerializer {
  serialize(options: ISerializeOptions): string;
}

const encoder = new TextEncoder();
// xterm stores LNM and DEC cursor blink as options, which RIS does not reset.
const reset = encoder.encode("\x18\x1bc\x1b[20l\x1b[?12l");
const framing = encoder.encode(VT_CONTINUATION_PREAMBLE);

/** Clear parser and terminal state when changing between raw and snapshot rendering. */
export async function resetVtTerminal(term: CheckpointTerminal): Promise<void> {
  await writeVt(term, reset);
  await writeVt(term, framing);
}

/** Byte writes also flush a pending UTF-8 decoder; string writes cannot do that. */
export function writeVt(term: CheckpointTerminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function geometry(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 1 ||
    cols > STREAM_LIMITS.cols ||
    rows < 1 ||
    rows > STREAM_LIMITS.rows
  )
    throw new Error("Invalid checkpoint geometry");
}

function tabStops(cols: number): Uint8Array {
  let data = "\x1b[3g";
  for (let col = 8; col < cols; col += 8) data += `\x1b[1;${col + 1}H\x1bH`;
  return encoder.encode(`${data}\x1b[H\x1b7`);
}

/**
 * Restore only serialized history, never an arbitrary parser/mode snapshot. Both a live
 * cutover and a document reload take this same canonical path, then replay the exact seed
 * and byte tail. Even a seed ending halfway through an escape sequence remains replayable.
 */
export async function restoreVtHistory(
  term: CheckpointTerminal,
  history: VtHistoryCheckpoint,
  cols: number,
  rows: number,
  progress?: () => void,
): Promise<void> {
  geometry(cols, rows);
  if (
    !Number.isSafeInteger(history.rows) ||
    history.rows < 0 ||
    history.rows > TERMINAL_BUFFER_LIMIT ||
    history.data.byteLength > VT_HISTORY_BYTES ||
    (history.rows === 0) !== (history.data.byteLength === 0)
  )
    throw new Error("Invalid terminal history checkpoint");
  await writeVt(term, reset);
  term.options.scrollback = TERMINAL_BUFFER_LIMIT;
  term.resize(cols, rows);
  if (history.rows > 0) {
    for (let at = 0; at < history.data.length; at += VT_MESSAGE_BYTES) {
      await writeVt(term, history.data.subarray(at, at + VT_MESSAGE_BYTES));
      progress?.();
    }
    await writeVt(term, encoder.encode(`\x1b[0m${"\r\n".repeat(rows)}`));
    if (term.buffer.normal.baseY !== history.rows) {
      await writeVt(term, reset);
      await writeVt(term, framing);
      await writeVt(term, tabStops(cols));
      throw new Error("Terminal history did not restore its row boundary");
    }
  }
  await writeVt(term, framing);
  await writeVt(term, tabStops(cols));
}

/**
 * Stop the old parser and erase its live grid BEFORE resizing: otherwise reflow can push
 * obsolete screen cells into retained history. The divider makes this unproven join visible.
 * Rebuild from the captured history so live and restored terminals begin in identical modes.
 */
export async function checkpointVtHistory(
  term: CheckpointTerminal,
  serializer: HistorySerializer,
  cols: number,
  rows: number,
  budget = VT_HISTORY_BYTES,
  readingPosition?: { row: number },
): Promise<VtHistoryCheckpoint> {
  geometry(cols, rows);
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > VT_HISTORY_BYTES)
    throw new Error("Invalid terminal history budget");
  await writeVt(term, framing);
  const anchor = readingPosition
    ? term.registerMarker(readingPosition.row - term.buffer.normal.baseY)
    : undefined;
  const first =
    term.buffer.normal.baseY > 0 ? term.registerMarker(-term.buffer.normal.baseY) : undefined;
  try {
    term.resize(cols, rows);
    // Growing a one-row viewport can pull scrollback down into the live area.
    // The pre-resize cursor was at row zero, so move those rows back to history
    // before writing the divider or clearing/rebuilding the new live screen.
    const pulled = term.buffer.normal.cursorY;
    if (pulled > 0)
      await writeVt(term, encoder.encode(`\x1b[${rows};1H${"\n".repeat(pulled)}\x1b[2J\x1b[H`));
    await writeVt(term, tabStops(cols));
    const label = "[History may have a gap or overlap]".slice(0, cols);
    await writeVt(term, encoder.encode(`\x1b[2m${label}\x1b[0m\x1b[${rows};1H\n\x1b[H`));
    const available = term.buffer.normal.baseY;
    const serialize = (keep: number, newer = 0): Uint8Array =>
      keep === 0
        ? new Uint8Array()
        : encoder.encode(
            serializer.serialize({
              range: { start: available - newer - keep, end: available - newer - 1 },
              excludeModes: true,
              excludeAltBuffer: true,
            }),
          );
    let keep = 0;
    let data: Uint8Array = new Uint8Array();
    const ceiling = budget > 0 ? Math.min(available, TERMINAL_BUFFER_LIMIT) : 0;
    let high = 0;
    let estimated = 0;
    // Measure only small newly added slices: doubling a row range can jump from
    // thousands of plain rows to thousands of densely styled rows in one probe.
    // Individual cells may themselves contain long combining sequences, so this
    // limits rows per probe rather than promising a hard transient heap bound.
    const sliceRows = Math.max(1, Math.min(64, Math.floor(budget / (term.cols * 128))));
    while (keep < ceiling) {
      const count = Math.min(sliceRows, ceiling - keep);
      const cost = serialize(count, keep).byteLength + count * 2 + 8;
      high = keep + count;
      if (estimated + cost > budget) break;
      estimated += cost;
      keep = high;
    }
    data = serialize(keep);
    if (data.byteLength > budget) {
      // The final combined range is authoritative; serializer boundary/BCE
      // behavior is not strictly additive or monotonic in the retained rows.
      high = keep - 1;
      keep = 0;
      data = new Uint8Array();
    }
    while (keep < high) {
      const candidate = Math.ceil((keep + high) / 2);
      const encoded = serialize(candidate);
      if (encoded.byteLength <= budget) {
        keep = candidate;
        data = encoded;
      } else high = candidate - 1;
    }
    const history = { data, rows: keep, dropped: keep < available || first?.isDisposed === true };
    // Map the reader through reflow and prefix eviction before RIS disposes all markers.
    if (readingPosition)
      readingPosition.row =
        anchor && !anchor.isDisposed ? Math.max(0, anchor.line - (available - keep)) : 0;
    await restoreVtHistory(term, history, cols, rows);
    return history;
  } finally {
    first?.dispose();
    anchor?.dispose();
  }
}
