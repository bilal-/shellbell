import { deriveNotificationKey, NOTIFICATION_FEATURE, toBase64Url } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { NotificationEnrollment } from "../src/notifications/enrollment";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let current = true;
  const native = {
    notificationReadiness: vi
      .fn()
      .mockResolvedValue({ crypto: true, storage: true, receiver: true }),
    installNotificationKey: vi.fn().mockResolvedValue(undefined),
  };
  const options = {
    computerFp: "a".repeat(26),
    phoneFp: "b".repeat(26),
    kPair: new Uint8Array(32).fill(7),
    native,
  };
  const enrollment = new NotificationEnrollment(options);
  const link = { current: () => current, send: vi.fn().mockReturnValue(true) };
  return {
    enrollment,
    link,
    native,
    options,
    retire: () => {
      current = false;
    },
  };
}

describe("private notification enrollment", () => {
  it("installs only a derived recipient-bound key before sending and waits for the matching ACK", async () => {
    const f = fixture();
    const committed = deferred<void>();
    f.native.installNotificationKey.mockReturnValueOnce(committed.promise);
    const pending = f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    await vi.waitFor(() => expect(f.native.installNotificationKey).toHaveBeenCalledOnce());
    expect(f.link.send).not.toHaveBeenCalled();
    expect(f.enrollment.ready).toBe(false);
    committed.resolve();
    await pending;
    const request = f.link.send.mock.calls[0]![0];
    expect(request.type).toBe("notification.enroll");
    expect(f.native.installNotificationKey).toHaveBeenCalledWith(
      f.options.computerFp,
      f.options.phoneFp,
      request.generation,
      toBase64Url(
        deriveNotificationKey(f.options.kPair, { ...f.options, generation: request.generation }),
      ),
    );
    expect(f.enrollment.acknowledge("AAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(f.enrollment.ready).toBe(false);
    expect(f.enrollment.acknowledge(request.generation)).toBe(true);
    expect(f.enrollment.ready).toBe(true);
    f.enrollment.cancel();
  });
  it("does not enroll old agents, unavailable receivers, or failed native writes", async () => {
    const f = fixture();
    await f.enrollment.begin(f.link, []);
    expect(f.native.notificationReadiness).not.toHaveBeenCalled();
    f.native.notificationReadiness.mockResolvedValueOnce({
      crypto: true,
      storage: true,
      receiver: false,
    });
    await f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    expect(f.native.installNotificationKey).not.toHaveBeenCalled();
    f.native.installNotificationKey.mockRejectedValueOnce(new Error("native unavailable"));
    await f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    expect(f.link.send).not.toHaveBeenCalled();
    expect(f.enrollment.ready).toBe(false);
  });
  it("rejects a late ACK and uses a fresh generation after reconnect", async () => {
    const f = fixture();
    await f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    const old = f.link.send.mock.calls[0]![0].generation;
    f.enrollment.cancel();
    expect(f.enrollment.acknowledge(old)).toBe(false);
    await f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    const next = f.link.send.mock.calls[1]![0].generation;
    expect(next).not.toBe(old);
    expect(f.enrollment.acknowledge(old)).toBe(false);
    expect(f.enrollment.acknowledge(next)).toBe(true);
    f.retire();
    expect(f.enrollment.ready).toBe(false);
    f.enrollment.cancel();
  });
  it("does not install after a retired readiness check or send after a retired install", async () => {
    const f = fixture();
    const readiness = deferred<{ crypto: boolean; receiver: boolean; storage: boolean }>();
    f.native.notificationReadiness.mockReturnValueOnce(readiness.promise);
    const pending = f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    f.enrollment.cancel();
    readiness.resolve({ crypto: true, receiver: true, storage: true });
    await pending;
    expect(f.native.installNotificationKey).not.toHaveBeenCalled();
    const installed = deferred<void>();
    f.native.installNotificationKey.mockReturnValueOnce(installed.promise);
    const next = f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
    await vi.waitFor(() => expect(f.native.installNotificationKey).toHaveBeenCalledOnce());
    f.enrollment.cancel();
    installed.resolve();
    await next;
    expect(f.link.send).not.toHaveBeenCalled();
    expect(f.enrollment.ready).toBe(false);
  });
  it("times out an unacknowledged generation and never revives it", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.enrollment.begin(f.link, [NOTIFICATION_FEATURE]);
      const generation = f.link.send.mock.calls[0]![0].generation;
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.enrollment.acknowledge(generation)).toBe(false);
      expect(f.enrollment.ready).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
