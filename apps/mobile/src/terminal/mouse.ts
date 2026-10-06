import { STREAM_LIMITS, type TerminalMouseClick } from "@shellbell/protocol";
import type { StreamDisplayRow } from "../screen/stream-presentation";

/** Validate WebView input against the current native model, not the sender's geometry. */
export function terminalMouseClick(
  message: {
    key?: unknown;
    column?: unknown;
    row?: unknown;
    button?: unknown;
    modifiers?: unknown;
  },
  rows: readonly StreamDisplayRow[],
  cols: number,
  liveRows: number,
): TerminalMouseClick | null {
  const { key, column, row, button, modifiers } = message;
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > STREAM_LIMITS.cols ||
    !Number.isInteger(liveRows) ||
    liveRows < 1 ||
    liveRows > STREAM_LIMITS.rows ||
    typeof key !== "string" ||
    typeof column !== "number" ||
    !Number.isInteger(column) ||
    column < 0 ||
    column >= cols ||
    typeof row !== "number" ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= liveRows ||
    typeof button !== "string" ||
    !["left", "right", "middle"].includes(button) ||
    typeof modifiers !== "number" ||
    !Number.isInteger(modifiers) ||
    modifiers < 0 ||
    modifiers > 7
  )
    return null;
  const source = rows.find((entry) => entry.key === key);
  if (source?.kind !== "line" || source.liveRowIndex !== row) return null;
  return {
    column,
    row,
    cols,
    rows: liveRows,
    button: button as TerminalMouseClick["button"],
    modifiers,
  };
}
