import { describe, expect, it } from "vitest";
import { type CtrlMessage, type CtrlMessageOf, parseCtrl } from "../src/ctrl.js";

const typedFcm: CtrlMessageOf<"push-token"> = {
  type: "push-token",
  token: "native",
  platform: "android",
  provider: "fcm",
  enabled: true,
};
const typedApns: CtrlMessageOf<"push-token"> = {
  type: "push-token",
  token: "native",
  platform: "ios",
  provider: "apns",
  environment: "development",
  enabled: true,
};
const mismatchedFcm: CtrlMessageOf<"push-token"> = {
  type: "push-token",
  token: "native",
  platform: "ios",
  // @ts-expect-error FCM is only valid with Android.
  provider: "fcm",
  enabled: true,
};
// @ts-expect-error APNs requires an explicit environment.
const missingApnsEnvironment: CtrlMessageOf<"push-token"> = {
  type: "push-token",
  token: "native",
  platform: "ios",
  provider: "apns",
  enabled: true,
};
void [typedFcm, typedApns, mismatchedFcm, missingApnsEnvironment];

function assertParsedPushTokenType(message: CtrlMessage): void {
  if (message.type === "push-token") {
    const correlated: CtrlMessageOf<"push-token"> = message;
    void correlated;
  }
}
void assertParsedPushTokenType;

describe("push-token protocol variants", () => {
  it("accepts native Android FCM registrations", () => {
    expect(
      parseCtrl({
        type: "push-token",
        token: "native",
        platform: "android",
        provider: "fcm",
        enabled: true,
      }),
    ).toMatchObject({ provider: "fcm", platform: "android" });
  });

  it.each(["development", "production"] as const)(
    "accepts native iOS APNs registrations in %s environment",
    (environment) => {
      expect(
        parseCtrl({
          type: "push-token",
          token: "native",
          platform: "ios",
          provider: "apns",
          environment,
          enabled: true,
        }),
      ).toMatchObject({ provider: "apns", platform: "ios", environment });
    },
  );

  it("rejects mismatched provider and platform", () => {
    expect(() =>
      parseCtrl({
        type: "push-token",
        token: "native",
        platform: "ios",
        provider: "fcm",
        enabled: true,
      }),
    ).toThrow();
  });

  it("requires an environment for APNs", () => {
    expect(() =>
      parseCtrl({
        type: "push-token",
        token: "native",
        platform: "ios",
        provider: "apns",
        enabled: true,
      }),
    ).toThrow();
  });

  it("keeps legacy provider-less Expo registrations parseable", () => {
    expect(
      parseCtrl({
        type: "push-token",
        token: "ExponentPushToken[old]",
        platform: "android",
        enabled: true,
      }),
    ).not.toHaveProperty("provider");
  });

  it("allows native tokens up to 4,096 ASCII bytes", () => {
    const base = {
      type: "push-token",
      platform: "android",
      provider: "fcm",
      enabled: true,
    };
    expect(parseCtrl({ ...base, token: "x".repeat(4096) })).toHaveProperty("token");
    expect(() => parseCtrl({ ...base, token: "x".repeat(4097) })).toThrow();
  });

  it("rejects non-ASCII native tokens", () => {
    expect(() =>
      parseCtrl({
        type: "push-token",
        token: "tokén",
        platform: "android",
        provider: "fcm",
        enabled: true,
      }),
    ).toThrow();
  });

  it("retains the legacy 256-character token bound", () => {
    const base = {
      type: "push-token",
      platform: "ios",
      enabled: true,
    };
    expect(() => parseCtrl({ ...base, token: "x".repeat(257) })).toThrow();
  });
});
