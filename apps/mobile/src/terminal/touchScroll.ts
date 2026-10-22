import type { Terminal } from "@xterm/xterm";

type Sample = { y: number; time: number };
const VELOCITY_WINDOW_MS = 100;
const MOMENTUM_DECAY_MS = 360;

function releaseVelocity(samples: Sample[], now: number) {
  const last = samples.at(-1)!;
  if (now - last.time > VELOCITY_WINDOW_MS) return 0;
  const cutoff = now - VELOCITY_WINDOW_MS;
  const index = samples.findIndex((sample) => sample.time >= cutoff);
  const first = samples[Math.max(0, index - 1)]!;
  const next = samples[Math.max(0, index)]!;
  // Estimate motion over the recent window instead of trusting the final event.
  // A stationary lift-off event still retains the preceding swipe's velocity.
  const start = Math.max(first.time, cutoff);
  const y =
    first.time < start && next.time > first.time
      ? first.y + ((next.y - first.y) * (start - first.time)) / (next.time - first.time)
      : first.y;
  return Math.max(-8, Math.min(8, (y - last.y) / Math.max(16, now - start)));
}

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
    interrupted: () => void;
  },
) {
  const lifetime = new AbortController();
  let drag: {
    id: number;
    x: number;
    y: number;
    previousY: number;
    vertical: boolean;
    direction: number;
    samples: Sample[];
  } | null = null;
  let remainder = 0;
  let animation = 0;
  let pending = 0;
  let momentum: { velocity: number; elapsed: number } | null = null;
  let previousFrame = 0;
  let busySince: number | null = null;
  let suppressClick = false;
  const cancel = () => {
    cancelAnimationFrame(animation);
    animation = 0;
    drag = null;
    remainder = 0;
    pending = 0;
    momentum = null;
    busySince = null;
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
  const schedule = () => {
    if (!animation) {
      previousFrame = performance.now();
      animation = requestAnimationFrame(step);
    }
  };
  const step = (now: number) => {
    animation = 0;
    if (context.blocked()) return cancel();
    const elapsed = Math.min(64, Math.max(0, now - previousFrame));
    previousFrame = now;
    if (context.busy()) {
      busySince ??= now;
      // Preserve motion across a short repaint, but never replay a stale gesture
      // after a stalled renderer recovers.
      if (now - busySince > 1_000) {
        pending = 0;
        momentum = null;
        remainder = 0;
        busySince = null;
        if (drag) {
          drag.samples = [{ y: drag.previousY, time: now }];
          drag.direction = 0;
        }
        return;
      }
    } else {
      busySince = null;
      if (pending) {
        const delta = pending;
        pending = 0;
        if (!scroll(delta)) momentum = null;
      }
      if (momentum) {
        const decay = Math.exp(-elapsed / MOMENTUM_DECAY_MS);
        const distance = momentum.velocity * MOMENTUM_DECAY_MS * (1 - decay);
        momentum.velocity *= decay;
        momentum.elapsed += elapsed;
        if (!scroll(distance) || Math.abs(momentum.velocity) < 0.025 || momentum.elapsed >= 2_000)
          momentum = null;
      }
    }
    if (pending || momentum) animation = requestAnimationFrame(step);
  };
  // Zooming can leave space outside the grid. The entire viewport accepts a swipe;
  // the surface still supplies the actual cell geometry for scrolling.
  container.addEventListener(
    "touchstart",
    (event) => {
      const interrupted = Boolean(momentum || pending);
      cancel();
      suppressClick = interrupted;
      if (
        context.blocked() ||
        event.touches.length !== 1 ||
        (event.target instanceof Element && event.target.closest(".scrollbar, .selection-handle"))
      )
        return;
      if (interrupted) {
        // A tap that arrests a fling is not a link activation or a terminal click.
        context.interrupted();
      }
      const touch = event.touches[0]!;
      drag = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        previousY: touch.clientY,
        vertical: false,
        direction: 0,
        samples: [{ y: touch.clientY, time: performance.now() }],
      };
      context.arm();
    },
    { passive: true, signal: lifetime.signal },
  );
  container.addEventListener(
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
      const previous = state.samples.at(-1)!;
      // A deliberate reversal starts a new flick; tiny lift-off jitter does not.
      if (Math.abs(delta) > 2) {
        const direction = Math.sign(delta);
        if (state.direction && direction !== state.direction) state.samples = [previous];
        state.direction = direction;
      }
      state.samples.push({ y: touch.clientY, time: now });
      while (
        state.samples.length > 2 &&
        (state.samples[1]!.time < now - VELOCITY_WINDOW_MS || state.samples.length > 32)
      )
        state.samples.shift();
      state.previousY = touch.clientY;
      // Bounded, transient movement only; xterm remains the owner of history.
      const limit = Math.max(1, container.clientHeight) * 2;
      pending = Math.max(-limit, Math.min(limit, pending + delta));
      if (!context.busy()) {
        busySince = null;
        scroll(pending);
        pending = 0;
      } else schedule();
    },
    { passive: false, signal: lifetime.signal },
  );
  container.addEventListener(
    "touchend",
    () => {
      const state = drag;
      drag = null;
      if (!state?.vertical || context.blocked()) return cancel();
      const velocity = releaseVelocity(state.samples, performance.now());
      if (Math.abs(velocity) >= 0.15) momentum = { velocity, elapsed: 0 };
      if (pending || momentum) schedule();
    },
    { passive: true, signal: lifetime.signal },
  );
  container.addEventListener("touchcancel", cancel, { passive: true, signal: lifetime.signal });
  container.addEventListener("wheel", cancel, { passive: true, signal: lifetime.signal });
  container.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal: lifetime.signal },
  );
  container.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch") {
        suppressClick = false;
        cancel();
      }
    },
    { signal: lifetime.signal },
  );
  window.addEventListener("blur", cancel, { signal: lifetime.signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) cancel();
    },
    { signal: lifetime.signal },
  );
  return {
    cancel,
    dispose: () => {
      cancel();
      lifetime.abort();
    },
  };
}
