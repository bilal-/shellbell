import { afterEach, describe, expect, it, vi } from "vitest";
import {
  monitorNetwork,
  type NetworkReading,
  networkPathChanged,
  networkSnapshot,
  UNKNOWN_NETWORK,
} from "../src/net/network-monitor";

const wifi: NetworkReading = { type: "WIFI", isConnected: true, isInternetReachable: true };
const cellular: NetworkReading = { ...wifi, type: "CELLULAR" };
const none: NetworkReading = { type: "NONE", isConnected: false, isInternetReachable: false };

function fixture(initial = wifi) {
  let reading = initial;
  let active = true;
  let event = () => {};
  let activity = () => {};
  const publish = vi.fn();
  const offNetwork = vi.fn();
  const offActivity = vi.fn();
  const read = vi.fn(async () => reading);
  const stop = monitorNetwork(
    {
      read,
      active: () => active,
      subscribe: (listener) => {
        event = listener;
        return offNetwork;
      },
      subscribeActivity: (listener) => {
        activity = listener;
        return offActivity;
      },
    },
    publish,
  );
  return {
    read,
    publish,
    stop,
    offNetwork,
    offActivity,
    update(value: NetworkReading, emit = true) {
      reading = value;
      if (emit) event();
    },
    activity(value: boolean) {
      active = value;
      activity();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("phone connectivity", () => {
  it("distinguishes absent networks, unknown readings and an unvalidated local LAN", () => {
    expect(networkSnapshot({})).toEqual(UNKNOWN_NETWORK);
    expect(networkSnapshot(none)).toMatchObject({ internet: "offline", disconnected: true });
    expect(
      networkSnapshot({ type: "WIFI", isConnected: false, isInternetReachable: false }),
    ).toMatchObject({ internet: "offline", disconnected: false });
    expect(networkPathChanged(networkSnapshot(wifi), networkSnapshot(cellular))).toBe(true);
    expect(networkPathChanged(UNKNOWN_NETWORK, networkSnapshot(wifi))).toBe(false);
  });

  it("re-reads the current path when a deferred native disconnect event arrives", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalled());
    f.update(cellular);
    await vi.waitFor(() => expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(cellular)));
    f.update(cellular); // A stale event is only a refresh trigger, never an offline snapshot.
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(cellular));
    f.stop();
  });

  it("fences older asynchronous readings after a newer network event", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalled());
    let resolve!: (reading: NetworkReading) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.update(none);
    f.update(cellular);
    await vi.waitFor(() => expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(cellular)));
    const count = f.publish.mock.calls.length;
    resolve(none);
    await Promise.resolve();
    expect(f.publish).toHaveBeenCalledTimes(count);
    f.stop();
  });

  it("confirms a disconnect when the native callback initially returns the lost Wi-Fi network", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await Promise.resolve();
    f.update(wifi); // Native callback fired, but the query still describes the old path.
    await Promise.resolve();
    f.update(none, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(none));
    f.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from a missed restore callback while offline", async () => {
    vi.useFakeTimers();
    const f = fixture(none);
    await Promise.resolve();
    expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(none));
    f.update(wifi, false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(wifi));
    expect(vi.getTimerCount()).toBe(0);
    f.stop();
  });

  it("suspends rechecks in the background and refreshes on foreground", async () => {
    vi.useFakeTimers();
    const f = fixture(none);
    await Promise.resolve();
    f.activity(false);
    f.update(cellular);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.read).toHaveBeenCalledOnce();
    f.activity(true);
    await Promise.resolve();
    expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(cellular));
    f.stop();
  });

  it("a native read failure does not invent a no-internet state", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await Promise.resolve();
    f.read.mockRejectedValueOnce(new Error("Native state unavailable"));
    f.update(none);
    await Promise.resolve();
    expect(f.publish).toHaveBeenCalledOnce();
    f.update(wifi, false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.publish).toHaveBeenLastCalledWith(networkSnapshot(wifi));
    f.stop();
  });

  it("stopping removes listeners and discards pending reads and retry timers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await Promise.resolve();
    let resolve!: (reading: NetworkReading) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.update(none);
    f.stop();
    resolve(none);
    await Promise.resolve();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.offNetwork).toHaveBeenCalledOnce();
    expect(f.offActivity).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
