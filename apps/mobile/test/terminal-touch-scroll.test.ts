import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTouchScroll } from "../src/terminal/touchScroll";

class Surface extends EventTarget {
  scrollTop = 0;
  scrollHeight = 640;
  clientHeight = 640;
  closest() {
    return null;
  }
  querySelector() {
    return { getBoundingClientRect: () => ({ height: 480 }) };
  }
}

function fixture() {
  let now = 0;
  let id = 0;
  let busy = false;
  let blocked = false;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const container = new Surface();
  const active = { viewportY: 500, baseY: 1000 };
  const terminal = {
    rows: 24,
    buffer: { active },
    scrollLines: (lines: number) => {
      active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + lines));
    },
  } as unknown as Terminal;
  const scrolled = vi.fn();
  const interrupted = vi.fn();
  const binding = bindTouchScroll(
    terminal,
    container as unknown as HTMLElement,
    container as unknown as HTMLElement,
    {
      blocked: () => blocked,
      busy: () => busy,
      arm: vi.fn(),
      scrolled,
      interrupted,
    },
  );
  const tick = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 16);
      const callbacks = [...frames.values()];
      frames.clear();
      for (const fn of callbacks) fn(now);
    }
  };
  const touch = (type: string, y = 100, x = 100) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "touches", {
      value: type === "touchend" ? [] : [{ identifier: 1, clientX: x, clientY: y }],
    });
    container.dispatchEvent(event);
    return event;
  };
  const flick = () => {
    touch("touchstart");
    for (const y of [150, 200, 250, 300]) {
      tick(16);
      touch("touchmove", y);
    }
    // Android can report a stationary move just before finger-up.
    tick(16);
    touch("touchmove", 300);
    touch("touchend");
  };
  return {
    active,
    tick,
    touch,
    flick,
    binding,
    scrolled,
    interrupted,
    frames,
    container,
    busy: (value: boolean) => {
      busy = value;
    },
    blocked: (value: boolean) => {
      blocked = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("phone terminal flicks", () => {
  it("continues several screens after release despite a stationary final event", () => {
    const f = fixture();
    f.flick();
    const released = f.active.viewportY;
    f.tick(700);
    expect(released - f.active.viewportY).toBeGreaterThan(30);
    f.tick(1500);
    expect(f.frames.size).toBe(0);
    f.binding.dispose();
  });

  it("keeps movement through a brief repaint, including release during it", () => {
    const f = fixture();
    f.busy(true);
    f.flick();
    expect(f.active.viewportY).toBe(500);
    f.tick(100);
    f.busy(false);
    f.tick(700);
    expect(f.active.viewportY).toBeLessThan(460);
    f.binding.dispose();
  });

  it("discards queued movement after a stalled renderer", () => {
    const f = fixture();
    f.busy(true);
    f.flick();
    f.tick(1200);
    f.busy(false);
    f.tick(700);
    expect(f.active.viewportY).toBe(500);
    expect(f.frames.size).toBe(0);
    f.binding.dispose();
  });

  it("keeps a held finger usable after discarding stale queued movement", () => {
    const f = fixture();
    f.busy(true);
    f.touch("touchstart");
    f.tick(16);
    f.touch("touchmove", 200);
    f.tick(1200);
    f.busy(false);
    f.touch("touchmove", 260);
    expect(f.active.viewportY).toBe(497);
    f.binding.dispose();
  });

  it("consumes the tap that stops a fling, then lets ordinary taps through", () => {
    const f = fixture();
    f.flick();
    f.tick(100);
    expect(f.touch("touchstart").defaultPrevented).toBe(false);
    expect(f.interrupted).toHaveBeenCalledOnce();
    f.touch("touchend");
    const click = new Event("click", { cancelable: true });
    f.container.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(f.touch("touchstart").defaultPrevented).toBe(false);
    f.touch("touchend");
    const nextClick = new Event("click", { cancelable: true });
    f.container.dispatchEvent(nextClick);
    expect(nextClick.defaultPrevented).toBe(false);
    f.binding.dispose();
  });

  it.each(["touch", "selection", "navigation", "wheel"])("stops immediately for %s", (action) => {
    const f = fixture();
    f.flick();
    f.tick(150);
    const before = f.active.viewportY;
    if (action === "touch") f.touch("touchstart");
    if (action === "selection") f.blocked(true);
    if (action === "navigation") f.binding.cancel();
    if (action === "wheel") f.container.dispatchEvent(new Event("wheel"));
    f.tick(800);
    expect(f.active.viewportY).toBe(before);
    expect(f.frames.size).toBe(0);
    f.binding.dispose();
  });

  it("does not fling after a deliberate hold or hijack a horizontal pan", () => {
    const f = fixture();
    f.touch("touchstart");
    f.tick(16);
    f.touch("touchmove", 300);
    f.tick(150);
    f.touch("touchend");
    const before = f.active.viewportY;
    f.tick(800);
    expect(f.active.viewportY).toBe(before);
    f.touch("touchstart");
    f.tick(16);
    f.touch("touchmove", 110, 250);
    f.touch("touchend");
    f.tick(800);
    expect(f.active.viewportY).toBe(before);
    f.binding.dispose();
  });

  it("stops at loaded history without accumulating overscroll into a later page", () => {
    const f = fixture();
    f.active.viewportY = 12;
    f.flick();
    f.tick(700);
    expect(f.active.viewportY).toBe(0);
    expect(f.frames.size).toBe(0);
    f.active.viewportY = 200;
    f.tick(700);
    expect(f.active.viewportY).toBe(200);
    f.binding.dispose();
  });

  it("follows the final deliberate reversal even after a stationary event", () => {
    const f = fixture();
    f.touch("touchstart");
    for (const y of [150, 200, 200, 160]) {
      f.tick(16);
      f.touch("touchmove", y);
    }
    f.touch("touchend");
    const released = f.active.viewportY;
    f.tick(700);
    expect(f.active.viewportY - released).toBeGreaterThan(30);
    f.binding.dispose();
  });

  it("glides through a tall live grid before history and back to the live bottom", () => {
    const f = fixture();
    f.container.clientHeight = 200;
    f.container.scrollHeight = 480;
    f.container.scrollTop = 280;
    f.active.viewportY = 1000;
    f.flick();
    f.tick(700);
    expect(f.container.scrollTop).toBe(0);
    expect(f.active.viewportY).toBeLessThan(980);
    f.touch("touchstart", 500);
    for (const y of [400, 300, 200, 100]) {
      f.tick(16);
      f.touch("touchmove", y);
    }
    f.touch("touchend");
    f.tick(2100);
    expect(f.active.viewportY).toBe(1000);
    expect(f.container.scrollTop).toBe(280);
    expect(f.frames.size).toBe(0);
    f.binding.dispose();
  });
});
