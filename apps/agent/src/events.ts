import { EventEmitter } from "node:events";
import type { InnerMessageOf, NotificationPayload, SessionInfo } from "@shellbell/protocol";
import type { AgentState, BackendEvent } from "./backends/types.js";

export interface Ring {
  reason?: NotificationPayload["reason"];
  sessionId: string;
  kind: "prompt" | "idle" | "blocked";
  exitCode?: number;
  durationMs?: number;
}

export interface EventEngineOptions {
  notifyMinCommandMs: number;
  idleQuietMs: number;
  idleMinActiveMs: number;
  now?: () => number;
}

interface S {
  blockedNotified: boolean;
  promptState: SessionInfo["state"];
  commandStartedAt: number | null;
  command: string;
  lastChangeAt: number;
  activeSince: number | null;
  lastPromptRingAt: number;
  /** the last herdr agent state we saw; `null` until the first `agent-state` event. */
  agentState: AgentState | null;
  /** When the agent last entered `working`, for the `prompt` ring's durationMs. */
  workingSince: number | null;
  /** When `promptState` last changed from one known state to another. */
  stateSince: number | null;
}

const PROMPT_DEDUPE_MS = 5000;

export class EventEngine extends EventEmitter<{ event: [InnerMessageOf<"event">]; ring: [Ring] }> {
  private readonly s = new Map<string, S>();
  private readonly now: () => number;

  constructor(private readonly opts: EventEngineOptions) {
    super();
    this.now = opts.now ?? (() => Date.now());
  }

  stateOf(sessionId: string): SessionInfo["state"] {
    return this.s.get(sessionId)?.promptState ?? "unknown";
  }

  /** A known state that changes to another is an observed transition, so it gets a time. */
  private setPromptState(x: S, state: SessionInfo["state"], now: number): void {
    if (x.promptState !== state && x.promptState !== "unknown") x.stateSince = now;
    x.promptState = state;
  }

  /**
   * What the engine knows of a session's activity: when its screen last changed, and whether its
   * terminal reports its agent's state (only then is `blocked` or `running` the agent's own word).
   */
  activityOf(sessionId: string): {
    activeAt?: number;
    stateSince?: number;
    reportsAgentState: boolean;
  } {
    const x = this.s.get(sessionId);
    return {
      ...(x?.lastChangeAt ? { activeAt: x.lastChangeAt } : {}),
      ...(x?.stateSince != null ? { stateSince: x.stateSince } : {}),
      reportsAgentState: x?.agentState != null,
    };
  }

  forget(sessionId: string): void {
    this.s.delete(sessionId);
  }

  private get(id: string): S {
    let x = this.s.get(id);
    if (!x) {
      x = {
        blockedNotified: false,
        promptState: "unknown",
        commandStartedAt: null,
        command: "",
        lastChangeAt: 0,
        activeSince: null,
        lastPromptRingAt: Number.NEGATIVE_INFINITY,
        agentState: null,
        workingSince: null,
        stateSince: null,
      };
      this.s.set(id, x);
    }
    return x;
  }

