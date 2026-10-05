import { describe, expect, it, vi } from "vitest";
import {
  buildScheduleInput,
  extractRingPayload,
  handleIncomingRing,
  selectRingInput,
} from "../src/notifications/ring";

function deps() {
  return {
    lookup: () => ({ title: "claude-code", backend: "herdr" }),
    present: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
  };
}

describe("handleIncomingRing (spec 2026-09-20 §4)", () => {
  it.each(["hidden", "unavailable"])(
    "keeps the generic alert when privacy is %s",
    async (state) => {
      const d = {
        ...deps(),
        allowDetails: async () => {
          if (state === "unavailable") throw new Error("locked");
          return false;
        },
      };
      await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "generic", d);
      expect(d.present).not.toHaveBeenCalled();
      expect(d.dismiss).not.toHaveBeenCalled();
    },
  );
  it("never presents or dismisses a native-owned rich notification", async () => {
    const d = deps();
    const payload = {
      computerFp: "abc",
      sessionId: "s1",
      kind: "blocked",
      shellbellNotification: "notify-context-v1",
    };
    expect(extractRingPayload({ data: payload })).toBeUndefined();
    expect(extractRingPayload({ dataString: JSON.stringify(payload) })).toBeUndefined();
    await handleIncomingRing(payload, "native-id", d);
    expect(d.present).not.toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
  });
  it("presents an enriched notification keyed to the session", async () => {
    const d = deps();
    await handleIncomingRing(
      { computerFp: "abc", sessionId: "s1", kind: "blocked" },
      "incoming-id",
      d,
    );
    expect(d.present).toHaveBeenCalledWith({
      identifier: "abc:s1",
      title: "claude-code",
      body: "An agent is waiting for you",
      data: { computerFp: "abc", sessionId: "s1", kind: "blocked" },
    });
  });

  it("dismisses the relay's generic notification it replaced", async () => {
    const d = deps();
    await handleIncomingRing(
      { computerFp: "abc", sessionId: "s1", kind: "idle" },
      "incoming-id",
      d,
    );
    expect(d.dismiss).toHaveBeenCalledWith("incoming-id");
  });

  it("does nothing when the payload is not a ring", async () => {
    const d = deps();
    await handleIncomingRing({ computerFp: "", sessionId: "", kind: "" }, "incoming-id", d);
    expect(d.present).not.toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
  });

  it("still presents when the title is unknown, using the fallback", async () => {
    const d = { ...deps(), lookup: () => undefined };
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "i", d);
    expect(d.present).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Session", identifier: "abc:s1" }),
    );
  });

  it("never dismisses without presenting first (a swapped await must not pass)", async () => {
    const order: string[] = [];
    const d = {
      lookup: () => ({ title: "claude-code", backend: "herdr" }),
      present: vi.fn(async () => {
        order.push("present");
      }),
      dismiss: vi.fn(async () => {
        order.push("dismiss");
      }),
    };
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "i", d);
    expect(order).toEqual(["present", "dismiss"]);
  });

  it("skips the dismiss when there is no identifier to dismiss (review I3)", async () => {
    const d = deps();
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, undefined, d);
    expect(d.present).toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
  });
});

/**
 * Review C2: `NotificationContentInput` (verified against the installed
 * `expo-notifications/src/Notifications.types.ts`) has no `channelId` — only
 * `ChannelAwareTriggerInput` (`{ channelId: string }`, one arm of `NotificationTriggerInput`) does.
 * `trigger: null` (the pre-fix code) makes Android's `BaseNotificationBuilder.kt` fall back to
 * `expo_notifications_fallback_notification_channel`, losing the `rings` channel's emerald
 * light/vibration and risking a double-buzz on a second, muted-by-default channel.
 */
describe("buildScheduleInput (review C1 data passthrough + C2 channel)", () => {
  it("schedules on the rings channel and carries data for the tap path", () => {
    const n = {
      identifier: "abc:s1",
      title: "claude-code",
      body: "An agent is waiting for you",
      data: { computerFp: "abc", sessionId: "s1", kind: "blocked" },
    };
    expect(buildScheduleInput(n)).toEqual({
      identifier: "abc:s1",
      content: {
        title: "claude-code",
        body: "An agent is waiting for you",
        sound: "default",
        data: { computerFp: "abc", sessionId: "s1", kind: "blocked" },
      },
      trigger: { channelId: "rings" },
    });
  });
});

