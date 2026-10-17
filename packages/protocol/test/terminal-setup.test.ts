import { describe, expect, it } from "vitest";
import {
  parseInner,
  parseInnerLoose,
  type TerminalSetup,
  TerminalSetupIssueSchema,
  TerminalSetupListSchema,
  terminalNeedsAttention,
  terminalSetupText,
} from "../src/index.js";
import { parseInner as oldParseInner } from "./fixtures/legacy-protocol-20260921/inner.js";

const hello = {
  type: "hello",
  agentVersion: "0.7.0",
  backends: [],
  computerName: "Mac",
  accent: "blue",
};

describe("terminal setup in hello", () => {
  it("is optional, bounded, and dropped by older phones", () => {
    const terminalSetup = [
      { name: "iterm2", connected: false, issue: "automation-denied" },
      { name: "tmux", connected: true },
      {
        name: "herdr",
        connected: true,
        issue: "limited",
        detail: "Update Herdr to 0.9.3 or newer to open Herdr sessions from your phone.",
      },
    ];
    expect(parseInner({ ...hello, terminalSetup })).toEqual({ ...hello, terminalSetup });
    expect(parseInnerLoose({ ...hello, terminalSetup })).toEqual({ ...hello, terminalSetup });
    expect(oldParseInner({ ...hello, terminalSetup })).toEqual(hello);
    expect(parseInner(hello)).toEqual(hello);
    for (const bad of [
      [
        { name: "tmux", connected: true },
        { name: "tmux", connected: false },
      ],
      [{ name: "tmux", connected: false, issue: "unknown-issue" }],
      [{ name: "tmux", connected: false, detail: "line\nbreak" }],
      [{ name: "tmux", connected: false, extra: 1 }],
    ]) {
      expect(TerminalSetupListSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("terminalSetupText", () => {
  const setup = (overrides: Partial<TerminalSetup>): TerminalSetup => ({
    name: "iterm2",
    connected: false,
    ...overrides,
  });

  it("words every issue for every surface without internal terms", () => {
    for (const issue of TerminalSetupIssueSchema.options) {
      for (const name of ["iterm2", "tmux", "herdr"]) {
        for (const surface of ["mac-app", "command-line", "phone"] as const) {
          const { status, fix } = terminalSetupText(setup({ name, issue }), surface);
          const text = `${status} ${fix ?? ""}`;
          expect(status.length).toBeGreaterThan(5);
          expect(text).not.toMatch(/backend|socket|cookie|osascript|-1743/i);
        }
      }
    }
  });

  it("points each surface to its own way of connecting iTerm2", () => {
    const needs = setup({ issue: "needs-consent" });
    expect(terminalSetupText(needs, "mac-app").fix).toContain("Click Connect iTerm2.");
    expect(terminalSetupText(needs, "command-line").fix).toContain("shellbell connect iterm2");
    expect(terminalSetupText(needs, "phone")).toEqual({
      status: "iTerm2 needs one more step on your Mac.",
      fix: "Open Shellbell → Settings → Terminals on that Mac, or run shellbell doctor there.",
    });
    expect(terminalSetupText(setup({ connected: true }), "mac-app").status).toBe(
      "Connected. Ready for your paired phone.",
    );
  });

  it("only asks for attention when the user has something to do", () => {
    expect(terminalNeedsAttention(setup({ issue: "automation-denied" }))).toBe(true);
    expect(terminalNeedsAttention(setup({ name: "tmux", issue: "not-installed" }))).toBe(false);
    expect(terminalNeedsAttention(setup({ issue: "not-running" }))).toBe(false);
    expect(terminalNeedsAttention(setup({ issue: "api-off" }))).toBe(false);
    expect(terminalNeedsAttention(setup({ connected: true }))).toBe(false);
  });
});
