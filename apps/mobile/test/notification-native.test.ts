import { describe, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

import { createNativeNotifications } from "../src/notifications/native";

describe("native notification boundary", () => {
  it("serializes a pending install before revoke and recovers the queue after a failure", async () => {
    let finish!: () => void;
    const installed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const api = createNativeNotifications({
      installNotificationKey: async () => {
        order.push("install");
        await installed;
        order.push("committed");
      },
      removeNotificationComputer: async () => {
        order.push("remove");
        throw new Error("locked");
      },
      setHideNotificationDetails: async () => {
        order.push("hide");
      },
      getHideNotificationDetails: async () => true,
    } as never);
    const install = api.installNotificationKey("computer", "phone", "generation", "derived");
    const remove = api.removeNotificationComputer("computer").catch(() => undefined);
    const hide = api.setHideNotificationDetails(true);
    await vi.waitFor(() => expect(order).toContain("install"));
    expect(order).toEqual(["install"]);
    finish();
    await Promise.all([install, remove, hide]);
    expect(order).toEqual(["install", "committed", "remove", "hide"]);
    expect(await api.getHideNotificationDetails()).toBe(true);
  });
  it("does not interpret corrupt native privacy state as permission to show details", async () => {
    const api = createNativeNotifications({
      getHideNotificationDetails: async () => undefined,
    } as never);
    await expect(api.getHideNotificationDetails()).rejects.toThrow();
  });
  it("never advertises readiness on old builds or native failures", async () => {
    const absent = createNativeNotifications(null);
    expect(await absent.notificationReadiness()).toEqual({
      crypto: false,
      storage: false,
      receiver: false,
    });
    await expect(
      absent.installNotificationKey("computer", "phone", "generation", "key"),
    ).rejects.toThrow("unavailable");
    const broken = createNativeNotifications({
      notificationReadiness: vi.fn().mockRejectedValue(new Error("locked")),
    } as never);
    expect(await broken.notificationReadiness()).toEqual({
      crypto: false,
      storage: false,
      receiver: false,
    });
  });
  it("accepts only literal readiness booleans, never a partial or malformed native response", async () => {
    const readiness = vi.fn().mockResolvedValue({ crypto: true, storage: true, receiver: "true" });
    const api = createNativeNotifications({ notificationReadiness: readiness } as never);
    expect(await api.notificationReadiness()).toEqual({
      crypto: true,
      storage: true,
      receiver: false,
    });
    readiness.mockResolvedValue(null);
    expect(await api.notificationReadiness()).toEqual({
      crypto: false,
      storage: false,
      receiver: false,
    });
  });
  it("passes recipient binding and awaits durable native mutations", async () => {
    const native = {
      installNotificationKey: vi.fn().mockResolvedValue(undefined),
      removeNotificationComputer: vi.fn().mockResolvedValue(undefined),
      setHideNotificationDetails: vi.fn().mockResolvedValue(undefined),
      getHideNotificationDetails: vi.fn().mockResolvedValue(false),
      dismissNotificationSession: vi.fn().mockResolvedValue(undefined),
      notificationReadiness: vi
        .fn()
        .mockResolvedValue({ crypto: true, storage: true, receiver: false }),
    };
    const api = createNativeNotifications(native);
    await api.installNotificationKey("computer", "phone", "generation", "derived-key");
    expect(native.installNotificationKey).toHaveBeenCalledWith(
      "computer",
      "phone",
      "generation",
      "derived-key",
    );
    await api.removeNotificationComputer("computer");
    await api.setHideNotificationDetails(true);
    await api.dismissNotificationSession("computer", "session");
    expect(native.removeNotificationComputer).toHaveBeenCalledWith("computer");
    expect(native.setHideNotificationDetails).toHaveBeenCalledWith(true);
    expect(native.dismissNotificationSession).toHaveBeenCalledWith("computer", "session");
    native.installNotificationKey.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      api.installNotificationKey("computer", "phone", "generation", "derived-key"),
    ).rejects.toThrow("storage unavailable");
  });
});
