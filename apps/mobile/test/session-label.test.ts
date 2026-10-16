import { describe, expect, it } from "vitest";
import {
  abbreviateHome,
  friendlyState,
  groupLabel,
  sessionAccessibilityLabel,
  sessionStatusLine,
  sessionSubtitle,
  sessionTitle,
} from "../src/util/session-label";

const base = { title: "claude", cwd: "/Users/example/code/shellbell" };

describe("session titles", () => {
  it("prefers the project and keeps the legacy title for older computers", () => {
    expect(sessionTitle({ ...base, project: "shellbell" })).toBe("shellbell");
    expect(sessionTitle(base)).toBe("claude");
    expect(sessionTitle({ ...base, project: "  " })).toBe("claude");
  });
});

describe("session subtitles", () => {
  it("shows the agent and its task", () => {
    expect(
      sessionSubtitle({
        ...base,
        project: "shellbell",
        agent: { kind: "claude", task: "Relay security for mobile and laptop" },
      }),
    ).toEqual({
      kind: "agent",
      agent: "claude",
      text: "claude · Relay security for mobile and laptop",
    });
    expect(sessionSubtitle({ ...base, agent: { kind: "codex" } })).toEqual({
      kind: "agent",
      agent: "codex",
      text: "codex",
    });
  });

  it("shows a home-relative folder without an agent, and nothing without a folder", () => {
    expect(sessionSubtitle(base)).toEqual({ kind: "path", text: "~/code/shellbell" });
    expect(sessionSubtitle({ title: "zsh" })).toBeUndefined();
  });

  it.each([
    ["/Users/example/code/shellbell", "~/code/shellbell"],
    ["/Users/example", "~"],
    ["/Users/example/", "~"],
    ["/home/dev/src/app", "~/src/app"],
    ["/root/work", "~/work"],
    ["/root", "~"],
    ["/Users", "/Users"],
    ["/Users/Shared/build", "/Users/Shared/build"],
    ["/opt/homebrew", "/opt/homebrew"],
    ["/tmp", "/tmp"],
    ["C:\\Users\\example\\repo", "C:\\Users\\example\\repo"],
  ])("abbreviates %j as %j", (cwd, shown) => {
    expect(abbreviateHome(cwd)).toBe(shown);
  });
});

describe("group labels", () => {
  it("uses a workspace label when the computer sends one", () => {
    // A workspace name keeps its own case; the generic window label is all caps like the backend.
    expect(groupLabel("Herdr", { windowNumber: 2, windowLabel: "webBooks" })).toEqual({
      backend: "HERDR",
      name: "webBooks",
    });
    expect(groupLabel("tmux", { windowNumber: 1 })).toEqual({ backend: "TMUX · WINDOW 1" });
    expect(groupLabel("tmux", { windowNumber: 1, windowLabel: "" })).toEqual({
      backend: "TMUX · WINDOW 1",
    });
  });

  it("names the desktop apps the computer reports showing the group", () => {
    expect(
      groupLabel("Herdr", { windowNumber: 2, windowLabel: "webBooks", shownIn: ["Ghostty"] }),
    ).toEqual({ backend: "HERDR", name: "webBooks", shownIn: "in Ghostty" });
    expect(groupLabel("Herdr", { windowNumber: 2, shownIn: ["Ghostty", "iTerm2"] })).toEqual({
      backend: "HERDR · WINDOW 2",
      shownIn: "in Ghostty and iTerm2",
    });
  });
});

describe("accessibility labels", () => {
  it("reads the project, agent, task, terminal and state in order", () => {
    expect(
      sessionAccessibilityLabel(
        {
          ...base,
          project: "shellbell",
          agent: { kind: "claude", task: "Relay security" },
        },
        { backend: "Herdr", state: "running", unread: true },
      ),
    ).toBe("shellbell, claude, Relay security, Herdr, running, unread activity");
    expect(sessionAccessibilityLabel(base, { backend: "tmux" })).toBe(
      "claude, ~/code/shellbell, tmux",
    );
  });
});

describe("session header status line", () => {
  it.each([
    ["running", "working"],
    ["finished", "idle"],
    ["blocked", "waiting for you"],
    ["editing", "editing"],
    ["unknown", null],
    ["compacting", "compacting"],
    ["", null],
  ])("names state %j as %j", (state, word) => {
    expect(friendlyState(state)).toBe(word);
  });

  it("capitalises the agent and keeps its task out of the header", () => {
    const agent = { ...base, agent: { kind: "codex", task: "Fix the relay" } };
    expect(sessionStatusLine({ ...agent, state: "finished" }, "tmux")).toBe("Codex · idle");
    expect(sessionStatusLine({ ...agent, state: "blocked" }, "tmux")).toBe(
      "Codex · waiting for you",
    );
    expect(sessionStatusLine({ ...agent, state: "unknown" }, "tmux")).toBe("Codex");
  });

  it("uses the state, or the terminal's name, for a session without an agent", () => {
    expect(sessionStatusLine({ ...base, state: "running" }, "tmux")).toBe("working");
    expect(sessionStatusLine({ ...base, state: "unknown" }, "iTerm2")).toBe("iTerm2");
  });
});
