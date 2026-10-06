import type { Terminal } from "@xterm/xterm";

/** Touch handles use xterm's public selection/buffer APIs, never a second text snapshot. */
export class TerminalSelection {
  enabled = false;
  private drag: { id: number; fixed: number; offsetX: number; offsetY: number } | null = null;
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
          const position = terminal.getSelectionPosition();
          const point = position?.[end];
          const fixed = position?.[end === "start" ? "end" : "start"];
          const screen = surface.querySelector(".xterm-screen")?.getBoundingClientRect();
          if (!point || !fixed || !screen?.width || !screen.height) return;
          event.preventDefault();
          event.stopPropagation();
          this.drag = {
            id: event.pointerId,
            fixed: fixed.y * terminal.cols + fixed.x,
            offsetX: screen.left + (point.x * screen.width) / terminal.cols - event.clientX,
            offsetY:
              screen.top +
              ((point.y - terminal.buffer.active.viewportY + 0.5) * screen.height) / terminal.rows -
              event.clientY,
          };
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
    const viewport = this.surface.parentElement?.getBoundingClientRect() ?? parent;
    const inset = 22; // A full 44px touch target stays inside the visible viewport.
    const clamp = (value: number, low: number, high: number) =>
      Math.max(low + inset, Math.min(value, high - inset));
    for (const end of ["start", "end"] as const) {
      const button = this.handles[end];
      const point = selection?.[end];
      const y = point ? point.y - this.terminal.buffer.active.viewportY : -1;
      button.hidden = !this.enabled || this.busy() || !point || y < 0 || y >= this.terminal.rows;
      if (point) {
        button.style.left = `${clamp(rect.left + (point.x * rect.width) / this.terminal.cols, viewport.left, viewport.right) - parent.left}px`;
        button.style.top = `${clamp(rect.top + ((y + 1) * rect.height) / this.terminal.rows, viewport.top, viewport.bottom) - parent.top}px`;
      }
    }
  }

  private cell(event: { clientX: number; clientY: number }) {
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
    if (!this.terminal.hasSelection()) return;
    const point = this.cell({
      clientX: event.clientX + this.drag.offsetX,
      clientY: event.clientY + this.drag.offsetY,
    });
    if (!point) return;
    const moved = point.y * this.terminal.cols + point.x;
    const fixed = this.drag.fixed;
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
