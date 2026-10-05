import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { herdrScreen } from "../src/backends/herdr/convert.js";
import {
  HerdrScreenObserver,
  type ObservedScreenTarget,
} from "../src/backends/herdr/screen-observer.js";
import type { Screen } from "../src/backends/types.js";

const screen = (text: string) => herdrScreen({ text, rows: 1, cols: 20, scrollMax: 0 });
let observer: HerdrScreenObserver;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  observer?.stop();
  vi.useRealTimers();
});

describe("Herdr content observation", () => {
  it("preserves the screen baseline across a healthy subscription handover", async () => {
    let text = "before handover";
    const changed = vi.fn();
    observer = new HerdrScreenObserver({
      targets: () => [
        {
          id: "pane",
          identity: "same-native-pane",
          current: () => true,
          read: async () => screen(text),
        },
      ],
      changed,
      failed: vi.fn(),
    });
    observer.setWatched(["pane"]);
    observer.start();
    await vi.advanceTimersByTimeAsync(125);
    text = "after handover";
    observer.start();
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).toHaveBeenCalledExactlyOnceWith("pane");
    observer.stop();
    text = "after connection loss";
    observer.start();
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("detects output and style changes while revisions are unavailable, with unchanged screens silent", async () => {
    let text = "first";
    const read = vi.fn(async () => screen(text));
    const changed = vi.fn();
    observer = new HerdrScreenObserver({
      targets: () => [{ id: "pane", identity: "same-native-pane", current: () => true, read }],
      changed,
      failed: vi.fn(),
    });
    observer.setWatched(["pane"]);
    observer.start();
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).not.toHaveBeenCalled();
    text = "second";
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).toHaveBeenCalledExactlyOnceWith("pane");
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).toHaveBeenCalledOnce();
    text = "\x1b[31msecond\x1b[0m";
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("keeps background observation for notifications and increases cadence for a watched pane", async () => {
    const read = vi.fn(async () => screen("content"));
    observer = new HerdrScreenObserver({
      targets: () => [{ id: "pane", identity: "same-native-pane", current: () => true, read }],
      changed: vi.fn(),
      failed: vi.fn(),
    });
    observer.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledOnce();
    observer.setWatched(["pane"]);
    await vi.advanceTimersByTimeAsync(125);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("bounds in-flight reads across reconnects and ignores results from the stopped observation", async () => {
    const gates: Array<(value: Screen) => void> = [];
    const read = vi.fn(() => new Promise<Screen>((resolve) => gates.push(resolve)));
    const changed = vi.fn();
    const targets: ObservedScreenTarget[] = Array.from({ length: 30 }, (_, id) => ({
      id: String(id),
      identity: `native-${id}`,
      current: () => true,
      read,
    }));
    observer = new HerdrScreenObserver({ targets: () => targets, changed, failed: vi.fn() });
    observer.start();
    await vi.advanceTimersByTimeAsync(125);
    expect(read).toHaveBeenCalledTimes(4);
    observer.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(4);
    for (const resolve of gates.splice(0)) resolve(screen("obsolete content"));
    await vi.advanceTimersByTimeAsync(125);
    expect(read).toHaveBeenCalledTimes(8);
    expect(changed).not.toHaveBeenCalled();
    observer.stop();
    for (const resolve of gates.splice(0)) resolve(screen("after close"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(8);
    expect(changed).not.toHaveBeenCalled();
  });

  it("discards an obsolete native pane result and establishes a new baseline for its replacement", async () => {
    let resolve!: (value: Screen) => void;
    let current = true;
    let text = "replacement";
    let target: ObservedScreenTarget = {
      id: "pane",
      identity: "old-native",
      current: () => current,
      read: () =>
        new Promise<Screen>((done) => {
          resolve = done;
        }),
    };
    const changed = vi.fn();
    observer = new HerdrScreenObserver({ targets: () => [target], changed, failed: vi.fn() });
    observer.setWatched(["pane"]);
    observer.start();
    await vi.advanceTimersByTimeAsync(125);
    current = false;
    target = {
      id: "pane",
      identity: "new-native",
      current: () => true,
      read: async () => screen(text),
    };
    resolve(screen("obsolete"));
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).not.toHaveBeenCalled();
    text = "fresh output";
    await vi.advanceTimersByTimeAsync(125);
    expect(changed).toHaveBeenCalledExactlyOnceWith("pane");
  });
});
