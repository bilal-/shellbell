import type { Terminal } from "@xterm/xterm";

/** Touch handles use xterm's public selection/buffer APIs, never a second text snapshot. */
export class TerminalSelection {
  enabled = false;
  private drag: { id: number; end: "start" | "end" } | null = null;
  private readonly handles: Record<"start" | "end", HTMLButtonElement>;

  constructor(
    private readonly terminal: Terminal,
    private readonly surface: HTMLElement,
    private readonly busy: () => boolean,
  ) {
    this.handles = Object.fromEntries(
      (["start", "end"] as const).map((end) => {
        const button = document.createElement("button");
        button.className = "selection-handle";
        button.setAttribute(
          "aria-label",
          `${end === "start" ? "Start" : "End"} of terminal selection`,
        );
        button.hidden = true;
        button.addEventListener("pointerdown", (event) => {
          if (!this.enabled || this.busy()) return;
          event.preventDefault();
          event.stopPropagation();
          this.drag = { id: event.pointerId, end };
          button.setPointerCapture(event.pointerId);
        });
        button.addEventListener("pointermove", (event) => this.move(event));
        const stop = () => {
          this.drag = null;
        };
        button.addEventListener("pointerup", stop);
        button.addEventListener("pointercancel", stop);
        surface.append(button);
        return [end, button];
      }),
    ) as Record<"start" | "end", HTMLButtonElement>;
    surface.addEventListener("pointerdown", (event) => {
      if (!this.enabled || this.busy() || event.pointerType !== "touch") return;
      const cell = this.cell(event);
      if (!cell) return;
      event.preventDefault();
      terminal.blur();
      terminal.select(0, cell.y, terminal.cols);
      this.refresh();
    });
    terminal.onSelectionChange(() => this.refresh());
    terminal.onScroll(() => this.refresh());
  }

  enable(enabled: boolean) {
    this.enabled = enabled;
    this.surface.classList.toggle("touch-select", enabled);
    if (enabled) this.terminal.blur();
    else this.drag = null;
    this.refresh();
  }

  refresh() {
    const selection = this.terminal.getSelectionPosition();
    const screen = this.surface.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const rect = screen.getBoundingClientRect();
    const parent = this.surface.getBoundingClientRect();
    for (const end of ["start", "end"] as const) {
      const button = this.handles[end];
      const point = selection?.[end];
      const y = point ? point.y - this.terminal.buffer.active.viewportY : -1;
      button.hidden = !this.enabled || this.busy() || !point || y < 0 || y >= this.terminal.rows;
      if (point) {
        button.style.left = `${rect.left - parent.left + (point.x * rect.width) / this.terminal.cols}px`;
        button.style.top = `${rect.top - parent.top + ((y + 1) * rect.height) / this.terminal.rows}px`;
      }
    }
  }

  private cell(event: PointerEvent) {
    const rect = this.surface.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return null;
    const x = Math.max(
      0,
      Math.min(
        this.terminal.cols,
        Math.round(((event.clientX - rect.left) * this.terminal.cols) / rect.width),
      ),
    );
    const y =
      this.terminal.buffer.active.viewportY +
      Math.max(
        0,
        Math.min(
          this.terminal.rows - 1,
          Math.floor(((event.clientY - rect.top) * this.terminal.rows) / rect.height),
        ),
      );
    return this.terminal.buffer.active.getLine(y) ? { x, y } : null;
  }

  private move(event: PointerEvent) {
    if (!this.drag || this.drag.id !== event.pointerId || this.busy()) return;
    event.preventDefault();
    const position = this.terminal.getSelectionPosition();
    const point = this.cell(event);
    if (!position || !point) return;
    const current = this.drag.end === "start" ? position.end : position.start;
    const moved = point.y * this.terminal.cols + point.x;
    const fixed = current.y * this.terminal.cols + current.x;
    const start = Math.min(moved, fixed);
    const length = Math.abs(moved - fixed);
    if (length)
      this.terminal.select(
        start % this.terminal.cols,
        Math.floor(start / this.terminal.cols),
        length,
      );
    this.refresh();
  }
}
