import {
  type InitialTerminalSize,
  INITIAL_TERMINAL_SIZE_LIMITS as limits,
} from "@shellbell/protocol";

export interface TerminalViewportSize {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}
type Insets = { left?: number; right?: number; top?: number; bottom?: number };
const bounded = (cols: number, rows: number): InitialTerminalSize => ({
  cols: Math.max(limits.minCols, Math.min(limits.maxCols, Math.floor(cols))),
  rows: Math.max(limits.minRows, Math.min(limits.maxRows, Math.floor(rows))),
});

/** Phone-only, in-memory geometry; reading a view never sends a resize request. */
export class InitialTerminalSizer {
  private measured: (TerminalViewportSize & { windowHeight: number }) | null = null;

  remember(value: unknown, windowHeight: number): void {
    if (!value || typeof value !== "object") return;
    const sample = value as TerminalViewportSize;
    if (
      ![sample.cols, sample.rows, sample.width, sample.height, sample.fontSize].every(
        Number.isFinite,
      ) ||
      !Number.isSafeInteger(sample.cols) ||
      !Number.isSafeInteger(sample.rows) ||
      sample.cols < 1 ||
      sample.cols > 10000 ||
      sample.rows < 1 ||
      sample.rows > 10000 ||
      sample.width < 20 ||
      sample.width > 10000 ||
      sample.height < 20 ||
      sample.height > 10000 ||
      sample.fontSize < 5 ||
      sample.fontSize > 72 ||
      !Number.isFinite(windowHeight) ||
      windowHeight < sample.height ||
      windowHeight > 10000
    )
      return;
    const old = this.measured;
    // Keyboard and accessory animations can deliver a late, shorter viewport.
    // Preserve the largest keyboard-closed reading area in this app window.
    if (
      old &&
      Math.abs(old.width - sample.width) <= 2 &&
      old.fontSize === sample.fontSize &&
      Math.abs(old.windowHeight - windowHeight) <= 2 &&
      old.height > sample.height
    )
      return;
    this.measured = {
      cols: sample.cols,
      rows: sample.rows,
      width: sample.width,
      height: sample.height,
      fontSize: sample.fontSize,
      windowHeight,
    };
  }

  forWindow(
    window: { width: number; height: number },
    fontSize: number,
    insets: Insets = {},
    keyboardVisible = false,
  ): InitialTerminalSize | undefined {
    const inset = (value: number | undefined) =>
      Number.isFinite(value) && value! > 0 ? value! : 0;
    const width = window.width - inset(insets.left) - inset(insets.right);
    const height = window.height - inset(insets.top) - inset(insets.bottom);
    if (
      ![width, height, fontSize].every(Number.isFinite) ||
      width < 20 ||
      height < 20 ||
      fontSize < 5 ||
      fontSize > 72
    )
      return undefined;
    const measured = this.measured;
    if (
      measured &&
      Math.abs(measured.width - width) <= 2 &&
      measured.fontSize === fontSize &&
      (keyboardVisible || Math.abs(window.height - measured.windowHeight) <= 2)
    )
      return bounded(measured.cols, measured.rows);
    // Before any terminal was measured, reserve space for navigation and input.
    // Bundled JetBrains Mono metrics: 0.6 em advance, 1.32 em ascent + descent.
    return bounded(
      width / (fontSize * 0.6),
      Math.max(0, height - 192) / Math.ceil(fontSize * 1.32),
    );
  }
}

export const initialTerminalSizer = new InitialTerminalSizer();
