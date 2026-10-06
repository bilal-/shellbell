import type { TerminalRow } from "./adapter";
import { encodeLine, paintViewport } from "./adapter";

const CSI = "\x1b[";
export const TERMINAL_BUFFER_LIMIT = 10_000;

export interface BufferTerminal {
  readonly cols: number;
  readonly rows: number;
  options: { scrollback?: number };
  resize(cols: number, rows: number): void;
  write(data: string, callback: () => void): void;
}

/** Map bounded host snapshots into xterm's actual buffer; no second viewport or scroll model. */
export class TerminalBuffer {
  private previous: readonly TerminalRow[] = [];
  private cols = 0;
  private liveRows = 0;
  constructor(private readonly terminal: BufferTerminal) {}

  async present(
    rows: readonly TerminalRow[],
    cols: number,
    liveRows: number,
  ): Promise<"rebuild" | "update" | "append"> {
    if (
      !Number.isInteger(cols) ||
      cols < 1 ||
      cols > 512 ||
      !Number.isInteger(liveRows) ||
      liveRows < 1 ||
      liveRows > 256 ||
      rows.length > TERMINAL_BUFFER_LIMIT + liveRows
    )
      throw new Error("Unsupported terminal geometry");
    const previousHistory = this.previous.filter((row) => row.liveRow === undefined);
    const history = rows.filter((row) => row.liveRow === undefined);
    this.terminal.options.scrollback = history.length;
    const live = rows.filter((row) => row.liveRow !== undefined);
    // Fill omitted source cells/rows, including blank live rows, rather than shifting their coordinates.
    const screen = Array.from(
      { length: liveRows },
      (_, index) =>
        live.find((row) => row.liveRow === index) ?? {
          key: `blank:${index}`,
          history: false,
          liveRow: index,
          line: { r: [] },
        },
    );
    let kind: "rebuild" | "update" | "append" = "rebuild";
    let data: string;
    const geometryChanged = this.cols !== cols || this.liveRows !== liveRows;
    let retained = -1;
    if (!geometryChanged) {
      const offset = history.length
        ? previousHistory.findIndex((row) => row.key === history[0]?.key)
        : previousHistory.length;
      if (offset >= 0) {
        const tail = previousHistory.slice(offset);
        if (
          tail.length <= history.length &&
          tail.every(
            (row, index) =>
              row.key === history[index]?.key &&
              row.line === history[index]?.line &&
              row.absoluteRow === history[index]?.absoluteRow,
          )
        )
          retained = tail.length;
      }
    }
    const appended = retained >= 0 ? history.slice(retained) : [];
    // Soft-wrap relationships require replay at structural boundaries. Ordinary line output is
    // appended through real xterm scrolling; live snapshot updates never replay old history.
    const canAppend =
      retained >= 0 &&
      appended.every((row) => !row.line.w) &&
      !history[retained - 1]?.line.w &&
      !this.previous.some((row) => row.liveRow === 0 && row.line.w);
    if (
      !geometryChanged &&
      retained >= 0 &&
      appended.length === 0 &&
      previousHistory.length === history.length
    ) {
      kind = "update";
      data = paintViewport(screen, cols);
    } else if (!geometryChanged && canAppend && appended.length > 0) {
      kind = "append";
      data = `${CSI}?25l${CSI}?7l`;
      for (const row of appended) {
        data += `${CSI}1;1H${CSI}2K${encodeLine(row.line, cols).text}${CSI}${liveRows};1H\n`;
      }
      data += paintViewport(screen, cols);
    } else {
      this.terminal.resize(cols, liveRows);
      // ED3 clears scrollback and ED2 clears the live grid in the same write as replacement.
      // RIS would reset addons/modes and expose a blank frame between native updates.
      data = `${CSI}?25l${CSI}?7h${CSI}3J${CSI}2J${CSI}H`;
      for (let index = 0; index < history.length; index++) {
        const row = history[index]!;
        const next = history[index + 1] ?? screen[0];
        const encoded = encodeLine(row.line, cols);
        data += encoded.text || " ";
        if (
          row.line.w &&
          row.absoluteRow !== undefined &&
          next?.absoluteRow === row.absoluteRow + 1
        )
          data += `${CSI}0m${" ".repeat(Math.max(0, cols - Math.max(1, encoded.cells)))}`;
        else data += "\r\n";
      }
      // Move all imported history above the source screen. Filling the last rows makes the
      // resulting buffer's baseY equal to the number of retained source history rows.
      for (let index = 0; index < screen.length; index++) {
        const row = screen[index]!;
        const encoded = encodeLine(row.line, cols);
        data += encoded.text || " ";
        const next = screen[index + 1];
        if (next) {
          if (
            row.line.w &&
            row.absoluteRow !== undefined &&
            next.absoluteRow === row.absoluteRow + 1
          )
            data += `${CSI}0m${" ".repeat(Math.max(0, cols - Math.max(1, encoded.cells)))}`;
          else data += "\r\n";
        }
      }
      data += `${CSI}0m${CSI}H`;
    }
    await new Promise<void>((resolve) => this.terminal.write(data, resolve));
    this.previous = rows;
    this.cols = cols;
    this.liveRows = liveRows;
    return kind;
  }
}
