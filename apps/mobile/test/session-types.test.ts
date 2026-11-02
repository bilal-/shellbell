import { describe, expect, it } from "vitest";
import {
  filterOptions,
  matchesFilter,
  sessionDetails,
  sessionShell,
  sessionTypes,
} from "../src/util/session-types";

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    backend: id.split(":")[0],
    title: "zsh",
    cols: 80,
    rows: 24,
    windowId: "w1",
    windowNumber: 1,
    tabId: "t",
    tabIndex: 0,
    paneIndex: 1,
    isFocusedOnMac: false,
    state: "running",
    ...extra,
  }) as never;

describe("session types", () => {
  it("names where a session runs and what runs in it", () => {
    expect(sessionTypes(session("herdr:a", { agent: { kind: "claude" } }))).toEqual({
      terminal: { kind: "terminal", value: "herdr", label: "Herdr" },
      runs: { kind: "agent", value: "claude", label: "Claude" },
    });
    expect(sessionTypes(session("tmux:b")).runs).toEqual({
      kind: "shell",
      value: "zsh",
      label: "zsh",
    });
    // A title that isn't a shell's name says nothing about what runs.
    expect(sessionTypes(session("tmux:c", { title: "main:0.0" })).runs).toBeNull();
    expect(sessionShell(session("tmux:d", { title: "-bash" }) as never)).toBe("bash");
  });

  it("offers a filter only where the list has more than one type", () => {
    const sameEverything = [session("tmux:a"), session("tmux:b")];
    expect(filterOptions(sameEverything)).toEqual([]);
    const mixed = [
      session("tmux:a"),
      session("herdr:b", { agent: { kind: "claude" } }),
      session("herdr:c", { agent: { kind: "codex" } }),
    ];
    expect(filterOptions(mixed).map((o) => o.label)).toEqual([
      "tmux",
      "Herdr",
      "zsh",
      "Claude",
      "Codex",
    ]);
    const filter = filterOptions(mixed)[3]!;
    expect(mixed.filter((s) => matchesFilter(s, filter)).map((s: { id: string }) => s.id)).toEqual([
      "herdr:b",
    ]);
    expect(mixed.filter((s) => matchesFilter(s, null))).toHaveLength(3);
  });

  it("lists the details the session list carries, and leaves out what it doesn't", () => {
    expect(
      sessionDetails(
        session("tmux:a", {
          cwd: "/Users/me/code/app",
          instance: "srv-1",
          windowLabel: "work",
          shownIn: ["Ghostty"],
          agent: { kind: "claude", task: "Fix tests" },
          state: "blocked",
          title: "claude",
          chat: { state: "none", agent: "claude", reason: "agent-exited" },
        }),
      ),
    ).toEqual([
      { label: "Folder", value: "~/code/app" },
      { label: "Terminal app", value: "tmux · in Ghostty" },
      { label: "Window, tab and pane", value: "work · tab 1 · pane 2" },
      { label: "tmux server", value: "srv-1" },
      { label: "Agent", value: "Claude · waiting for you · Fix tests" },
      { label: "Chat", value: "None · Claude exited." },
    ]);
    expect(sessionDetails(session("herdr:b")).map((line) => line.label)).toEqual([
      "Shell",
      "Terminal app",
      "Window, tab and pane",
      "State",
    ]);
  });
});
