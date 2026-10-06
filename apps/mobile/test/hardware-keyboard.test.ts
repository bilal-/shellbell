import { describe, expect, it, vi } from "vitest";
import { HardwareKeyboardMonitor } from "../src/input/hardware-keyboard";

describe("hardware keyboard attachment", () => {
  it("reports connection and detachment without relying on software keyboard height", async () => {
    let notify: (event: { attached: boolean }) => void = () => {};
    const remove = vi.fn();
    const monitor = new HardwareKeyboardMonitor({
      isKeyboardAttached: async () => false,
      addListener: (_, listener) => {
        notify = listener;
        return { remove };
      },
    });
    const changed = vi.fn();
    const unsubscribe = monitor.subscribe(changed);
    await Promise.resolve();
    expect(monitor.getSnapshot()).toBe(false);
    notify({ attached: true });
    expect(monitor.getSnapshot()).toBe(true);
    notify({ attached: false });
    expect(monitor.getSnapshot()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(remove).toHaveBeenCalledOnce();
  });
  it("does not overwrite a newer event with a slow initial query", async () => {
    let resolve: (value: boolean) => void = () => {};
    let notify: (event: { attached: boolean }) => void = () => {};
    const monitor = new HardwareKeyboardMonitor({
      isKeyboardAttached: () =>
        new Promise((done) => {
          resolve = done;
        }),
      addListener: (_, listener) => {
        notify = listener;
        return { remove() {} };
      },
    });
    monitor.subscribe(() => {});
    notify({ attached: true });
    resolve(false);
    await Promise.resolve();
    expect(monitor.getSnapshot()).toBe(true);
  });
  it("shares one native subscription and ignores results after teardown", async () => {
    let resolve: (value: boolean) => void = () => {};
    const addListener = vi.fn(() => ({ remove: vi.fn() }));
    const monitor = new HardwareKeyboardMonitor({
      isKeyboardAttached: () =>
        new Promise((done) => {
          resolve = done;
        }),
      addListener,
    });
    const a = monitor.subscribe(() => {});
    const b = monitor.subscribe(() => {});
    expect(addListener).toHaveBeenCalledOnce();
    a();
    b();
    resolve(true);
    await Promise.resolve();
    expect(monitor.getSnapshot()).toBe(false);
  });
});
