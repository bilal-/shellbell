import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("react-native");
  vi.doUnmock("../src/web/native-door");
  vi.resetModules();
});

it.each([
  ["ios", true, true],
  ["android", true, true],
  ["ios", false, false],
  ["android", false, false],
  ["web", true, false],
])("advertises Apps on %s with native transport %s: %s", async (platform, native, expected) => {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  vi.doMock("../src/web/native-door", () => ({ nativeWebDoor: native ? {} : null }));
  expect((await import("../src/web/enabled")).PAGES_ENABLED).toBe(expected);
});
