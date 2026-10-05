import type { CtrlMessageLoose } from "@shellbell/protocol";
import { expectTypeOf, it } from "vitest";
import type { PushTokenInfo } from "../src/net/connection";

type Registration = { token: string; enabled: boolean };

// These assertions run under tsconfig.test.json; Vitest alone does not check types.
it("accepts native and legacy registrations that can be sent as control messages", () => {
  expectTypeOf<
    Registration & { platform: "android"; provider: "fcm" }
  >().toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<
    Registration & { platform: "ios"; provider: "apns"; environment: "development" }
  >().toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<
    Registration & { platform: "ios"; provider: "apns"; environment: "production" }
  >().toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<Registration & { platform: "android" }>().toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<Registration & { platform: "ios" }>().toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<PushTokenInfo & { type: "push-token" }>().toMatchTypeOf<CtrlMessageLoose>();
});

it("rejects mismatched native destinations and missing or misplaced APNs environments", () => {
  expectTypeOf<
    Registration & { platform: "ios"; provider: "fcm" }
  >().not.toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<
    Registration & { platform: "android"; provider: "apns"; environment: "production" }
  >().not.toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<
    Registration & { platform: "ios"; provider: "apns" }
  >().not.toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<
    Registration & { platform: "android"; provider: "fcm"; environment: "development" }
  >().not.toMatchTypeOf<PushTokenInfo>();
  expectTypeOf<
    Registration & { platform: "ios"; environment: "production" }
  >().not.toMatchTypeOf<PushTokenInfo>();
});
