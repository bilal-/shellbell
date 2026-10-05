import { NotificationBoxSchema, toBase64Url } from "@shellbell/protocol";
import {
  buildApnsPayload,
  buildFcmPayload,
  buildPushIntent,
  pushSessionGroup,
  selectPushContext,
} from "@shellbell/relay-core";
import { describe, expect, it } from "vitest";
import groupingVectors from "../../../packages/protocol/test/notification-presentation-vectors.json";
import fixture from "../../../packages/protocol/test/notification-vectors.json";

const box = fixture.box;
it.each(groupingVectors)(
  "matches the native notification session-tag vector: $sessionId",
  (vector) => {
    expect(pushSessionGroup(vector.computerFp, vector.sessionId)).toBe(vector.sessionTag);
  },
);
const registration = {
  computerFp: box.computerFp,
  phoneFp: box.phoneFp,
  platform: "ios",
  features: ["notify-context-v1"],
  token: "ab".repeat(32),
  provider: "apns" as const,
  environment: "development" as const,
};
const message = {
  type: "notify-context" as const,
  sessionId: box.sessionId,
  eventId: box.eventId,
  kind: "blocked" as const,
  boxes: [box],
};
const job = {
  computerFp: box.computerFp,
  sessionId: box.sessionId,
  kind: "blocked" as const,
  admittedAt: 1000,
  expiresAt: 3_601_000,
  context: box,
};

describe("ciphertext-only provider boundary", () => {
  it("keeps maximum-sized routing and ciphertext within the native payload bound", () => {
    const context = NotificationBoxSchema.parse({
      ...box,
      sessionId: "😺".repeat(64),
      ciphertext: toBase64Url(new Uint8Array(1552)),
    });
    const push = buildApnsPayload(
      buildPushIntent({ ...job, sessionId: context.sessionId, context }, registration),
    );
    expect(push.body.body.context).toEqual(context);
    expect(new TextEncoder().encode(JSON.stringify(push)).length).toBeLessThanOrEqual(3500);
  });
  it("selects only the enrolled recipient with explicit capability and correct computer", () => {
    expect(selectPushContext(message, box.phoneFp, registration)).toEqual(box);
    expect(selectPushContext(message, "a".repeat(26), registration)).toBeUndefined();
    expect(
      selectPushContext(message, box.phoneFp, { ...registration, features: [] }),
    ).toBeUndefined();
    expect(
      selectPushContext(message, box.phoneFp, { ...registration, computerFp: "z".repeat(26) }),
    ).toBeUndefined();
  });
  it("uses one mutable iOS alert, with no terminal labels outside ciphertext", () => {
    const push = buildApnsPayload(buildPushIntent(job, registration));
    expect(push.headers["apns-expiration"]).toBe("121");
    expect(push.body).toMatchObject({
      aps: { alert: { title: "Shellbell" }, "mutable-content": 1 },
      body: { shellbellNotification: "notify-context-v1", context: box },
    });
    expect(JSON.stringify(push)).not.toContain(JSON.stringify(fixture.payload.context.repository));
    expect(new TextEncoder().encode(JSON.stringify(push)).length).toBeLessThanOrEqual(3500);
  });
  it("uses a single data-only Android message so the native receiver owns presentation", () => {
    const push = buildFcmPayload(
      buildPushIntent(job, {
        ...registration,
        platform: "android",
        provider: "fcm",
        environment: undefined,
      }),
      1000,
    );
    expect(JSON.parse(push.message.data.body).context).toEqual(box);
    expect(push.message).not.toHaveProperty("notification");
    expect(push.message.android).not.toHaveProperty("notification");
    expect(push.message.android.priority).toBe("HIGH");
  });
  it("sends one generic alert for old clients, malformed boxes or mismatched recipients", () => {
    for (const push of [
      buildApnsPayload(buildPushIntent(job, { ...registration, features: [] })),
      buildApnsPayload(
        buildPushIntent({ ...job, context: { ...box, ciphertext: "not base64" } }, registration),
      ),
      buildApnsPayload(buildPushIntent(job, { ...registration, phoneFp: "a".repeat(26) })),
    ]) {
      expect(push.body.aps.alert.title).toBe("Shellbell");
      expect(push.body.body).not.toHaveProperty("context");
      expect(push.body.aps).not.toHaveProperty("mutable-content");
    }
  });
});
