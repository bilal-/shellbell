import { describe, expect, it } from "vitest";
import { composerLayout } from "../src/input/layout";

describe("composer height budget", () => {
  it("keeps a long draft and Send within the reproduced 92-point landscape pane", () => {
    expect(composerLayout(92, 80, true)).toEqual({
      compact: true,
      inputHeight: 48,
      verticalPadding: 4,
    });
  });

  it("restores the full composer when there is room for controls and terminal output", () => {
    expect(composerLayout(400, 80, true)).toEqual({
      compact: false,
      inputHeight: 80,
      verticalPadding: 8,
    });
  });

  it("uses the available height after navigation insets have been reserved", () => {
    expect(composerLayout(126 - 34, 80, true)).toEqual({
      compact: true,
      inputHeight: 48,
      verticalPadding: 4,
    });
  });

  it("accounts for optional reply chips when choosing the compact state", () => {
    expect(composerLayout(180, 80, false).compact).toBe(false);
    expect(composerLayout(180, 80, true).compact).toBe(true);
  });

  it("retains a usable single line instead of collapsing it in an impossibly small pane", () => {
    expect(composerLayout(30, 40, true).inputHeight).toBe(40);
  });
});
