import { describe, expect, it } from "vitest";
import { composerLayout } from "../src/input/layout";

/** Bar padding, the keys row, the row gap and the field with its two border points. */
const barHeight = (layout: ReturnType<typeof composerLayout>) =>
  layout.verticalPadding * 2 + layout.keyHeight + 4 + layout.inputHeight + 2;

describe("composer height budget", () => {
  it("keeps the keys row, a long draft and Send within the reproduced 92-point landscape pane", () => {
    const layout = composerLayout(92, 80, true);
    expect(layout).toEqual({
      compact: true,
      inputHeight: 40,
      keyHeight: 36,
      verticalPadding: 4,
    });
    expect(barHeight(layout)).toBeLessThanOrEqual(92);
  });

  it("restores the full composer when there is room for controls and terminal output", () => {
    expect(composerLayout(400, 80, true)).toEqual({
      compact: false,
      inputHeight: 80,
      keyHeight: 44,
      verticalPadding: 8,
    });
  });

  it("uses the available height after navigation insets have been reserved", () => {
    expect(composerLayout(126 - 34, 80, true)).toEqual({
      compact: true,
      inputHeight: 40,
      keyHeight: 36,
      verticalPadding: 4,
    });
  });

  it("gives a compact draft the keys row's height back when a physical keyboard hides it", () => {
    expect(composerLayout(92, 80, true, false)).toMatchObject({ compact: true, inputHeight: 48 });
  });

  it("accounts for optional reply chips when choosing the compact state", () => {
    expect(composerLayout(192, 80, false).compact).toBe(false);
    expect(composerLayout(192, 80, true).compact).toBe(true);
  });

  it("retains a usable single line instead of collapsing it in an impossibly small pane", () => {
    expect(composerLayout(30, 40, true).inputHeight).toBe(40);
  });
});
