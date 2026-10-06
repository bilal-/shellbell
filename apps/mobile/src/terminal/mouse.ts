import { STREAM_LIMITS, type TerminalMouseClick } from "@shellbell/protocol";
import type { StreamDisplayRow } from "../screen/stream-presentation";
import type { TerminalRow } from "./adapter";

/** Map measured xterm cells, including horizontal scrolling and live padding. */
export function terminalCellAtPoint(
  rows: readonly TerminalRow[],
  cols: number,
  box: { left: number; top: number; width: number; height: number },
  paintedRowCount: number,
  x: number,
  y: number,
): { key: string; column: number; row: number } | null {
  if (
    ![x, y, box.left, box.top, box.width, box.height, cols, paintedRowCount].every(
      Number.isFinite,
    ) ||
    box.width <= 0 ||
    box.height <= 0 ||
    cols <= 0 ||
    paintedRowCount <= 0
  )
    return null;
  const column = Math.floor(((x - box.left) * cols) / box.width);
  const index = Math.floor(((y - box.top) * paintedRowCount) / box.height);
  const line = rows[index];
  if (
    column < 0 ||
    column >= cols ||
    index < 0 ||
    index >= paintedRowCount ||
    !line ||
    line.history ||
    line.liveRow === undefined
  )
    return null;
  return { key: line.key, column, row: line.liveRow };
}

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
