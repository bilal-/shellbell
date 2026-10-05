import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import {
  notificationHeader as header,
  notificationPayload as payload,
} from "./notification-fixture.js";

describe("private notification contract", () => {
  it("preserves the authenticated hello capability in the forward-compatible mobile parser", () => {
    const hello = {
      type: "hello",
      agentVersion: "test",
      computerName: "Mac",
      accent: "green",
      backends: [],
      features: [protocol.NOTIFICATION_FEATURE],
    };
    expect(protocol.parseInnerLoose(hello)).toEqual(hello);
  });
  it("derives the enrollment key without an event or session identity", () => {
    const scope = {
      computerFp: header.computerFp,
      phoneFp: header.phoneFp,
      generation: header.generation,
    };
    const pairKey = new Uint8Array(32);
    expect(protocol.deriveNotificationKey(pairKey, scope)).toEqual(
      protocol.deriveNotificationKey(pairKey, header),
    );
    expect(() =>
      protocol.deriveNotificationKey(pairKey, { ...scope, generation: "bad" }),
    ).toThrow();
  });
  it("validates a bounded, versioned private payload", () => {
    expect(protocol.NotificationPayloadSchema).toBeDefined();
    expect(protocol.NotificationPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each(["0", "01", "-1", "1.5", "1e3", "18446744073709551616"])(
    "rejects a noncanonical or out-of-range sequence %s",
    (sequence) => {
      expect(protocol.NotificationPayloadSchema.safeParse({ ...payload, sequence }).success).toBe(
        false,
      );
    },
  );

  it("rejects unknown private fields instead of silently leaking or discarding them", () => {
    expect(
      protocol.NotificationPayloadSchema.safeParse({ ...payload, command: "secret" }).success,
    ).toBe(false);
    expect(
      protocol.NotificationPayloadSchema.safeParse({
        ...payload,
        context: { ...payload.context, cwd: "/secret" },
      }).success,
    ).toBe(false);
  });

  it.each(["\u001b[31mrepo", "one\ntwo", "spoof\u202erepo", "bad\ud800"])(
    "rejects unsafe label %j at the wire boundary",
    (title) => {
      expect(
        protocol.NotificationPayloadSchema.safeParse({
          ...payload,
          context: { ...payload.context, title },
        }).success,
      ).toBe(false);
    },
  );

  it("limits Unicode labels in bytes, not code units", () => {
    expect(
      protocol.NotificationPayloadSchema.safeParse({
        ...payload,
        context: { ...payload.context, title: "猫".repeat(100) },
      }).success,
    ).toBe(false);
  });

  it("rejects long expiry windows and impossible observation times", () => {
    for (const bad of [
      { expiresAt: 121001 },
      { expiresAt: 999 },
      { issuedAt: -1 },
      { context: { ...payload.context, observedAt: 1001 } },
    ])
      expect(protocol.NotificationPayloadSchema.safeParse({ ...payload, ...bad }).success).toBe(
        false,
      );
  });

  it("requires canonical unpadded generation/event bytes", () => {
    for (const generation of [`${header.generation}=`, `${header.generation.slice(0, -1)}R`, "a"])
      expect(protocol.NotificationHeaderSchema.safeParse({ ...header, generation }).success).toBe(
        false,
      );
  });

  it("accepts additive capability and encrypted enrollment without requiring them on old peers", () => {
    const auth = {
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: null,
      serverTime: 1,
      minFrameMs: 100,
    };
    expect(protocol.parseCtrl(auth)).toEqual(auth);
    expect(protocol.parseCtrl({ ...auth, features: ["notify-context-v1"] })).toMatchObject({
      features: ["notify-context-v1"],
    });
    for (const type of ["notification.enroll", "notification.enrolled"])
      expect(protocol.parseInner({ type, generation: header.generation })).toEqual({
        type,
        generation: header.generation,
      });
    expect(
      protocol.parseCtrl({
        type: "push-token",
        token: "test",
        platform: "ios",
        enabled: true,
        features: ["notify-context-v1"],
      }),
    ).toMatchObject({ features: ["notify-context-v1"] });
  });

  it("accepts one logical notify-context event but rejects duplicate recipients or mixed event identities", () => {
    const box = protocol.sealNotification(
      protocol.deriveNotificationKey(new Uint8Array(32), header),
      payload,
    );
    const event = {
      type: "notify-context",
      sessionId: header.sessionId,
      kind: "blocked",
      eventId: header.eventId,
      boxes: [box],
    };
    expect(protocol.parseCtrl(event)).toEqual(event);
    for (const boxes of [
      [box, box],
      Array.from({ length: 11 }, () => box),
      [{ ...box, eventId: protocol.toBase64Url(new Uint8Array(16).fill(4)) }],
      [{ ...box, sessionId: "other-session" }],
      [box, { ...box, phoneFp: "d".repeat(26), computerFp: "e".repeat(26) }],
    ])
      expect(() => protocol.parseCtrl({ ...event, boxes })).toThrow();
  });

  it("bounds the aggregate payload even when each label is individually valid", () => {
    expect(
      protocol.NotificationPayloadSchema.safeParse({
        ...payload,
        context: {
          ...payload.context,
          customName: "x".repeat(256),
          repository: "x".repeat(256),
          branch: "x".repeat(256),
          title: "x".repeat(256),
          computerName: "x".repeat(128),
          sessionLabel: "x".repeat(128),
          shell: "x".repeat(64),
          agentName: "x".repeat(64),
        },
      }).success,
    ).toBe(false);
  });
});
