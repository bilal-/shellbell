import { NAMED_KEYS, NamedKeySchema } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { tmuxKeyForBytes, tmuxKeyName } from "../src/backends/tmux/keys.js";
import {
  DISPLAY_FORMAT,
  HISTORY_DISPLAY_FORMAT,
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  parseClientRow,
  parseDisplay,
  parseHistoryDisplay,
  parsePaneRow,
  Q_DISPLAY,
  Q_HISTORY_DISPLAY,
  Q_PANES,
  titleFor,
} from "../src/backends/tmux/parse.js";

const row = [
  "%3",
  "$1",
  "work",
  "@2",
  "1",
  "zsh",
  "0",
  "mbp.local",
  "/Users/me/proj",
  "120",
  "40",
  "1",
  "1",
  "512",
  "3",
  "39",
  "0",
  "zsh",
].join("\t");

describe("tmux parsers", () => {
  it("parses a list-panes row", () => {
    const p = parsePaneRow(row);
    expect(p).toMatchObject({
      paneId: "%3",
      sessionId: "$1",
      sessionName: "work",
      windowId: "@2",
      windowIndex: 1,
      windowName: "zsh",
      paneIndex: 0,
      cwd: "/Users/me/proj",
      width: 120,
      height: 40,
      paneActive: true,
      windowActive: true,
      historySize: 512,
      cursorX: 3,
      cursorY: 39,
      dead: false,
      currentCommand: "zsh",
    });
    expect(LIST_PANES_FORMAT.split("\\t")).toHaveLength(18);
    expect(LIST_CLIENTS_FORMAT.split("\\t")).toHaveLength(2);
    expect(DISPLAY_FORMAT.split("\\t")).toHaveLength(5);
  });

  it("pre-quotes each format exactly once, with real TABs inside", () => {
    // Task 3 must never re-derive these per call.
    expect(Q_PANES.startsWith("'")).toBe(true);
    expect(Q_PANES).toContain("\t");
    expect(Q_PANES).not.toContain("\\t");
    expect(Q_DISPLAY.split("\t")).toHaveLength(5);
  });

  it("derives titles: window name when custom, else pane title unless hostname, else s:w.p", () => {
    const p = parsePaneRow(row);
    expect(titleFor(p, "mbp.local")).toBe("work:1.0");
    expect(titleFor({ ...p, windowName: "build" }, "mbp.local")).toBe("build");
    expect(titleFor({ ...p, paneTitle: "vim main.rs" }, "mbp.local")).toBe("vim main.rs");
  });

  it("parses clients and display-message", () => {
    expect(parseClientRow("$1\t1")).toEqual({ sessionId: "$1", controlMode: true });
    expect(parseClientRow("$1\t0")).toEqual({ sessionId: "$1", controlMode: false });
    expect(parseDisplay("3\t39\t512\t120\t40")).toEqual({
      cursorX: 3,
      cursorY: 39,
      historySize: 512,
      width: 120,
      height: 40,
    });
  });

  it("accepts only complete, canonical history display facts", () => {
    expect(parseHistoryDisplay("3\t39\t512\t120\t40\t2000\t0")).toEqual({
      cursorX: 3,
      cursorY: 39,
      historySize: 512,
      width: 120,
      height: 40,
      historyLimit: 2000,
      alternate: false,
    });
    expect(parseHistoryDisplay("0\t0\t0\t1\t1\t0\t1")).toMatchObject({
      historySize: 0,
      alternate: true,
    });
    for (const row of [
      "3\t39\t512\t120\t40\t2000",
      "3\t39\t512\t120\t40\t2000\t0\textra",
      "03\t39\t512\t120\t40\t2000\t0",
      "+3\t39\t512\t120\t40\t2000\t0",
      "3\t39\t512\t0\t40\t2000\t0",
      "3\t39\t512\t120\t40\t2000\t2",
      "3\t39\t9007199254740992\t120\t40\t2000\t0",
    ])
      expect(parseHistoryDisplay(row)).toBeNull();
    expect(HISTORY_DISPLAY_FORMAT.split("\\t")).toHaveLength(7);
    expect(Q_HISTORY_DISPLAY.split("\t")).toHaveLength(7);
  });

  it("maps every named key to a tmux key name", () => {
    for (const k of NamedKeySchema.options) expect(tmuxKeyName(k).length).toBeGreaterThan(0);
    expect(tmuxKeyName("enter")).toBe("Enter");
    expect(tmuxKeyName("tab")).toBe("Tab");
    expect(tmuxKeyName("shift-tab")).toBe("BTab");
    expect(tmuxKeyName("esc")).toBe("Escape");
    expect(tmuxKeyName("backspace")).toBe("BSpace");
    expect(tmuxKeyName("delete")).toBe("DC");
    expect(tmuxKeyName("up")).toBe("Up");
    expect(tmuxKeyName("left")).toBe("Left");
    expect(tmuxKeyName("home")).toBe("Home");
    expect(tmuxKeyName("end")).toBe("End");
    expect(tmuxKeyName("page-up")).toBe("PPage");
    expect(tmuxKeyName("page-down")).toBe("NPage");
    expect(tmuxKeyName("ctrl-c")).toBe("C-c");
    expect(tmuxKeyName("ctrl-space")).toBe("C-Space");
    expect(tmuxKeyName("f1")).toBe("F1");
    expect(tmuxKeyName("f12")).toBe("F12");
  });

  it("resolves the three colliding byte strings deliberately, not by map order", () => {
    // NAMED_KEYS aliases these bytes (ctrl-m/ctrl-j/ctrl-i); Enter/Tab must always win.
    expect(NAMED_KEYS["ctrl-m"]).toBe("\r");
    expect(NAMED_KEYS["ctrl-j"]).toBe("\n");
    expect(NAMED_KEYS["ctrl-i"]).toBe("\t");
    expect(tmuxKeyForBytes("\r")).toBe("Enter");
    expect(tmuxKeyForBytes("\n")).toBe("Enter");
    expect(tmuxKeyForBytes("\t")).toBe("Tab");
    expect(tmuxKeyForBytes("\x03")).toBe("C-c");
    expect(tmuxKeyForBytes("\x1b[A")).toBe("Up");
    expect(tmuxKeyForBytes("\x1b[3~")).toBe("DC");
    expect(tmuxKeyForBytes("ls -la")).toBeUndefined();
    expect(tmuxKeyForBytes("")).toBeUndefined();
  });
});
