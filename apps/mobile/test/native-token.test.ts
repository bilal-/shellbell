import { describe, expect, it, vi } from "vitest";
import {
  getNativePushToken,
  installNativePushTokenListener,
  type NativeTokenApi,
} from "../src/notifications/native-token";

function api(overrides: Partial<NativeTokenApi> = {}): NativeTokenApi {
  return {
    platform: "android",
    getPermissions: async () => ({ granted: true }),
    getDevicePushToken: async () => "native-token",
    getIosEnvironment: async () => "production",
    onToken: () => () => {},
    ...overrides,
  };
}

describe("native push destinations", () => {
  it("registers rotated App Store tokens without an embedded provisioning profile", async () => {
    let listener: (token: string) => void = () => {};
    const destinations: unknown[] = [];
    const off = installNativePushTokenListener(
      (token) => destinations.push(token),
      api({
        platform: "ios",
        getIosEnvironment: async () => null,
        isIosAppStoreBuild: async () => true,
        onToken: (cb) => {
          listener = cb;
          return () => {};
        },
      }),
    );
    listener("rotated-store-token");
    await expect
      .poll(() => destinations)
      .toEqual([
        {
          token: "rotated-store-token",
          platform: "ios",
          provider: "apns",
          environment: "production",
        },
      ]);
    off();
  });

  it("does not guess an APNs environment when native release classification fails", async () => {
    expect(
      await getNativePushToken(
        api({
          platform: "ios",
          getIosEnvironment: async () => null,
          isIosAppStoreBuild: async () => {
            throw new Error("native classification unavailable");
          },
        }),
      ),
    ).toBeNull();
  });

  it("registers Android FCM without an Expo project", async () => {
    expect(await getNativePushToken(api())).toEqual({
      token: "native-token",
      platform: "android",
      provider: "fcm",
    });
  });
  for (const environment of ["development", "production"] as const) {
    it(`uses the signed iOS ${environment} entitlement`, async () => {
      expect(
        await getNativePushToken(
          api({ platform: "ios", getIosEnvironment: async () => environment }),
        ),
      ).toEqual({ token: "native-token", platform: "ios", provider: "apns", environment });
    });
  }
  it("returns null when permission is denied", async () => {
    expect(
      await getNativePushToken(api({ getPermissions: async () => ({ granted: false }) })),
    ).toBeNull();
  });

  it("registers production APNs for App Store builds whose embedded profile was removed", async () => {
    expect(
      await getNativePushToken(
        api({
          platform: "ios",
          getIosEnvironment: async () => null,
          isIosAppStoreBuild: async () => true,
        }),
      ),
    ).toEqual({
      token: "native-token",
      platform: "ios",
      provider: "apns",
      environment: "production",
    });
  });

  it("retains the signed development environment without consulting the Store fallback", async () => {
    const classification = vi.fn(async () => true);
    expect(
      await getNativePushToken(
        api({
          platform: "ios",
          getIosEnvironment: async () => "development",
          isIosAppStoreBuild: classification,
        }),
      ),
    ).toMatchObject({ environment: "development" });
    expect(classification).not.toHaveBeenCalled();
  });

  it("does not infer production for simulator or unknown release types", async () => {
    expect(
      await getNativePushToken(
        api({
          platform: "ios",
          getIosEnvironment: async () => null,
          isIosAppStoreBuild: async () => false,
        }),
      ),
    ).toBeNull();
  });
  it("keeps token acquisition failure best effort", async () => {
    expect(
      await getNativePushToken(
        api({
          getDevicePushToken: async () => {
            throw new Error("offline");
          },
        }),
      ),
    ).toBeNull();
  });
  it("leaves an unknown iOS environment unregistered without App Store classification", async () => {
    expect(
      await getNativePushToken(api({ platform: "ios", getIosEnvironment: async () => null })),
    ).toBeNull();
  });
  it("replaces the registered destination on token changes and removes its listener", async () => {
    let listener: (token: string) => void = () => {};
    let removed = false;
    const destinations: unknown[] = [];
    const off = installNativePushTokenListener(
      (destination) => destinations.push(destination),
      api({
        onToken: (cb) => {
          listener = cb;
          return () => {
            removed = true;
          };
        },
      }),
    );
    listener("replacement-token");
    await expect
      .poll(() => destinations)
      .toEqual([{ token: "replacement-token", platform: "android", provider: "fcm" }]);
    off();
    expect(removed).toBe(true);
    listener("after-teardown");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(destinations).toHaveLength(1);
  });
  it("suppresses a token resolution that completes after listener teardown", async () => {
    let listener: (token: string) => void = () => {};
    let resolvePermission!: (permission: { granted: boolean }) => void;
    const permission = new Promise<{ granted: boolean }>((resolve) => {
      resolvePermission = resolve;
    });
    const destinations: unknown[] = [];
    const off = installNativePushTokenListener(
      (token) => destinations.push(token),
      api({
        getPermissions: () => permission,
        onToken: (cb) => {
          listener = cb;
          return () => {};
        },
      }),
    );
    listener("pending-token");
    off();
    resolvePermission({ granted: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(destinations).toEqual([]);
  });
});