/**
 * Review I1/I2: the raw `expo-task-manager` shape selection (response vs. plain-message) and the
 * dismissal identifier's `tag ?? messageId` fallback (mirrors `FirebaseMessagingDelegate.kt`'s
 * `getNotificationIdentifier`: `remoteMessage.data["tag"] ?: remoteMessage.messageId ?: ...`) were
 * previously inline in `index.ts`'s `defineTask` and untested.
 */
describe("selectRingInput (review I1/I2)", () => {
  it("reads the response shape's content and identifier from notification.request", () => {
    const raw = {
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: { request: { identifier: "abc:s1", content: { dataString: "{}" } } },
    };
    expect(selectRingInput(raw)).toEqual({
      content: { dataString: "{}" },
      identifier: "abc:s1",
    });
  });

  it("prefers data.tag over messageId on the plain-message shape (review I2)", () => {
    const raw = { data: { dataString: "{}", tag: "abc:s1" }, messageId: "0:abcdef" };
    expect(selectRingInput(raw)).toEqual({
      content: { dataString: "{}", tag: "abc:s1" },
      identifier: "abc:s1",
    });
  });

  it("falls back to messageId when there is no tag", () => {
    const raw = { data: { dataString: "{}" }, messageId: "0:abcdef" };
    expect(selectRingInput(raw)).toEqual({
      content: { dataString: "{}" },
      identifier: "0:abcdef",
    });
  });

  it("has no identifier when neither tag nor messageId is present", () => {
    const raw = { data: { dataString: "{}" } };
    expect(selectRingInput(raw)).toEqual({
      content: { dataString: "{}" },
      identifier: undefined,
    });
  });

  it("returns undefined for an unrecognised (missing) payload", () => {
    expect(selectRingInput(undefined)).toBeUndefined();
    expect(selectRingInput(null)).toBeUndefined();
  });
});

/**
 * Spec 2026-09-20 §4 / review finding: `expo-task-manager`'s background delivery is NOT run
 * through expo-notifications' `mapNotificationContent`, so the raw payload never has `.data` —
 * only `.dataString`, a JSON string, which must be parsed here. Traced against the installed
 * native source: `RemoteMessageSerializer.java` (`data.dataString`, Android's plain-message
 * path), `NotificationSerializer.java` (`content.dataString`, the tap/response path), and
 * `mapNotificationResponse.ts`'s `mapNotificationContent`, which performs the identical
 * `dataString` → `JSON.parse` → `.data` mapping for the paths that DO get mapped (confirming the
 * shape). `.data` is kept as a fallback for whichever path already mapped it.
 */
describe("extractRingPayload (spec 2026-09-20 §4: raw expo-task-manager payload shapes)", () => {
  const payload = { computerFp: "abc", sessionId: "s1", kind: "idle" };

  it("parses a dataString-carrying request (the real, unmapped background-task shape)", () => {
    expect(extractRingPayload({ dataString: JSON.stringify(payload) })).toEqual(payload);
  });

  it("falls back to an already-mapped data field", () => {
    expect(extractRingPayload({ data: payload })).toEqual(payload);
  });

  it("fails safe (no throw) on malformed JSON", () => {
    expect(extractRingPayload({ dataString: "{not json" })).toBeUndefined();
  });

  it("fails safe on a missing payload", () => {
    expect(extractRingPayload(undefined)).toBeUndefined();
    expect(extractRingPayload(null)).toBeUndefined();
    expect(extractRingPayload({})).toBeUndefined();
  });

  it("fails safe when required fields are missing", () => {
    expect(extractRingPayload({ data: { computerFp: "abc" } })).toBeUndefined();
    expect(
      extractRingPayload({ dataString: JSON.stringify({ computerFp: "abc", sessionId: "s1" }) }),
    ).toBeUndefined();
  });
});
