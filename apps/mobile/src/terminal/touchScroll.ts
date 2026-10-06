import type { Terminal } from "@xterm/xterm";

/** xterm 6 owns the viewport but needs a phone gesture bridge to its public scroll API. */
export function bindTouchScroll(
  terminal: Terminal,
  surface: HTMLElement,
  container: HTMLElement,
  context: {
    blocked: () => boolean;
    busy: () => boolean;
    arm: () => void;
    scrolled: () => void;
  },
) {
  let drag: {
    id: number;
    x: number;
    y: number;
    previousY: number;
    previousTime: number;
    vertical: boolean;
    velocity: number;
  } | null = null;
  let remainder = 0;
  let animation = 0;
  const cancel = () => {
    cancelAnimationFrame(animation);
    animation = 0;
    drag = null;
    remainder = 0;
  };
  const scroll = (delta: number) => {
    const height =
      surface.querySelector(".xterm-screen")!.getBoundingClientRect().height / terminal.rows;
    if (!(height > 0)) return false;
    let pixels = delta + remainder;
    if (pixels < 0 && container.scrollTop > 0) {
      const before = container.scrollTop;
      container.scrollTop = Math.max(0, before + pixels);
      pixels -= container.scrollTop - before;
    }
    const before = terminal.buffer.active.viewportY;
    const lines = Math.trunc(pixels / height);
    if (lines) terminal.scrollLines(lines);
    pixels -= (terminal.buffer.active.viewportY - before) * height;
    if (pixels > 0 && terminal.buffer.active.viewportY === terminal.buffer.active.baseY) {
      const top = container.scrollTop;
      container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, top + pixels);
      pixels -= container.scrollTop - top;
    }
    // Only retain a fractional cell. Overscroll never accumulates across history fetches.
    remainder = Math.abs(pixels) < height ? pixels : 0;
    context.scrolled();
    return Math.abs(pixels) < height;
  };
  surface.addEventListener(
    "touchstart",
    (event) => {
      cancel();
      if (
        context.blocked() ||
        event.touches.length !== 1 ||
        (event.target instanceof Element && event.target.closest(".scrollbar, .selection-handle"))
      )
        return;
      const touch = event.touches[0]!;
      drag = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        previousY: touch.clientY,
        previousTime: performance.now(),
        vertical: false,
        velocity: 0,
      };
      context.arm();
    },
    { passive: true },
  );
  surface.addEventListener(
    "touchmove",
    (event) => {
      const state = drag;
      const touch = event.touches[0];
      if (
        !state ||
        event.touches.length !== 1 ||
        touch?.identifier !== state.id ||
        context.blocked()
      ) {
        cancel();
        return;
      }
      if (!state.vertical) {
        const x = Math.abs(touch.clientX - state.x);
        const y = Math.abs(touch.clientY - state.y);
        if (Math.max(x, y) < 8) return;
        if (x > y) {
          cancel();
          return;
        } // Horizontal panning remains a browser gesture.
        state.vertical = true;
      }
      event.preventDefault();
      const now = performance.now();
      const delta = state.previousY - touch.clientY;
      state.velocity = Math.max(-3, Math.min(3, delta / Math.max(16, now - state.previousTime)));
      state.previousY = touch.clientY;
      state.previousTime = now;
      if (!context.busy()) scroll(delta);
    },
    { passive: false },
  );
  surface.addEventListener(
    "touchend",
    () => {
      const state = drag;
      drag = null;
      if (!state?.vertical || context.blocked() || performance.now() - state.previousTime > 80)
        return;
      let velocity = state.velocity;
      const started = performance.now();
      let previous = started;
      const step = (now: number) => {
        animation = 0;
        if (context.blocked() || now - started > 1_200 || Math.abs(velocity) < 0.025) {
          remainder = 0;
          return;
        }
        const elapsed = Math.min(32, now - previous);
        previous = now;
        if (!context.busy() && !scroll(velocity * elapsed)) {
          remainder = 0;
          return;
        }
        velocity *= Math.exp(-elapsed / 180);
        animation = requestAnimationFrame(step);
      };
      animation = requestAnimationFrame(step);
    },
    { passive: true },
  );
  surface.addEventListener("touchcancel", cancel, { passive: true });
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel();
  });
}
