import { describe, expect, it } from "vitest";
import { rawBackspaceOnEmptySteps, rawChangeSteps } from "../src/input/rawSequence";

describe("rawChangeSteps (spec 10.6/15 message sequence)", () => {
  it("typed 'ab', backspace, then 'c' produces text/key/text", () => {
    let prev = "";
    const all: ReturnType<typeof rawChangeSteps> = [];
    for (const next of ["ab", "a", "ac"]) {
      all.push(...rawChangeSteps(prev, next));
      prev = next;
    }
    expect(all).toEqual([
      { kind: "text", text: "ab" },
      { kind: "key", key: "backspace" },
      { kind: "text", text: "c" },
    ]);
  });

  it("produces no steps for an unchanged value", () => {
    expect(rawChangeSteps("ab", "ab")).toEqual([]);
  });

  it("emits one backspace key step per removed character, not a single batched one", () => {
    expect(rawChangeSteps("abcd", "a")).toEqual([
      { kind: "key", key: "backspace" },
      { kind: "key", key: "backspace" },
      { kind: "key", key: "backspace" },
    ]);
  });

  it("clearing the whole field emits only backspaces, no trailing empty text step", () => {
    expect(rawChangeSteps("ab", "")).toEqual([
      { kind: "key", key: "backspace" },
      { kind: "key", key: "backspace" },
    ]);
  });
});

describe("rawBackspaceOnEmptySteps (review I1)", () => {
  it("sends a backspace key when the field is already empty", () => {
    expect(rawBackspaceOnEmptySteps("")).toEqual([{ kind: "key", key: "backspace" }]);
  });

  it("is a no-op when the field still has text (onChangeText diffs it instead)", () => {
    expect(rawBackspaceOnEmptySteps("a")).toEqual([]);
  });
});
