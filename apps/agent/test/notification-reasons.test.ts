import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { EventEngine, type Ring } from "../src/events.js";

describe("evidence-backed ring reasons", () => {
  it("distinguishes a command exit, bare prompt, agent done and quiet", () => {
    let now = 0;
    const e = new EventEngine({ ...defaultConfig(), notifyMinCommandMs: 1000, now: () => now });
    const rings: Ring[] = [];
    e.on("ring", (r) => rings.push(r));
    e.onBackendEvent({
      type: "command-start",
      sessionId: "exit",
      command: "private command",
      at: now,
    });
    e.onBackendEvent({
      type: "command-start",
      sessionId: "prompt",
      command: "private command",
      at: now,
    });
    e.onBackendEvent({ type: "agent-state", sessionId: "done", state: "working", at: now });
    e.onBackendEvent({ type: "agent-state", sessionId: "idle", state: "working", at: now });
    now = 2000;
    e.onBackendEvent({ type: "command-end", sessionId: "exit", exitCode: 2, at: now });
    e.onBackendEvent({ type: "prompt", sessionId: "exit", at: now });
    e.onBackendEvent({ type: "prompt", sessionId: "prompt", at: now });
    e.onBackendEvent({ type: "agent-state", sessionId: "done", state: "done", at: now });
    e.onBackendEvent({ type: "agent-state", sessionId: "idle", state: "idle", at: now });
    expect(rings.map((r) => [r.sessionId, r.reason])).toEqual([
      ["exit", "command-finished"],
      ["prompt", "prompt-returned"],
      ["done", "agent-finished"],
      ["idle", "quiet"],
    ]);
    expect(JSON.stringify(rings)).not.toContain("private command");
  });
  it("does not ring blocked again after unknown/idle until work resumes", () => {
    const e = new EventEngine({ ...defaultConfig(), now: () => 1 });
    const rings: Ring[] = [];
    e.on("ring", (r) => rings.push(r));
    for (const state of [
      "working",
      "blocked",
      "unknown",
      "blocked",
      "idle",
      "blocked",
      "working",
      "blocked",
    ] as const)
      e.onBackendEvent({ type: "agent-state", sessionId: "agent", state, at: 1 });
    expect(rings.map((r) => r.reason)).toEqual(["agent-blocked", "agent-blocked"]);
  });
  it.each([undefined, 4000])(
    "uses a 30-second default and preserves an explicit %s override",
    (override) => {
      let now = 0;
      const options = {
        ...defaultConfig(),
        ...(override ? { idleQuietMs: override } : {}),
        now: () => now,
      };
      const e = new EventEngine(options);
      const rings: Ring[] = [];
      e.on("ring", (r) => rings.push(r));
      e.onBackendEvent({ type: "screen-changed", sessionId: "quiet" });
      now = 2000;
      e.onBackendEvent({ type: "screen-changed", sessionId: "quiet" });
      now += (override ?? 30_000) - 1;
      e.tick();
      expect(rings).toHaveLength(0);
      now++;
      e.tick();
      expect(rings).toMatchObject([{ reason: "quiet" }]);
    },
  );
});
