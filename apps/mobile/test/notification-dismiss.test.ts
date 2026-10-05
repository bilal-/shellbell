import { describe, expect, it } from "vitest";
import { notificationIdFor } from "../src/notifications/content";
import { matchingNotificationIds } from "../src/notifications/dismiss";

describe("notificationIdFor", () => {
  it("selects only the exact computer/session, including provider-generated identifiers", () => {
    const alert = (identifier: string, computerFp: string, sessionId: string) => ({
      request: { identifier, content: { data: { computerFp, sessionId } } },
    });
    const shown = [
      alert("provider-a", "a", "one"),
      alert("provider-b", "a", "two"),
      alert("provider-c", "b", "one"),
    ];
    expect(matchingNotificationIds(shown, "a", "one")).toEqual(["provider-a"]);
    expect(matchingNotificationIds(shown, "a")).toEqual(["provider-a", "provider-b"]);
    expect(
      matchingNotificationIds([{ request: { identifier: "bad", content: { data: null } } }], "a"),
    ).toEqual([]);
  });
  it("matches the identifier the ring handler presents under", () => {
    expect(notificationIdFor("abc", "s1")).toBe("abc:s1");
  });
});
