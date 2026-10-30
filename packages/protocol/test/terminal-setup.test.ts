import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  noUsableMacTerminal,
  noUsableMacTerminalText,
  parseInner,
  parseInnerLoose,
  type TerminalSetup,
  TerminalSetupIssueSchema,
  TerminalSetupListSchema,
  terminalNeedsAttention,
  terminalSetupText,
  visibleTerminalsText,
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

describe("a Mac with no terminal Shellbell can use", () => {
  const absent = (name: string): TerminalSetup => ({
    name,
    connected: false,
    issue: "not-installed",
  });

  it("is judged only when iTerm2, tmux and Herdr are all missing", () => {
    expect(noUsableMacTerminal([absent("iterm2"), absent("tmux"), absent("herdr")])).toBe(true);
    for (const present of [
      { name: "iterm2", connected: false, issue: "not-running" },
      { name: "iterm2", connected: false, issue: "needs-consent" },
      { name: "tmux", connected: false, issue: "no-session" },
      { name: "herdr", connected: true },
    ] as const) {
      const list = [absent("iterm2"), absent("tmux"), absent("herdr")].map((entry) =>
        entry.name === present.name ? present : entry,
      );
      expect(noUsableMacTerminal(list)).toBe(false);
    }
    // A connected plugin terminal is enough.
    expect(
      noUsableMacTerminal([
        absent("iterm2"),
        absent("tmux"),
        absent("herdr"),
        { name: "example", connected: true },
      ]),
    ).toBe(false);
    // Linux computers list only tmux; older computers may list fewer terminals.
    expect(noUsableMacTerminal([absent("tmux")])).toBe(false);
    expect(noUsableMacTerminal([absent("iterm2"), absent("tmux")])).toBe(false);
    expect(noUsableMacTerminal([])).toBe(false);
  });

  it("says why Terminal alone is not enough, in plain words on every surface", () => {
    expect(noUsableMacTerminalText("mac-app")).toEqual({
      status: "Shellbell needs iTerm2, tmux or Herdr on this Mac.",
      fix: "Apple's Terminal only lets other apps see plain text and type whole lines, which isn't enough to use a terminal from your phone, so Shellbell can't use it by itself. iTerm2 is the easiest: your phone sees every tab and can open new ones. With tmux or Herdr, sessions you run inside them show on your phone, in Terminal too.",
    });
    expect(noUsableMacTerminalText("command-line").fix).toMatch(
      /For example: brew install --cask iterm2, or brew install tmux$/,
    );
    expect(noUsableMacTerminalText("phone")).toEqual({
      status: "Your Mac needs iTerm2, tmux or Herdr.",
      fix: "Apple's Terminal only lets other apps see plain text and type whole lines, which isn't enough to use a terminal from your phone, so Shellbell can't use it by itself. Install one on your Mac. iTerm2 is the easiest.",
    });
    for (const surface of ["mac-app", "command-line", "phone"] as const) {
      const { status, fix } = noUsableMacTerminalText(surface);
      expect(`${status} ${fix}`).not.toMatch(/backend|socket|cookie|osascript|api/i);
    }
  });
});

describe("wording shared with the Mac app", () => {
  // The Swift copy reads the same file (ServicePresentationTests), so neither can drift alone.
  const shared = JSON.parse(
    readFileSync(
      new URL("../../../apps/macos/Tests/Fixtures/terminal-setup-text.json", import.meta.url),
      "utf8",
    ),
  ) as {
    noUsableTerminal: { status: string; steps: string };
    lists: { name: string; terminals: TerminalSetup[]; noUsable: boolean }[];
    notInstalledStatus: { name: string; noneUsable: boolean; status: string }[];
  };

  it("decides and words a Mac with no usable terminal as the Mac app does", () => {
    expect(noUsableMacTerminalText("mac-app")).toEqual({
      status: shared.noUsableTerminal.status,
      fix: shared.noUsableTerminal.steps,
    });
    for (const list of shared.lists)
      expect(noUsableMacTerminal(list.terminals), list.name).toBe(list.noUsable);
  });

  it("calls a missing terminal optional only while another one can be used", () => {
    for (const { name, noneUsable, status } of shared.notInstalledStatus)
      for (const surface of ["mac-app", "command-line"] as const)
        expect(
          terminalSetupText({ name, connected: false, issue: "not-installed" }, surface, {
            noneUsable,
          }).status,
        ).toBe(status);
  });
});

describe("which terminals a phone can show", () => {
  it("names iTerm2, tmux and Herdr for a Mac or an unknown computer, and only tmux for Linux", () => {
    const mac =
      "Your phone shows iTerm2 tabs and terminals running inside tmux or Herdr. Other apps' tabs, such as Terminal or Ghostty, appear only when tmux or Herdr runs inside them.";
    expect(visibleTerminalsText()).toBe(mac);
    expect(
      visibleTerminalsText([
        { name: "iterm2", connected: true },
        { name: "tmux", connected: false, issue: "no-session" },
      ]),
    ).toBe(mac);
    expect(visibleTerminalsText([{ name: "tmux", connected: true }])).toBe(
      "Your phone shows terminals running inside tmux. Start tmux in a terminal on your computer to see it here.",
    );
  });
});
