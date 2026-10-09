import type { Line } from "@shellbell/protocol";
import { lineCells, parseAnsiLines } from "./convert.js";

export interface HerdrHistoryFacts {
  readonly paneId: string;
  readonly terminalId: string;
  readonly revision: number;
  readonly history: number;
  readonly viewportRows: number;
  readonly offset: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseHistoryFacts(
  value: unknown,
  paneId: string,
  terminalId: string,
): HerdrHistoryFacts | null {
  if (!isRecord(value) || value.type !== "pane_info" || !isRecord(value.pane)) return null;

  const pane = value.pane;
  if (
    typeof pane.pane_id !== "string" ||
    pane.pane_id.length === 0 ||
    pane.pane_id !== paneId ||
    typeof pane.terminal_id !== "string" ||
    pane.terminal_id.length === 0 ||
    pane.terminal_id !== terminalId ||
    !isSafeNonnegativeInteger(pane.revision) ||
    !isRecord(pane.scroll)
  ) {
    return null;
  }

  const scroll = pane.scroll;
  if (
    !isSafeNonnegativeInteger(scroll.offset_from_bottom) ||
    !isSafeNonnegativeInteger(scroll.max_offset_from_bottom) ||
    !isSafePositiveInteger(scroll.viewport_rows) ||
    scroll.offset_from_bottom > scroll.max_offset_from_bottom ||
    scroll.max_offset_from_bottom > Number.MAX_SAFE_INTEGER - scroll.viewport_rows
  ) {
    return null;
  }

  return {
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    revision: pane.revision,
    history: scroll.max_offset_from_bottom,
    viewportRows: scroll.viewport_rows,
    offset: scroll.offset_from_bottom,
  };
}

export function exactPhysicalRows(
  value: unknown,
  expected: {
    paneId: string;
    source: "visible" | "recent";
    rows: number;
    cols: number;
    /** Visible ANSI reads may trim a blank tail; history must match its captured shortfall. */
    minRows?: number;
  },
): Line[] | null {
  if (
    !isSafePositiveInteger(expected.rows) ||
    !isSafePositiveInteger(expected.cols) ||
    (expected.minRows !== undefined &&
      (!isSafeNonnegativeInteger(expected.minRows) || expected.minRows > expected.rows)) ||
    typeof expected.paneId !== "string" ||
    expected.paneId.length === 0 ||
    (expected.source !== "visible" && expected.source !== "recent") ||
    !isRecord(value) ||
    value.type !== "pane_read" ||
    !isRecord(value.read)
  ) {
    return null;
  }

  const read = value.read;
  if (
    typeof read.pane_id !== "string" ||
    read.pane_id.length === 0 ||
    read.pane_id !== expected.paneId ||
    read.source !== expected.source ||
    read.format !== "ansi" ||
    typeof read.text !== "string" ||
    typeof read.truncated !== "boolean"
  ) {
    return null;
  }

  const rows = parseAnsiLines(read.text);
  if (
    rows.length < (expected.minRows ?? expected.rows) ||
    rows.length > expected.rows ||
    rows.some((row) => lineCells(row) > expected.cols)
  ) {
    return null;
  }
  return rows;
}
