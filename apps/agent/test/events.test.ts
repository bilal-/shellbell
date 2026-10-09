import type { CtrlMessage } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import { EventEngine } from "../src/events.js";
import { createLogger } from "../src/log.js";
import { Notifier } from "../src/notifier.js";
import { FakeBackend } from "./fakes/fake-backend.js";

function engine() {
  let t = 1_000_000;
  const now = () => t;
  const e = new EventEngine({
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4000,
    idleMinActiveMs: 1500,
    now,
  });
  const events: string[] = [];
  const rings: string[] = [];
  e.on("event", (ev) =>
    events.push(`${ev.kind}:${ev.sessionId}:${ev.exitCode ?? ""}:${ev.durationMs ?? ""}`),
  );
  e.on("ring", (r) => rings.push(`${r.kind}:${r.sessionId}`));
  /** Advance the clock AND run the 1 s sweep. */
  const advance = (ms: number) => {
    t += ms;
    e.tick();
  };
  /** Advance the clock WITHOUT sweeping — models time passing between ticks. */
  const jump = (ms: number) => {
    t += ms;
  };
  return { e, events, rings, advance, jump, now: () => t };
}

describe("EventEngine", () => {
  it("does not treat accepted password input with no output as activity for idle notifications", async () => {
    const { e, events, rings, advance } = engine();
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend();
    backend.addSession("S", {});
    registry.add(backend);
    registry.on((event) => e.onBackendEvent(event));
    await registry.sendText("iterm2:S", "p");
    advance(2000);
    await registry.sendText("iterm2:S", "w");
    advance(5000);
    expect(events).toEqual([]);
    expect(rings).toEqual([]);
    backend.emit({ type: "screen-changed", sessionId: "S" });
    advance(2000);
    backend.emit({ type: "screen-changed", sessionId: "S" });
    advance(5000);
    expect(events).toEqual(["idle:iterm2:S::2000"]);
    expect(rings).toEqual(["idle:iterm2:S"]);
  });

  it("prompt path: command-end emits prompt event; rings only for long commands", () => {
    const { e, events, rings, advance, now } = engine();
    e.onBackendEvent({ type: "command-start", sessionId: "S", command: "sleep 1", at: now() });
    expect(e.stateOf("S")).toBe("running");
    advance(2000);
    e.onBackendEvent({ type: "command-end", sessionId: "S", exitCode: 0, at: now() });
    expect(events).toEqual(["prompt:S:0:2000"]);
    expect(rings).toEqual([]);
    e.onBackendEvent({ type: "command-start", sessionId: "S", command: "make", at: now() });
    advance(12_000);
    e.onBackendEvent({ type: "command-end", sessionId: "S", exitCode: 2, at: now() });
    expect(events[1]).toBe("prompt:S:2:12000");
    expect(rings).toEqual(["prompt:S"]);
    expect(e.stateOf("S")).toBe("finished");
    e.onBackendEvent({ type: "prompt", sessionId: "S", at: now() });
    expect(e.stateOf("S")).toBe("editing");
  });

  it("idle path: activity ≥1.5 s then quiet ≥4 s → idle event + ring; not while editing; not twice", () => {
    const { e, events, rings, advance } = engine();
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(3000);
    expect(events).toEqual([]);
    advance(1500);
    expect(events).toEqual(["idle:T::2000"]);
    expect(rings).toEqual(["idle:T"]);
    advance(5000);
    expect(events.length).toBe(1);
    // editing suppresses the ring but not the event
    e.onBackendEvent({ type: "prompt", sessionId: "T", at: 0 });
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(5000);
    expect(events.length).toBe(2);
    expect(rings.length).toBe(1);
  });

  it("idle ring is deduped within 5 s of a prompt ring", () => {
    const { e, rings, advance, jump, now } = engine();
    e.onBackendEvent({ type: "command-start", sessionId: "U", command: "x", at: now() });
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    // `jump`, not `advance`: the command is still running, so no sweep may run yet. Ticking here
    // would legitimately fire an idle ring before the command ended.
    jump(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    jump(11_000);
    e.onBackendEvent({ type: "command-end", sessionId: "U", exitCode: 0, at: now() });
    expect(rings).toEqual(["prompt:U"]);

    // The command ended, output resumes, then goes quiet: the idle EVENT fires but the ring is
    // suppressed because the prompt ring is still inside the dedupe window.
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    jump(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    advance(4000);
    expect(rings).toEqual(["prompt:U"]);
  });

  it("exit event on session removal, no ring", () => {
    const { e, events, rings } = engine();
    e.onBackendEvent({ type: "session-removed", sessionId: "V" });
    expect(events).toEqual(["exit:V::"]);
    expect(rings).toEqual([]);
  });

  it("agent-state: blocked rings on a transition, never on the first sighting", () => {
    const { e, events, rings, now } = engine();
    // Bootstrap: the pane is already blocked the first time we see it. State only, no ring.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(e.stateOf("H")).toBe("blocked");
    expect(events).toEqual(["blocked:H::"]);
    expect(rings).toEqual([]);

    // A real transition rings immediately.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    expect(e.stateOf("H")).toBe("running");
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(rings).toEqual(["blocked:H"]);

    // Repeats are no-ops.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(rings).toEqual(["blocked:H"]);
    expect(events).toEqual(["blocked:H::", "blocked:H::"]);
  });

  it("agent-state: a herdr restart re-adopts a blocked pane without ringing", () => {
    // the backend removes every session when its socket dies, so the engine forgets
    // the pane; when herdr comes back the same pane is a FIRST sighting again, even though it
    // was `working` before the restart and is `blocked` after it.
    const { e, rings, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    e.onBackendEvent({ type: "session-removed", sessionId: "H" });
    e.onBackendEvent({ type: "session-added", sessionId: "H" });
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(rings).toEqual([]);
    expect(e.stateOf("H")).toBe("blocked");
  });

  it("agent-state: working -> idle emits prompt, and rings past notifyMinCommandMs", () => {
    const { e, events, rings, jump, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    jump(2000);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "idle", at: now() });
    expect(events).toEqual(["prompt:H::2000"]);
    expect(rings).toEqual([]);
    expect(e.stateOf("H")).toBe("finished");

    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    jump(12_000);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "done", at: now() });
    expect(events[1]).toBe("prompt:H::12000");
    expect(rings).toEqual(["prompt:H"]);
    expect(e.stateOf("H")).toBe("finished");
  });

  it("agent-state: answering a blocked agent neither rings nor emits", () => {
    const { e, events, rings, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    events.length = 0;
    rings.length = 0;
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "idle", at: now() });
    expect(events).toEqual([]);
    expect(rings).toEqual([]);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "unknown", at: now() });
    expect(e.stateOf("H")).toBe("unknown");
  });

  it("agent-state: the idle heuristic does not ring again for the same quiet screen", () => {
    const { e, rings, advance, jump, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    jump(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    jump(11_000);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "idle", at: now() });
    expect(rings).toEqual(["prompt:H"]);
    advance(5000);
    expect(rings).toEqual(["prompt:H"]);
  });

  it("ruling R44: a known agent state suppresses tick()'s idle heuristic entirely", () => {
    const { e, events, rings, advance } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: 0 });
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    advance(3000);
    expect(events).toEqual([]);
    // Past idleQuietMs (4000) since the last screen-changed: the plain idle heuristic would fire
    // here (see the "idle path" test above), but this pane's agent state is known, so it must not.
    advance(1500);
    expect(events).toEqual([]);
    expect(rings).toEqual([]);
  });

  it("ruling R44: an 'unknown' agent state (a herdr shell with no agent) still rings idle", () => {
    const { e, events, rings, advance } = engine();
    // Herdr reports "unknown" for every pane that has no agent attached -- that is not a "known"
    // agent state for R44's purposes, so the plain screen-quiet heuristic must still apply to it.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "unknown", at: 0 });
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    advance(3000);
    expect(events).toEqual([]);
    advance(1500);
    expect(events).toEqual(["idle:H::2000"]);
    expect(rings).toEqual(["idle:H"]);
  });
});

