import { describe, expect, it } from "vitest";
import { saveNotificationPrivacy } from "../src/notifications/privacy";

describe("notification privacy write reconciliation", () => {
  it("rereads native truth when a write commits then throws", async () => {
    let hidden = true;
    const result = await saveNotificationPrivacy(
      {
        setHideNotificationDetails: async (next) => {
          hidden = next;
          throw new Error("directory fsync failed");
        },
        getHideNotificationDetails: async () => hidden,
      },
      false,
    );
    expect(result).toEqual({ saved: false, hide: false });
  });
  it("reports unknown rather than the old switch value when reconciliation fails", async () => {
    const result = await saveNotificationPrivacy(
      {
        setHideNotificationDetails: async () => {
          throw new Error("locked");
        },
        getHideNotificationDetails: async () => {
          throw new Error("locked");
        },
      },
      false,
    );
    expect(result).toEqual({ saved: false, hide: null });
  });
});
