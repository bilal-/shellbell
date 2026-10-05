import type { PushIntent, SendOutcome } from "@shellbell/relay-core";
import { describe, expect, it, vi } from "vitest";
import { observePushDelivery } from "../src/adapters/push-diagnostics.js";

function intent(provider: "apns" | "fcm"): PushIntent {
  return {
    destination: {
      provider,
      token: "private-device-token",
      ...(provider === "apns" ? { environment: "production" as const } : {}),
    },
    route: { computerFp: "private-computer", sessionId: "private-session", kind: "idle" },
    genericTitle: "private-title",
    genericBody: "private-body",
    group: "private-group",
    expiresAtSeconds: 123456,
  };
}

describe("push delivery diagnostics", () => {
  it("reports controlled provider results without logging destination or notification data", async () => {
    const intents = [intent("apns"), intent("fcm"), intent("apns")];
    const outcomes: readonly SendOutcome[] = [
      { status: "accepted" },
      { status: "rejected", code: "invalid-credentials" },
      { status: "unregistered" },
    ];
    const send = vi.fn(async () => outcomes);
    const report = vi.fn();
    expect(await observePushDelivery({ send }, report).send(intents)).toBe(outcomes);
    expect(send).toHaveBeenCalledExactlyOnceWith(intents);
    expect(report.mock.calls.map(([value]) => value)).toEqual([
      { provider: "apns", environment: "production", status: "accepted" },
      { provider: "fcm", status: "rejected", code: "invalid-credentials" },
      { provider: "apns", environment: "production", status: "unregistered" },
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private-");
  });

  it("omits unrecognized runtime codes, environments and extra response fields", async () => {
    const message = intent("apns");
    Object.assign(message.destination, { environment: "private-environment" });
    const outcome: SendOutcome = { status: "rejected", code: "invalid-credentials" };
    Object.assign(outcome, { code: "private-provider-response", token: "private-token" });
    const report = vi.fn();
    await observePushDelivery({ send: async () => [outcome] }, report).send([message]);
    expect(report).toHaveBeenCalledExactlyOnceWith({ provider: "apns", status: "rejected" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("private-");
  });

  it("cannot turn an accepted provider result into a retry when logging throws", async () => {
    const outcomes: readonly SendOutcome[] = [{ status: "accepted" }];
    const send = vi.fn(async () => outcomes);
    const report = vi.fn(() => {
      throw new Error("private-logger-error");
    });
    const result = await observePushDelivery({ send }, report).send([intent("apns")]);
    expect(result).toBe(outcomes);
    expect(send).toHaveBeenCalledOnce();
  });

  it("preserves provider failures without emitting raw errors or fabricated results", async () => {
    const error = new Error("private-provider-error");
    const report = vi.fn();
    const provider = observePushDelivery(
      {
        send: async () => {
          throw error;
        },
      },
      report,
    );
    await expect(provider.send([intent("apns")])).rejects.toBe(error);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports missing results without altering the service's retry handling", async () => {
    const outcomes: readonly SendOutcome[] = [];
    const report = vi.fn();
    expect(
      await observePushDelivery({ send: async () => outcomes }, report).send([intent("fcm")]),
    ).toBe(outcomes);
    expect(report).toHaveBeenCalledExactlyOnceWith({ provider: "fcm", status: "invalid-response" });
  });
});
