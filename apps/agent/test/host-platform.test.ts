import { describe, expect, it } from "vitest";
import { hostPlatform } from "../src/host-platform.js";

describe("service host platform", () => {
  it.each([
    ["darwin", "darwin"],
    ["linux", "linux"],
    ["win32", "win32"],
    ["freebsd", "unknown"],
    ["aix", "unknown"],
    ["", "unknown"],
  ])("normalizes %s to %s without guessing a shell", (platform, expected) => {
    expect(hostPlatform(platform)).toBe(expected);
  });
});
