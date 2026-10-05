import { tmuxQuote } from "./control.js";

export const LIST_PANES_FORMAT =
  "#{pane_id}\\t#{session_id}\\t#{session_name}\\t#{window_id}\\t#{window_index}\\t#{window_name}\\t#{pane_index}\\t#{pane_title}\\t#{pane_current_path}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{window_active}\\t#{history_size}\\t#{cursor_x}\\t#{cursor_y}\\t#{pane_dead}\\t#{pane_current_command}";
export const LIST_CLIENTS_FORMAT = "#{client_session}\\t#{client_control_mode}";
export const DISPLAY_FORMAT =
  "#{cursor_x}\\t#{cursor_y}\\t#{history_size}\\t#{pane_width}\\t#{pane_height}";
export const HISTORY_DISPLAY_FORMAT =
  "#{cursor_x}\\t#{cursor_y}\\t#{history_size}\\t#{pane_width}\\t#{pane_height}\\t#{history_limit}\\t#{alternate_on}";

/** Each format, real-TABbed and tmux-quoted, computed once instead of at every call site. */
const quoted = (fmt: string) => tmuxQuote(fmt.replace(/\\t/g, "\t"));
export const Q_PANES = quoted(LIST_PANES_FORMAT);
export const Q_CLIENTS = quoted(LIST_CLIENTS_FORMAT);
export const Q_DISPLAY = quoted(DISPLAY_FORMAT);
export const Q_HISTORY_DISPLAY = quoted(HISTORY_DISPLAY_FORMAT);

export interface HistoryDisplay {
  cursorX: number;
  cursorY: number;
  historySize: number;
  width: number;
  height: number;
  historyLimit: number;
  alternate: boolean;
}

export interface PaneRow {
  paneId: string;
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneTitle: string;
  cwd: string;
  width: number;
  height: number;
  paneActive: boolean;
  windowActive: boolean;
  historySize: number;
  cursorX: number;
  cursorY: number;
  dead: boolean;
  currentCommand: string;
}

const n = (s: string | undefined) => Number.parseInt(s ?? "0", 10) || 0;

export function parsePaneRow(row: string): PaneRow {
  const f = row.split("\t");
  return {
    paneId: f[0] ?? "",
    sessionId: f[1] ?? "",
    sessionName: f[2] ?? "",
    windowId: f[3] ?? "",
    windowIndex: n(f[4]),
    windowName: f[5] ?? "",
    paneIndex: n(f[6]),
    paneTitle: f[7] ?? "",
    cwd: f[8] ?? "",
    width: n(f[9]),
    height: n(f[10]),
    paneActive: f[11] === "1",
    windowActive: f[12] === "1",
    historySize: n(f[13]),
    cursorX: n(f[14]),
    cursorY: n(f[15]),
    dead: f[16] === "1",
    currentCommand: f[17] ?? "",
  };
}

export function parseClientRow(row: string): { sessionId: string; controlMode: boolean } {
  const f = row.split("\t");
  return { sessionId: f[0] ?? "", controlMode: f[1] === "1" };
}

export function parseDisplay(row: string): {
  cursorX: number;
  cursorY: number;
  historySize: number;
  width: number;
  height: number;
} {
  const f = row.split("\t");
  return {
    cursorX: n(f[0]),
    cursorY: n(f[1]),
    historySize: n(f[2]),
    width: n(f[3]),
    height: n(f[4]),
  };
}

/** Strict facts used to anchor a conservative, capture-bound history read. */
export function parseHistoryDisplay(row: string): HistoryDisplay | null {
  const f = row.split("\t");
  if (f.length !== 7 || (f[6] !== "0" && f[6] !== "1")) return null;
  const values = f.slice(0, 6).map(parseCanonicalNonnegative);
  if (values.some((value) => value === null)) return null;
  const [cursorX, cursorY, historySize, width, height, historyLimit] = values as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (width < 1 || height < 1) return null;
  return {
    cursorX,
    cursorY,
    historySize,
    width,
    height,
    historyLimit,
    alternate: f[6] === "1",
  };
}

function parseCanonicalNonnegative(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function titleFor(p: PaneRow, hostname: string): string {
  if (p.windowName && p.windowName !== p.currentCommand) return p.windowName;
  if (p.paneTitle && p.paneTitle !== hostname) return p.paneTitle;
  return `${p.sessionName}:${p.windowIndex}.${p.paneIndex}`;
}
