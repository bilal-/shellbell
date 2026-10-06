import { describe, expect, it } from "vitest";
import { keyPresentation } from "../src/input/keyPresentation";

describe("host key guide", () => {
  it.each([
    ["darwin", "macOS"],
    ["linux", "Linux"],
    ["win32", "Windows"],
    ["unknown", "OS not reported"],
    [undefined, "OS not reported"],
  ] as const)("identifies only the %s service host", (platform, label) => {
    const presentation = keyPresentation(platform);
    expect(presentation.hostLabel).toBe(`Shellbell host: ${label}`);
    expect(presentation.guide).toMatch(/inside.*terminal/i);
    expect(presentation.guide).toMatch(/Ctrl\+C.*interrupt.*not copy/i);
  });
  it("explains macOS symbols without promising desktop modifier support", () => {
    const { guide } = keyPresentation("darwin");
    expect(guide).toContain("⌃ Control");
    expect(guide).toContain("⌘ Command");
    expect(guide).toContain("⌥ Option");
    expect(guide).toMatch(/Command desktop shortcuts are not sent/i);
    expect(guide).toMatch(/Alt sends terminal input, not a desktop shortcut/i);
  });
});
