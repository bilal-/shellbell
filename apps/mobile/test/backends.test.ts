import { stringCells } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import {
  asBackendName,
  backendLabel,
  cursorIsInferred,
  newSessionLabel,
} from "../src/util/backends.js";
import { cjkLines } from "../src/util/fixtures.js";
import { cursorBlinks, sessionEnded, statePill, wantsReply } from "../src/util/session-state.js";

describe("cjk fixture", () => {
  it("declares cell widths that match stringCells", () => {
    for (const line of cjkLines()) {
      for (const r of line.r) {
        expect(r.n ?? Array.from(r.t).length).toBe(stringCells(r.t));
      }
    }
  });
});

describe("backend vocabulary", () => {
  it("labels every shipped backend and passes unknown ones through", () => {
    expect(backendLabel("iterm2")).toBe("iTerm2");
    expect(backendLabel("tmux")).toBe("tmux");
    expect(backendLabel("herdr")).toBe("Herdr");
    expect(backendLabel("kitty")).toBe("kitty");
    expect(newSessionLabel("herdr")).toBe("New Herdr tab");
    expect(newSessionLabel("kitty")).toBe("New kitty session");
  });

  it("only offers create/focus actions for strictly-known backends", () => {
    expect(asBackendName("herdr")).toBe("herdr");
    expect(asBackendName("kitty")).toBeNull();
  });

  it("dims the cursor only for herdr", () => {
    expect(cursorIsInferred("herdr")).toBe(true);
    expect(cursorIsInferred("tmux")).toBe(false);
  });
});

describe("session state vocabulary", () => {
  it("gives blocked its own alert pill", () => {
    expect(statePill("blocked")).toEqual({ label: "blocked", tone: "alert" });
    expect(statePill("running")?.tone).toBe("active");
    expect(statePill("unknown")).toBeNull();
    expect(statePill("compiling")).toEqual({ label: "compiling", tone: "muted" });
  });

  it("shows reply chips while running, blocked, or after an idle/blocked event", () => {
    expect(wantsReply("running", undefined)).toBe(true);
    expect(wantsReply("blocked", undefined)).toBe(true);
    expect(wantsReply("finished", "idle")).toBe(true);
    expect(wantsReply("finished", "blocked")).toBe(true);
    expect(wantsReply("finished", "exit")).toBe(false);
  });

  it("blinks the cursor only while the session is doing something", () => {
    expect(cursorBlinks("running")).toBe(true);
    expect(cursorBlinks("blocked")).toBe(true);
    expect(cursorBlinks("finished")).toBe(false);
  });

  it("treats a session as ended only once a cached view exists and it drops off the list", () => {
    const view = { some: "cached-view" };
    expect(sessionEnded([], "a", view)).toBe(true);
    expect(sessionEnded([{ id: "b" }], "a", view)).toBe(true);
    expect(sessionEnded([{ id: "a" }], "a", view)).toBe(false);
    // No cached view yet: still connecting, not ended — even if the sessions list is empty.
    expect(sessionEnded([], "a", undefined)).toBe(false);
    expect(sessionEnded([{ id: "a" }], "a", undefined)).toBe(false);
  });
});
