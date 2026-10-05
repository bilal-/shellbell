import { describe, expect, it } from "vitest";
import { diffTyped } from "../src/input/differ.js";

describe("diffTyped", () => {
  it("appends, deletes, replaces", () => {
    expect(diffTyped("", "ab")).toEqual([{ kind: "text", text: "ab" }]);
    expect(diffTyped("ab", "a")).toEqual([{ kind: "backspace", count: 1 }]);
    expect(diffTyped("abc", "abd")).toEqual([
      { kind: "backspace", count: 1 },
      { kind: "text", text: "d" },
    ]);
    expect(diffTyped("abc", "abc")).toEqual([]);
    expect(diffTyped("a", "🚀")).toEqual([
      { kind: "backspace", count: 1 },
      { kind: "text", text: "🚀" },
    ]);
  });

  it("handles a middle replacement and a full clear", () => {
    expect(diffTyped("git push", "git pull")).toEqual([
      { kind: "backspace", count: 2 },
      { kind: "text", text: "ll" },
    ]);
    expect(diffTyped("abc", "")).toEqual([{ kind: "backspace", count: 3 }]);
  });
});
