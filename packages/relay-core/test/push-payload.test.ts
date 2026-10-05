import { describe, expect, it } from "vitest";
import fixture from "../../protocol/test/notification-vectors.json";
import { buildApnsPayload } from "../src/notifications/apns-payload.js";
import { buildFcmPayload } from "../src/notifications/fcm-payload.js";
import { buildPushIntent } from "../src/notifications/intent.js";
import nativePayloads from "../test-support/native-push-payloads.json";

const box = fixture.box;
const job = {
  computerFp: box.computerFp,
  sessionId: box.sessionId,
  kind: "prompt" as const,
  admittedAt: 1000,
  expiresAt: 3601000,
  context: box,
};
const privateComputerLabel = "private repository label";
const registration = {
  computerFp: box.computerFp,
  phoneFp: box.phoneFp,
  platform: "android",
  provider: "fcm" as const,
  token: "native-token",
  features: ["notify-context-v1"],
};

describe("native push payloads", () => {
  it("keeps the native receiver fixtures identical to direct provider requests", () => {
    const intent = buildPushIntent(job, registration);
    expect(buildFcmPayload(intent, 1000)).toEqual(nativePayloads.fcm);
    expect(
      buildApnsPayload({
        ...intent,
        destination: {
          provider: "apns",
          token: "ab".repeat(32),
          environment: "development",
        },
      }),
    ).toEqual(nativePayloads.apns);
    const serialized = JSON.stringify(nativePayloads);
    for (const label of ["MacBook", "fix/通知", "Terminal 2", privateComputerLabel]) {
      expect(serialized).not.toContain(label);
    }
  });
  it("does not count destination tokens or APNs headers against payload limits", () => {
    const intent = buildPushIntent(job, { ...registration, token: "t".repeat(4096) });
    expect(buildFcmPayload(intent, 1000).message.token).toHaveLength(4096);
    const apns = buildApnsPayload({
      ...intent,
      destination: { provider: "apns", token: "t".repeat(4096), environment: "production" },
      group: "g".repeat(1000),
    });
    expect(apns.body.body.context).toEqual(box);
  });
  it("retains opaque rich Android envelope and sends no second visible alert", () => {
    const intent = buildPushIntent(job, registration);
    expect(JSON.stringify(intent)).not.toContain(privateComputerLabel);
    expect(intent.expiresAtSeconds).toBe(121);
    const push = buildFcmPayload(intent, 1000);
    expect(push.message.data.body).toBe(
      JSON.stringify({ ...intent.route, shellbellNotification: "notify-context-v1", context: box }),
    );
    expect(push.message).not.toHaveProperty("notification");
    expect(push.message.android).toEqual({
      priority: "HIGH",
      collapse_key: intent.group,
      ttl: "120s",
    });
  });
  it.each(["prompt", "idle", "blocked"] as const)(
    "sends one generic Android alert for %s",
    (kind) => {
      const intent = buildPushIntent({ ...job, kind, context: undefined }, registration);
      const push = buildFcmPayload(intent, 1000);
      expect(push.message.notification).toEqual({ title: "Shellbell", body: intent.genericBody });
      expect(push.message.android.notification).toEqual({
        channel_id: "rings",
        sound: "default",
        tag: intent.group,
      });
      expect(JSON.parse(push.message.data.body)).toEqual(intent.route);
    },
  );
  it("sends one mutable generic APNs alert with unchanged ciphertext and routing", () => {
    const intent = buildPushIntent(job, {
      ...registration,
      platform: "ios",
      provider: "apns",
      environment: "development",
    });
    const push = buildApnsPayload(intent);
    expect(push.headers).toEqual({
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "121",
      "apns-collapse-id": intent.group,
    });
    expect(push.body).toEqual({
      aps: {
        alert: { title: "Shellbell", body: "A terminal session needs attention" },
        sound: "default",
        category: "ring",
        "thread-id": intent.group,
        "mutable-content": 1,
      },
      body: { ...intent.route, shellbellNotification: "notify-context-v1", context: box },
    });
  });
  it("isolates sessions and falls back when rich serialization exceeds Shellbell bound", () => {
    const intent = buildPushIntent(job, registration);
    expect(buildPushIntent({ ...job, sessionId: "other" }, registration).group).not.toBe(
      intent.group,
    );
    const large = { ...intent, box: { ...box, ciphertext: "x".repeat(5000) } };
    for (const payload of [
      buildFcmPayload(large, 1000),
      buildApnsPayload({
        ...large,
        destination: { provider: "apns", token: "token", environment: "production" },
      }),
    ]) {
      expect(JSON.stringify(payload)).not.toContain("ciphertext");
      expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(3500);
    }
    expect(() =>
      buildFcmPayload({ ...intent, route: { ...intent.route, sessionId: "x".repeat(5000) } }),
    ).toThrow("payload");
  });
  it("rejects mismatched native destinations", () => {
    expect(() => buildPushIntent(job, { ...registration, provider: undefined as never })).toThrow();
    expect(() => buildPushIntent(job, { ...registration, platform: "ios" })).toThrow();
    expect(() =>
      buildFcmPayload(
        buildPushIntent(job, {
          ...registration,
          platform: "ios",
          provider: "apns",
          environment: "production",
        }),
      ),
    ).toThrow();
  });
  it.each(["prompt", "idle", "blocked"] as const)(
    "sends one immutable generic APNs alert for %s",
    (kind) => {
      const intent = buildPushIntent(
        { ...job, kind, context: undefined },
        { ...registration, platform: "ios", provider: "apns", environment: "production" },
      );
      const payload = buildApnsPayload(intent);
      expect(payload.body.aps.alert).toEqual({ title: "Shellbell", body: intent.genericBody });
      expect(payload.body.aps).not.toHaveProperty("mutable-content");
      expect(payload.body.body).toEqual(intent.route);
      expect(payload.headers["apns-expiration"]).toBe("3601");
    },
  );
});
