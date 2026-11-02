import { describe, expect, it } from "vitest";
import { turnHaptic } from "../src/conversation/activity";
import {
  advanceTail,
  changedLines,
  LIVE_TAIL_LINES,
  newTailMemory,
  nextTail,
  PRIVATE_LINES_MAX,
} from "../src/conversation/liveTail";

describe("running step's live tail", () => {
  it("keeps only lines the terminal just printed, without the agent's own chrome", () => {
    const before = [
      "⏺ Bash(npm test)",
      "",
      "✻ Testing… (3s · esc to interrupt)",
      "╭────╮",
      "│ > │",
    ];
    const after = [
      "⏺ Bash(npm test)",
      "  PASS src/a.test.ts",
      "✻ Testing… (4s · esc to interrupt)",
      "╭────╮",
      "│ > │",
    ];
    expect(changedLines(before, after)).toEqual(["PASS src/a.test.ts"]);
    // The first screen seen is not news.
    expect(changedLines(null, after)).toEqual([]);
  });

  it("shows the latest three, and keeps its identity while nothing changes", () => {
    let tail: readonly string[] = [];
    for (const line of ["one", "two", "three", "four"]) tail = nextTail(tail, [line]);
    expect(tail).toEqual(["two", "three", "four"]);
    expect(tail).toHaveLength(LIVE_TAIL_LINES);
    expect(nextTail(tail, [])).toBe(tail);
    expect(nextTail(tail, ["four"].slice(1))).toBe(tail);
  });

  it("shortens a very long line", () => {
    const [line] = changedLines([""], ["x".repeat(500)]);
    expect(line).toHaveLength(160);
    expect(line!.endsWith("…")).toBe(true);
  });
});

describe("turn haptic", () => {
  const state = (working: boolean, waiting = false) => ({ working, waiting });
  it("taps when the agent finishes a turn or starts waiting for you", () => {
    expect(turnHaptic(state(true), state(false))).toBe(true);
    expect(turnHaptic(state(true), state(false, true))).toBe(true);
    expect(turnHaptic(state(false), state(false, true))).toBe(true);
  });
  it("stays quiet otherwise", () => {
    expect(turnHaptic(state(false), state(true))).toBe(false);
    expect(turnHaptic(state(false), state(false))).toBe(false);
    expect(turnHaptic(state(true), state(true))).toBe(false);
    expect(turnHaptic(state(false, true), state(false, true))).toBe(false);
  });
});

describe("the live tail while the screen is private", () => {
  it("never shows a secret's echo, however many private lines came before it", () => {
    const memory = newTailMemory();
    const at = (rows: string[], hidden: boolean) =>
      advanceTail(memory, { rows, private: hidden, working: true, step: "step-1" });
    at(["prompt"], false);
    // A long private stretch earlier on this screen.
    for (let i = 0; i <= PRIVATE_LINES_MAX; i++) at([`private line ${i}`], true);
    // A secret sent: its echo is on screen while the screen is private.
    at(["prompt", "hunter2-echo"], true);
    // The hold ends; the output scrolls the echo to another row.
    expect(at(["hunter2-echo", "PASS"], false)).toEqual(["PASS"]);
    expect(at(["PASS", "hunter2-echo", "done"], false)).not.toContain("hunter2-echo");
  });

  it("shows nothing while private, and starts afresh for a new step", () => {
    const memory = newTailMemory();
    const at = (rows: string[], hidden: boolean, step = "step-1") =>
      advanceTail(memory, { rows, private: hidden, working: true, step });
    at(["a"], false);
    expect(at(["b"], false)).toEqual(["b"]);
    expect(at(["c"], true)).toEqual([]);
    expect(at(["d"], false)).toEqual(["d"]);
    expect(at(["e"], false, "step-2")).toEqual(["e"]);
    expect(
      advanceTail(memory, { rows: ["f"], private: false, working: false, step: null }),
    ).toEqual([]);
  });
});