  onBackendEvent(e: BackendEvent): void {
    const now = this.now();
    switch (e.type) {
      case "screen-changed": {
        const x = this.get(e.sessionId);
        x.lastChangeAt = now;
        x.activeSince ??= now;
        return;
      }
      case "command-start": {
        const x = this.get(e.sessionId);
        this.setPromptState(x, "running", now);
        x.commandStartedAt = now;
        x.command = e.command;
        return;
      }
      case "command-end": {
        const x = this.get(e.sessionId);
        this.setPromptState(x, "finished", now);
        const durationMs = x.commandStartedAt === null ? undefined : now - x.commandStartedAt;
        x.commandStartedAt = null;
        this.emit("event", {
          type: "event",
          sessionId: e.sessionId,
          kind: "prompt",
          exitCode: e.exitCode,
          durationMs,
          command: x.command || undefined,
          at: now,
        });
        if (durationMs !== undefined && durationMs >= this.opts.notifyMinCommandMs) {
          x.lastPromptRingAt = now;
          x.activeSince = null;
          this.emit("ring", {
            reason: "command-finished",
            sessionId: e.sessionId,
            kind: "prompt",
            exitCode: e.exitCode,
            durationMs,
          });
        }
        return;
      }
      case "prompt": {
        const x = this.get(e.sessionId);
        const durationMs = x.commandStartedAt === null ? undefined : now - x.commandStartedAt;
        x.commandStartedAt = null;
        this.setPromptState(x, "editing", now);
        if (durationMs !== undefined && durationMs >= this.opts.notifyMinCommandMs) {
          x.activeSince = null;
          x.lastPromptRingAt = now;
          this.emit("ring", {
            sessionId: e.sessionId,
            kind: "prompt",
            reason: "prompt-returned",
            durationMs,
          });
        }
        return;
      }
      case "agent-state": {
        // Herdr has no command lifecycle at all, so this is the whole prompt story for
        // herdr sessions: `blocked` means "a human is needed now", and working -> idle|done is the
        // analogue of `command-end` (with a duration, but never an exit code).
        const x = this.get(e.sessionId);
        const prev = x.agentState;
        if (prev === e.state) return;
        x.agentState = e.state;
        if (e.state === "working") {
          x.blockedNotified = false;
          this.setPromptState(x, "running", now);
          x.workingSince = now;
          return;
        }
        if (e.state === "blocked") {
          this.setPromptState(x, "blocked", now);
          x.workingSince = null;
          // The screen is about to go quiet while the agent waits: suppress the idle heuristic so
          // one blocked agent cannot produce two rings.
          x.activeSince = null;
          x.lastPromptRingAt = now;
          this.emit("event", { type: "event", sessionId: e.sessionId, kind: "blocked", at: now });
          // `prev === null` means we have never seen this session before: agent start, or a herdr
          // reconnect (which removes and re-adds every pane, dropping this state). Adopt the
          // state, but never ring for history.
          if (prev !== null && !x.blockedNotified)
            this.emit("ring", { sessionId: e.sessionId, kind: "blocked", reason: "agent-blocked" });
          x.blockedNotified = true;
          return;
        }
        if (e.state === "idle" || e.state === "done") {
          this.setPromptState(x, "finished", now);
          const startedAt = x.workingSince;
          x.workingSince = null;
          if (prev !== "working" || startedAt === null) return;
          const durationMs = now - startedAt;
          this.emit("event", {
            type: "event",
            sessionId: e.sessionId,
            kind: "prompt",
            durationMs,
            at: now,
          });
          if (durationMs >= this.opts.notifyMinCommandMs) {
            x.lastPromptRingAt = now;
            x.activeSince = null;
            this.emit("ring", {
              sessionId: e.sessionId,
              kind: "prompt",
              reason: e.state === "done" ? "agent-finished" : "quiet",
              durationMs,
            });
          }
          return;
        }
        x.promptState = "unknown";
        x.stateSince = null;
        x.workingSince = null;
        return;
      }
      case "session-removed": {
        this.s.delete(e.sessionId);
        this.emit("event", { type: "event", sessionId: e.sessionId, kind: "exit", at: now });
        return;
      }
      default:
        return;
    }
  }

  /** Call once per second. */
  tick(): void {
    const now = this.now();
    for (const [id, x] of this.s) {
      // Ruling R44: a session with a KNOWN (non-"unknown") agent state is fully covered by
      // `agent-state` rings (working/blocked/idle/done) -- the screen-quiet heuristic below is for
      // plain shells only, and running it too would risk a second, redundant ring for the same
      // agent pane. A herdr pane that has no agent at all reports "unknown" (never null once seen)
      // and must still get the idle heuristic, just like a plain shell.
      if (x.agentState !== null && x.agentState !== "unknown") continue;
      if (x.activeSince === null) continue;
      if (now - x.lastChangeAt < this.opts.idleQuietMs) continue;
      if (x.lastChangeAt - x.activeSince < this.opts.idleMinActiveMs) {
        x.activeSince = null;
        continue;
      }
      const durationMs = x.lastChangeAt - x.activeSince;
      x.activeSince = null;
      this.emit("event", { type: "event", sessionId: id, kind: "idle", durationMs, at: now });
      const recentlyRang = now - x.lastPromptRingAt < PROMPT_DEDUPE_MS + this.opts.idleQuietMs;
      if (!recentlyRang && x.promptState !== "editing")
        this.emit("ring", { sessionId: id, kind: "idle", reason: "quiet", durationMs });
    }
  }
}
