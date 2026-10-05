import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNodeScheduler } from "../src/scheduler.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
it("retries a failed fired-deadline write without spinning on an overdue timer", async () => {
  let failures = 0;
  const scheduler = createNodeScheduler({
    read: () => 2000,
    write: () => {
      failures++;
      throw new Error("disk");
    },
    now: () => Date.now(),
    wakeup: async () => {
      throw new Error("must not run before persistence");
    },
    report: () => {},
  });
  await scheduler.replace(1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(failures).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(failures).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(failures).toBe(2);
  scheduler.stop();
});
afterEach(() => vi.useRealTimers());
it.each([null, 20_000])(
  "does not replace a newer %s decision after a failed wakeup",
  async (next) => {
    let stored: number | null = null;
    let reject!: (error: Error) => void;
    let wakes = 0;
    const scheduler = createNodeScheduler({
      read: () => stored,
      write: (value) => {
        stored = value;
      },
      now: () => Date.now(),
      report: () => {},
      wakeup: () => {
        wakes++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    });
    await scheduler.replace(2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored).toBeNull();
    await scheduler.replace(next);
    reject(new Error("maintenance"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored).toBe(next);
    expect(wakes).toBe(1);
    scheduler.stop();
  },
);
function fixture() {
  let stored: number | null = null;
  const wakes: number[] = [];
  const errors: unknown[] = [];
  const scheduler = createNodeScheduler({
    read: () => stored,
    write: (value) => {
      stored = value;
    },
    now: () => Date.now(),
    wakeup: async () => {
      wakes.push(Date.now());
    },
    report: (error) => errors.push(error),
  });
  return {
    scheduler,
    wakes,
    errors,
    get stored() {
      return stored;
    },
  };
}
it("floors raw deadlines, preserves only a still-useful imminent alarm, and cancels", async () => {
  const f = fixture();
  await f.scheduler.replace(500);
  expect(f.stored).toBe(2000);
  vi.setSystemTime(1500);
  await f.scheduler.replace(600);
  expect(f.stored).toBe(2000);
  await f.scheduler.replace(3000);
  expect(f.stored).toBe(3000);
  await f.scheduler.replace(2600);
  expect(f.stored).toBe(2600);
  await f.scheduler.replace(null);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.wakes).toEqual([]);
  expect(f.stored).toBeNull();
});
it("serializes local deadline maintenance and contains its rejection", async () => {
  let wakeCount = 0;
  let release!: () => void;
  let stored: number | null = null;
  const errors: unknown[] = [];
  const scheduler = createNodeScheduler({
    read: () => stored,
    write: (v) => {
      stored = v;
    },
    now: () => Date.now(),
    report: (e) => errors.push(e),
    wakeup: async () => {
      wakeCount++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("held failure");
    },
  });
  await scheduler.replace(2000);
  await vi.advanceTimersByTimeAsync(1000);
  await scheduler.replace(2100);
  await vi.advanceTimersByTimeAsync(1000);
  expect(wakeCount).toBe(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toHaveLength(1);
  scheduler.stop();
});
it("bounds long delays without firing early and stops timers without losing durable work", async () => {
  const f = fixture();
  await f.scheduler.replace(3_000_001_000);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(f.wakes).toEqual([]);
  f.scheduler.stop();
  await vi.advanceTimersByTimeAsync(3_000_001_000);
  expect(f.wakes).toEqual([]);
  expect(f.stored).toBe(3_000_001_000);
});
it("a failed persistence update does not poison subsequent updates", async () => {
  let stored: number | null = null;
  let fail = true;
  const scheduler = createNodeScheduler({
    read: () => stored,
    write: (value) => {
      if (fail) throw new Error("disk");
      stored = value;
    },
    now: () => Date.now(),
    wakeup: async () => {},
    report: () => {},
  });
  await expect(scheduler.replace(2000)).rejects.toThrow("disk");
  fail = false;
  await scheduler.replace(3000);
  expect(stored).toBe(3000);
  scheduler.stop();
});
