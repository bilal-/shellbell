import { describe, expect, it } from "vitest";
import { shouldLoadOlder } from "../src/util/session-state";

describe("shouldLoadOlder (spec 10.5 / review coverage gap)", () => {
  it("loads more while there is room above and no oldest-available bound is known yet", () => {
    expect(shouldLoadOlder(500, undefined)).toBe(true);
  });

  it("stops at the top of the buffer (historyFrom <= 0)", () => {
    expect(shouldLoadOlder(0, undefined)).toBe(false);
    expect(shouldLoadOlder(-1, undefined)).toBe(false);
  });

  it("stops once the agent says there is nothing older than oldestAvailable", () => {
    expect(shouldLoadOlder(100, 100)).toBe(false);
    expect(shouldLoadOlder(100, 150)).toBe(false);
  });

  it("still loads while historyFrom is above the known oldest-available line", () => {
    expect(shouldLoadOlder(200, 100)).toBe(true);
  });
});
