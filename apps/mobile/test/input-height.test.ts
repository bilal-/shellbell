import { describe, expect, it } from "vitest";
import { clampInputHeight, INPUT_MAX_HEIGHT, INPUT_MIN_HEIGHT } from "../src/input/height";

describe("clampInputHeight", () => {
  it("keeps a single line at the one-line height the bar has always used", () => {
    // The collapsed bar must look exactly as it did before it could grow, or every session
    // starts with a taller input than the design calls for.
    expect(clampInputHeight(24)).toBe(INPUT_MIN_HEIGHT);
  });

  it("grows with the content once it is past one line", () => {
    const twoLines = INPUT_MIN_HEIGHT + 20;
    expect(clampInputHeight(twoLines)).toBe(twoLines);
  });

  it("stops growing at three lines so the terminal stays visible", () => {
    expect(clampInputHeight(INPUT_MAX_HEIGHT + 500)).toBe(INPUT_MAX_HEIGHT);
  });

  it("caps at three lines, not two or four", () => {
    // Guards the constant itself: the whole point is seeing a wrapped command without the
    // input eating the screen on a small phone.
    expect(INPUT_MAX_HEIGHT).toBe(INPUT_MIN_HEIGHT + 2 * 20);
  });

  it("ignores a zero or negative measurement from the first layout pass", () => {
    // onContentSizeChange can fire with 0 before the first real measure; collapsing the bar to
    // nothing on mount would be visible as a flicker.
    expect(clampInputHeight(0)).toBe(INPUT_MIN_HEIGHT);
    expect(clampInputHeight(-12)).toBe(INPUT_MIN_HEIGHT);
  });
});
