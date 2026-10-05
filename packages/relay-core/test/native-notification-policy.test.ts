import { describe, expect, it } from "vitest";
import type { Job, Registration } from "../src/notifications/models.js";
import {
  claimJob,
  eligible,
  newJob,
  ownsClaim,
  recoverJob,
  sendCompleted,
} from "../src/notifications/policy.js";
import { unavailableNotificationProvider } from "../src/notifications/provider.js";

const registration = {
  generation: "generation",
  token: "native-token",
  enabled: true,
  platform: "ios",
  provider: "apns",
  environment: "production",
  features: [],
} as Registration;
const initial = () =>
  newJob(
    "job",
    "phone",
    "generation",
    { type: "notify", sessionId: "session", kind: "idle" },
    1000,
    undefined,
  );
const sending = () => claimJob(initial(), "claim", 1000)!;

describe("direct push durable policy", () => {
  it("fails closed with a sanitized outcome when runtime credentials are unavailable", async () => {
    const outcomes = await unavailableNotificationProvider.send([
      {
        destination: { provider: "apns", token: "private-token", environment: "production" },
        route: { computerFp: "computer", sessionId: "session", kind: "idle" },
        genericTitle: "Shellbell",
        genericBody: "A session needs attention",
        group: "group",
        expiresAtSeconds: 120,
      },
    ]);
    expect(outcomes).toEqual([{ status: "rejected", code: "invalid-credentials" }]);
  });
  it("removes accepted work without creating a receipt job", () => {
    expect(sendCompleted(sending(), { status: "accepted" }, 1001).job).toBeNull();
  });
  it("never makes a legacy no-provider token eligible", () => {
    expect(
      eligible(initial(), { ...registration, provider: null } as Registration, false, 1001),
    ).toBe(false);
  });
  it.each(["pending-receipt", "checking-receipt"] as const)(
    "retires legacy %s without sending",
    (state) => {
      expect(
        recoverJob({ ...initial(), state, ticketId: "legacy-ticket" }, registration, false, 1001),
      ).toBeNull();
      expect(claimJob({ ...initial(), state }, "claim", 1001)).toBeNull();
    },
  );
  it("honors provider retry delay inside the existing freshness window", () => {
    expect(
      sendCompleted(
        sending(),
        { status: "retryable", code: "http-server", retryAfterMs: 60_000 },
        1001,
      ).job?.dueAt,
    ).toBe(61001);
  });
  it("drops APNs server failures whose fifteen-minute delay exceeds freshness", () => {
    expect(
      sendCompleted(
        sending(),
        { status: "retryable", code: "http-server", retryAfterMs: 900_000 },
        1001,
      ).job,
    ).toBeNull();
  });
  it("bounds timeout retries by attempt count and freshness", () => {
    expect(
      sendCompleted({ ...sending(), sendCount: 3 }, { status: "retryable", code: "timeout" }, 1001)
        .job,
    ).toBeNull();
    expect(
      sendCompleted(sending(), { status: "retryable", code: "timeout" }, 116000).job,
    ).toBeNull();
  });
  it("does not revoke rejected APNs device tokens", () => {
    expect(
      sendCompleted(sending(), { status: "rejected", code: "invalid-device-token" }, 1001),
    ).toEqual({ job: null, disableRegistration: false });
    expect(sendCompleted(sending(), { status: "unregistered" }, 1001)).toEqual({
      job: null,
      disableRegistration: true,
    });
  });
  it("fences stale results after token rotation and unpairing", () => {
    const job: Job = sending();
    const claim = { job, token: registration.token!, registration };
    expect(ownsClaim(claim, job, { ...registration, token: "rotated" }, false, 1001)).toBe(false);
    expect(ownsClaim(claim, job, undefined, false, 1001)).toBe(false);
  });
});
