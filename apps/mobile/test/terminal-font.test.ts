import { beforeEach, expect, it, vi } from "vitest";

const native = { terminalFont: vi.fn<() => Promise<string | null>>() };
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => native }));

beforeEach(() => {
  vi.resetModules();
  native.terminalFont.mockReset();
});

it("reads the app's font once and shares it with every terminal", async () => {
  native.terminalFont.mockResolvedValue("AAEAAAAS+/=");
  const { terminalFont } = await import("../src/terminal/font");
  expect(await terminalFont()).toBe("AAEAAAAS+/=");
  expect(await terminalFont()).toBe("AAEAAAAS+/=");
  expect(native.terminalFont).toHaveBeenCalledOnce();
});

it("sends no font, so the page uses its fallback, when the native copy is missing or odd", async () => {
  for (const value of [
    Promise.resolve(null),
    Promise.resolve("not base64!"),
    Promise.reject(new Error("x")),
  ]) {
    vi.resetModules();
    native.terminalFont.mockReturnValue(value);
    const { terminalFont } = await import("../src/terminal/font");
    expect(await terminalFont()).toBeNull();
  }
});
