import { preferredLaunchTarget, stringCells } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import {
  asBackendName,
  backendLabel,
  creationErrorText,
  cursorIsInferred,
  newSessionLabel,
  sessionCreationOptions,
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
    expect(newSessionLabel("iterm2")).toBe("New iTerm2 tab");
    expect(newSessionLabel("herdr")).toBe("New Herdr session");
    expect(newSessionLabel("kitty")).toBe("New kitty session");
  });

  it("offers only sessions that open on the computer, iTerm2 first", () => {
    const connected = ["iterm2", "tmux", "herdr"].map((name) => ({
      name,
      capabilities: { createSession: true },
    }));
    const targets = [
      { backend: "herdr", host: "ghostty", label: "Ghostty" },
      { backend: "herdr", host: "iterm2", label: "iTerm2" },
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { backend: "tmux", host: "iterm2", label: "iTerm2" },
    ] as const;
    const options = sessionCreationOptions(connected, [], undefined, targets);
    expect(options.map(({ label, backend, host }) => ({ label, backend, host }))).toEqual([
      { label: "New iTerm2 tab", backend: "iterm2", host: undefined },
      { label: "tmux in iTerm2", backend: "tmux", host: "iterm2" },
      { label: "tmux in Ghostty", backend: "tmux", host: "ghostty" },
      { label: "Herdr in iTerm2", backend: "herdr", host: "iterm2" },
      { label: "Herdr in Ghostty", backend: "herdr", host: "ghostty" },
    ]);
    expect(options.map((option) => option.detail)).toEqual([
      "Opens in iTerm2 on your computer.",
      "Opens in iTerm2 on your computer.",
      "Opens in Ghostty on your computer.",
      "Opens in iTerm2 on your computer.",
      "Opens in Ghostty on your computer.",
    ]);
    expect(options.every((option) => option.available)).toBe(true);
  });

  it("offers nothing that would run only on the phone", () => {
    const options = sessionCreationOptions(
      [{ name: "tmux", capabilities: { createSession: true } }],
      ["herdr"],
    );
    expect(options.map((option) => option.label)).toEqual(["New iTerm2 tab"]);
    expect(options[0]?.available).toBe(false);
    // A launch target needs its engine to be connected or startable.
    expect(
      sessionCreationOptions([], [], undefined, [
        { backend: "tmux", host: "iterm2", label: "iTerm2" },
      ]).map((option) => option.label),
    ).toEqual(["New iTerm2 tab"]);
  });

  it("picks iTerm2, then Ghostty, for a session action that names no app", () => {
    const targets = [
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { backend: "tmux", host: "iterm2", label: "iTerm2" },
      { backend: "herdr", host: "ghostty", label: "Ghostty" },
    ];
    expect(preferredLaunchTarget("tmux", targets)?.host).toBe("iterm2");
    expect(preferredLaunchTarget("herdr", targets)?.host).toBe("ghostty");
    expect(preferredLaunchTarget("example", targets)).toBeUndefined();
  });

  it("shows the computer's own refusal text, but not bare error codes", () => {
    expect(creationErrorText("No terminal app on this computer can show a new session.")).toBe(
      "No terminal app on this computer can show a new session.",
    );
    expect(creationErrorText("failed")).toBeUndefined();
    expect(creationErrorText("bad-window")).toBeUndefined();
    expect(creationErrorText(undefined)).toBeUndefined();
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