describe("Notifier", () => {
  it("sends notify and rate-limits per session for 60 s", () => {
    let t = 0;
    const sent: CtrlMessage[] = [];
    const n = new Notifier(
      (m) => sent.push(m),
      createLogger({ stdout: false }),
      () => t,
    );
    expect(n.ring({ sessionId: "S", kind: "prompt", exitCode: 0, durationMs: 15_000 })).toBe(true);
    expect(n.ring({ sessionId: "S", kind: "idle" })).toBe(false);
    expect(n.ring({ sessionId: "T", kind: "idle" })).toBe(true);
    t = 61_000;
    expect(n.ring({ sessionId: "S", kind: "idle" })).toBe(true);
    expect(sent[0]).toEqual({
      type: "notify",
      sessionId: "S",
      kind: "prompt",
      exitCode: 0,
      durationMs: 15_000,
    });
  });

  it("forget() drops rate-limit state, and ring() prunes entries older than 60 s", () => {
    let t = 0;
    const n = new Notifier(
      () => {},
      createLogger({ stdout: false }),
      () => t,
    );
    n.ring({ sessionId: "S", kind: "prompt" });
    n.forget("S");
    expect(n.size).toBe(0);
    // forgetting clears the rate limit immediately, even within the 60 s window
    expect(n.ring({ sessionId: "S", kind: "idle" })).toBe(true);

    n.ring({ sessionId: "T", kind: "idle" });
    n.ring({ sessionId: "U", kind: "idle" });
    expect(n.size).toBe(3);
    t = 61_000;
    // ringing a new session prunes every entry older than 60 s, so the map stays bounded
    n.ring({ sessionId: "V", kind: "idle" });
    expect(n.size).toBe(1);
  });

  it("forwards a blocked ring as a notify with kind blocked", () => {
    const sent: CtrlMessage[] = [];
    const n = new Notifier(
      (m) => sent.push(m),
      createLogger({ stdout: false }),
      () => 0,
    );
    expect(n.ring({ sessionId: "herdr:term_a", kind: "blocked" })).toBe(true);
    expect(sent[0]).toEqual({
      type: "notify",
      sessionId: "herdr:term_a",
      kind: "blocked",
      exitCode: undefined,
      durationMs: undefined,
    });
    // The 60 s per-session limit covers blocked exactly like every other kind.
    expect(n.ring({ sessionId: "herdr:term_a", kind: "blocked" })).toBe(false);
  });
});
