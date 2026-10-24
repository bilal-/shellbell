import { type ConversationMessage, encodeCbor } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendRegistry } from "../src/backends/registry.js";
import type { BackendEvent } from "../src/backends/types.js";
import { ConversationCoordinator } from "../src/conversation/conversation-coordinator.js";
import type { TranscriptFileOptions } from "../src/conversation/transcript-file.js";
import type {
  TranscriptFollower,
  TranscriptPoll,
} from "../src/conversation/transcript-follower.js";

const id = (value: string | number) => String(value).padStart(22, "0");
function fixture() {
  const state = { enabled: true };
  let handler!: (event: BackendEvent) => void;
  const off = vi.fn();
  const readers: Array<{ follower: TranscriptFollower; options: TranscriptFileOptions }> = [];
  /** Polls answered before the default snapshot, in order. */
  const polls: TranscriptPoll[] = [];
  const snapshot = (): TranscriptPoll => ({
    status: "snapshot",
    caughtUp: true,
    discontinuity: 0,
    snapshot: {
      state: "ready",
      entries: [{ id: "private-row", kind: "assistant", text: "Hello" }],
      history: "complete",
      change: "replace",
      revision: 1,
      branch: { kind: "codex" },
    },
  });
  const followers = {
    create: vi.fn((options: TranscriptFileOptions) => {
      const follower: TranscriptFollower = {
        poll: vi.fn(async () => polls.shift() ?? snapshot()),
        confirm: vi.fn(async () => ({ status: "confirmed" as const, caughtUp: true })),
        close: vi.fn(),
        drained: Promise.resolve(),
      };
      readers.push({ follower, options });
      return follower;
    }),
    close: vi.fn(),
  };
  let sequence = 0;
  const coordinator = new ConversationCoordinator({
    backend: {
      on: (next: typeof handler) => {
        handler = next;
        return off;
      },
      conversationReference: vi.fn(async () => null),
    } as unknown as BackendRegistry,
    enabled: () => state.enabled,
    now: () => Date.now(),
    followers,
    locator: { locate: vi.fn(async () => ({ status: "busy" as const })) },
    newId: () => id(++sequence),
    roots: { claude: [], codex: [] },
  });
  const route = (name: string) => {
    const state = { current: true };
    const frames: ConversationMessage[] = [];
    const closed = vi.fn();
    const lease = coordinator.attach({
      current: () => state.current,
      send: (message) => {
        frames.push(message);
        return true;
      },
      background: (producer) => ({
        wake: () => {
          for (let i = 0; i < 10 && producer(); i++);
        },
        close: closed,
      }),
    });
    const receive = (message: ConversationMessage) =>
      lease.receive(message, encodeCbor(message).byteLength + 128);
    const subscribe = () =>
      receive({
        type: "conversation.subscribe",
        subscriptionId: id(name),
        sessionId: `herdr:${name}`,
      });
    return { lease, state, frames, closed, receive, subscribe };
  };
  return {
    coordinator,
    state,
    readers,
    polls,
    followers,
    off,
    route,
    snapshot,
    event: (event: BackendEvent) => handler(event),
  };
}

describe("shared Conversation coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => vi.useRealTimers());

  it("requires owner opt-in and can start before the terminal renderer subscribes", async () => {
    const f = fixture();
    const a = f.route("a");
    try {
      f.state.enabled = false;
      a.subscribe();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.followers.create).not.toHaveBeenCalled();
      expect(a.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "disabled" });
      f.state.enabled = true;
      const b = f.route("b");
      b.subscribe();
      await vi.advanceTimersByTimeAsync(600);
      expect(f.followers.create).toHaveBeenCalledTimes(1);
      expect(b.frames.some((message) => message.type === "conversation.batch")).toBe(true);
      b.lease.focus("herdr:b");
      expect(f.readers[0]!.follower.close).not.toHaveBeenCalled();
    } finally {
      f.coordinator.close();
    }
  });

  it("reads on without the usual pause while a reader is catching up", async () => {
    const f = fixture();
    const a = f.route("a");
    try {
      for (let i = 0; i < 5; i++) f.polls.push({ status: "catching-up", discontinuity: 0 });
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(210);
      expect(f.readers[0]!.follower.poll).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.frames.some((m) => m.type === "conversation.batch")).toBe(true);
    } finally {
      f.coordinator.close();
    }
  });

  it("rotates source work fairly and keeps one subscription per route", async () => {
    const f = fixture();
    const a = f.route("a");
    const b = f.route("b");
    try {
      a.lease.focus("herdr:a");
      b.lease.focus("herdr:b");
      a.subscribe();
      b.subscribe();
      await vi.advanceTimersByTimeAsync(800);
      expect(f.readers).toHaveLength(2);
      expect(a.frames.some((m) => m.type === "conversation.batch")).toBe(true);
      expect(b.frames.some((m) => m.type === "conversation.batch")).toBe(true);
      a.subscribe();
      expect(f.followers.create).toHaveBeenCalledTimes(2);
      a.receive({
        type: "conversation.subscribe",
        subscriptionId: id("next"),
        sessionId: "herdr:a",
      });
      expect(f.readers[0]!.follower.close).toHaveBeenCalledOnce();
      expect(f.readers[1]!.follower.close).not.toHaveBeenCalled();
    } finally {
      f.coordinator.close();
    }
  });

  it("cancels reads immediately on opt-out and fences their late completion", async () => {
    const f = fixture();
    const a = f.route("a");
    try {
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(200);
      let complete!: (result: { status: "confirmed"; caughtUp: boolean }) => void;
      vi.mocked(f.readers[0]!.follower.confirm).mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      await vi.advanceTimersByTimeAsync(200);
      f.state.enabled = false;
      f.coordinator.consentChanged();
      expect(f.readers[0]!.options.enabled()).toBe(false);
      expect(f.readers[0]!.follower.close).toHaveBeenCalledOnce();
      expect(a.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "disabled" });
      complete({ status: "confirmed", caughtUp: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.frames.some((m) => m.type === "conversation.batch")).toBe(false);
    } finally {
      f.coordinator.close();
    }
  });

  it("retires stale routes and closed sessions without reopening their followers", async () => {
    const f = fixture();
    const a = f.route("a");
    const b = f.route("b");
    try {
      a.lease.focus("herdr:a");
      b.lease.focus("herdr:b");
      a.subscribe();
      b.subscribe();
      await vi.advanceTimersByTimeAsync(800);
      a.state.current = false;
      f.event({ type: "session-removed", sessionId: "herdr:b" });
      const clear = b.frames.filter((m) => m.type === "conversation.clear").at(-1)!;
      b.receive({ type: "conversation.cleared", subscriptionId: id("b"), clearId: clear.clearId });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.followers.create).toHaveBeenCalledTimes(2);
      expect(a.closed).toHaveBeenCalledOnce();
      expect(b.frames.filter((m) => m.type === "conversation.batch")).toHaveLength(1);
    } finally {
      f.coordinator.close();
    }
    expect(f.off).toHaveBeenCalledOnce();
    expect(f.followers.close).toHaveBeenCalledOnce();
  });
});
