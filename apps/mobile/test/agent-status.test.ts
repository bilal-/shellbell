import { describe, expect, it } from "vitest";
import { formatElapsed, readAgentStatus } from "../src/conversation/agentStatus";

/** A Claude Code screen while it works: transcript above, its box and hints below. */
const CLAUDE_WORKING = [
  "⏺ I'll run the tests after the edit.",
  "",
  "⏺ Bash(npm test)",
  "  ⎿  Running…",
  "",
  "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)",
  "",
  "╭──────────────────────────────────────────────────────────╮",
  "│ >                                                        │",
  "╰──────────────────────────────────────────────────────────╯",
  "  ? for shortcuts",
];

describe("Claude Code's status line", () => {
  it("reads the verb, its timer and the token count", () => {
    expect(readAgentStatus("claude", CLAUDE_WORKING)).toEqual({
      label: "Cogitating…",
      seconds: 12,
      detail: "↑ 1.2k tokens",
    });
  });

  it("reads each spinner frame and longer timers", () => {
    for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽", "*"])
      expect(readAgentStatus("claude", [`${glyph} Pondering… (1m 5s · esc to interrupt)`])).toEqual(
        { label: "Pondering…", seconds: 65, detail: null },
      );
    expect(readAgentStatus("claude", ["✽ Thinking… (esc to interrupt)"])).toEqual({
      label: "Thinking…",
      seconds: null,
      detail: null,
    });
  });

  it("returns nothing when unsure", () => {
    for (const line of [
      // A spinner without its hint or timer, such as one left above a permission prompt.
      " ✻ Running tests…",
      "✻ Cogitating (12s · esc to interrupt)",
      "Cogitating… (12s · esc to interrupt)",
      "✻ Cogitating… (see the docs)",
      "⏺ Done. (12s · esc to interrupt) was printed by a test",
    ])
      expect(readAgentStatus("claude", [line]), line).toBeNull();
    // Too far above the bottom of the screen to be the live line.
    expect(
      readAgentStatus("claude", ["✻ Cogitating… (12s · esc to interrupt)", ...Array(20).fill("x")]),
    ).toBeNull();
  });
});

describe("Codex's status line", () => {
  it("reads its working line, old and new", () => {
    expect(readAgentStatus("codex", ["• Working (8s • esc to interrupt)", "", "› "])).toEqual({
      label: "Working",
      seconds: 8,
      detail: null,
    });
    expect(readAgentStatus("codex", ["Working (34s, esc to interrupt)"])).toEqual({
      label: "Working",
      seconds: 34,
      detail: null,
    });
  });

  it("needs the interrupt hint", () => {
    expect(readAgentStatus("codex", ["• Working (8s)"])).toBeNull();
    expect(readAgentStatus("codex", ["• Ran cargo fmt"])).toBeNull();
  });
});

describe("other agents", () => {
  it("have no reader yet, so the bar falls back to the session's state", () => {
    expect(readAgentStatus("gemini", ["✦ Working (34s, esc to interrupt)"])).toBeNull();
    expect(readAgentStatus(undefined, CLAUDE_WORKING)).toBeNull();
    expect(readAgentStatus("constructor", CLAUDE_WORKING)).toBeNull();
  });
});

it("formats elapsed time steadily", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(12.9)).toBe("12s");
  expect(formatElapsed(65)).toBe("1m 05s");
  expect(formatElapsed(3725)).toBe("1h 02m");
  expect(formatElapsed(-3)).toBe("0s");
});
