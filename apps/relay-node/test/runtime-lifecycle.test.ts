import { afterEach, expect, it, vi } from "vitest";
import { RelayRuntimeLifecycle } from "../src/runtime-lifecycle.js";

afterEach(() => vi.useRealTimers());

it("keeps recovered startup work unready until the listener starts", async () => {
  vi.useFakeTimers();
  const recovered = vi.fn();
  const lifecycle = new RelayRuntimeLifecycle({
    report: vi.fn(),
    probeStorage: vi.fn(),
    recoverComputer: async () => {},
    recovered,
  });
  try {
    lifecycle.storageFailed("computer");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovered).toHaveBeenCalledWith("computer");
    expect(lifecycle.ready).toBe(false);
    lifecycle.started();
    expect(lifecycle.ready).toBe(true);
    lifecycle.stop();
    lifecycle.started();
    expect(lifecycle.ready).toBe(false);
    expect(lifecycle.stopping).toBe(true);
  } finally {
    lifecycle.finish();
  }
});

it("requires a fresh recovery pass when another storage failure arrives during repair", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recoverComputer = vi
    .fn()
    .mockImplementationOnce(() => held)
    .mockResolvedValue(undefined);
  const recovered = vi.fn();
  const lifecycle = new RelayRuntimeLifecycle({
    report: vi.fn(),
    probeStorage: vi.fn(),
    recoverComputer,
    recovered,
  });
  try {
    lifecycle.started();
    lifecycle.storageFailed("first");
    await vi.advanceTimersByTimeAsync(1_000);
    lifecycle.storageFailed("second");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.ready).toBe(false);
    expect(recovered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recoverComputer.mock.calls).toEqual([["first"], ["first"], ["second"]]);
    expect(lifecycle.ready).toBe(true);
    expect(recovered.mock.calls).toEqual([["first"], ["second"]]);
  } finally {
    release();
    lifecycle.finish();
  }
});
