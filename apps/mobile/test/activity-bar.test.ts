import { describe, expect, it } from "vitest";
import { type ActivityInput, activityBar } from "../src/conversation/activity";

const NOW = 1_000_000;
const base: ActivityInput = {
  agentKind: "claude",
  sessionState: "running",
  waiting: false,
  secret: false,
  status: null,
  statusAt: null,
  lastActivityAt: NOW - 1000,
  runningSince: NOW - 12_000,
  now: NOW,
};
const bar = (overrides: Partial<ActivityInput>) => activityBar({ ...base, ...overrides });

describe("activity bar", () => {
  it("shows the agent's own status, its timer ticking on the phone between screen updates", () => {
    const status = { label: "Cogitating…", seconds: 12, detail: "↑ 1.2k tokens" };
    expect(bar({ status, statusAt: NOW })).toEqual({
      kind: "working",
      label: "Cogitating…",
      elapsed: "12s",
      detail: "↑ 1.2k tokens",
    });
    expect(bar({ status, statusAt: NOW - 3000 })).toMatchObject({ elapsed: "15s" });
    // A status without its own timer uses how long the session has been running.
    expect(bar({ status: { ...status, seconds: null }, statusAt: NOW })).toMatchObject({
      elapsed: "12s",
    });
  });

  it("falls back to the session's state when no status line reads", () => {
    expect(bar({})).toEqual({
      kind: "working",
      label: "Claude is working",
      elapsed: "12s",
      detail: null,
    });
    expect(bar({ agentKind: "some thing!", runningSince: null })).toEqual({
      kind: "working",
      label: "The agent is working",
      elapsed: null,
      detail: null,
    });
  });

  it("hides when idle or when nothing changed in the last 5 seconds", () => {
    for (const sessionState of ["finished", "editing", "unknown", undefined])
      expect(bar({ sessionState })).toBeNull();
    expect(bar({ lastActivityAt: NOW - 5001 })).toBeNull();
    expect(bar({ lastActivityAt: null })).toBeNull();
    expect(
      bar({
        lastActivityAt: NOW - 6000,
        status: { label: "Cogitating…", seconds: 3, detail: null },
        statusAt: NOW - 6000,
      }),
    ).toBeNull();
    expect(bar({ lastActivityAt: NOW - 5000 })?.kind).toBe("working");
  });

  it("turns to waiting when the agent waits for you, even without fresh output", () => {
    expect(bar({ waiting: true, lastActivityAt: null })).toEqual({ kind: "waiting" });
  });

  it("is hidden during secret input", () => {
    expect(bar({ secret: true })).toBeNull();
    expect(bar({ secret: true, waiting: true })).toBeNull();
  });
});
