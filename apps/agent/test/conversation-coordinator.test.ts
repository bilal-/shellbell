import { type ConversationMessage, encodeCbor } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendRegistry } from "../src/backends/registry.js";
import type { BackendEvent } from "../src/backends/types.js";
import { CONVERSATION_RETRY_MS } from "../src/conversation/agent-conversation-stream.js";
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
      for (let i = 0; i < 5; i++)
        f.polls.push({ status: "catching-up", discontinuity: 0, pending: true });
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

  it("waits the usual pause while a reader has nothing new to read", async () => {
    // A Codex file whose first line is still being written has no unread bytes. Re-polling it
    // at once would read and validate the file in a tight loop until the line ends.
    const f = fixture();
    const a = f.route("a");
    try {
      for (let i = 0; i < 50; i++)
        f.polls.push({ status: "catching-up", discontinuity: 0, pending: false });
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(210);
      expect(vi.mocked(f.readers[0]!.follower.poll).mock.calls.length).toBeLessThanOrEqual(2);
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
      // A read still in flight: its proof and result arrive only after the opt-out.
      let complete!: (result: TranscriptPoll) => void;
      const create = f.followers.create.getMockImplementation()!;
      f.followers.create.mockImplementationOnce((options) => {
        const follower = create(options);
        vi.mocked(follower.poll).mockReturnValueOnce(
          new Promise((resolve) => {
            complete = resolve;
          }),
        );
        return follower;
      });
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(200);
      f.state.enabled = false;
      f.coordinator.consentChanged();
      expect(f.readers[0]!.options.enabled()).toBe(false);
      expect(f.readers[0]!.follower.close).toHaveBeenCalledOnce();
      expect(a.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "disabled" });
      complete(f.snapshot());
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.frames.some((m) => m.type === "conversation.batch")).toBe(false);
    } finally {
      f.coordinator.close();
    }
  });

  it("replaces a resynchronised source with the clear and then at once its first page", async () => {
    const f = fixture();
    const a = f.route("a");
    try {
      let settled = true;
      let text = "Hello";
      const snapshot = (): TranscriptPoll => {
        const base = f.snapshot();
        if (base.status !== "snapshot") throw new Error("fixture");
        return {
          ...base,
          snapshot: { ...base.snapshot, entries: [{ id: "row", kind: "assistant", text }] },
        };
      };
      const create = f.followers.create.getMockImplementation()!;
      f.followers.create.mockImplementation((options) => {
        const follower = create(options);
        // While Herdr resynchronises, it withholds proof: the reader stops unbound.
        vi.mocked(follower.poll).mockImplementation(async () =>
          settled ? snapshot() : { status: "stopped", reason: "unbound" },
        );
        return follower;
      });
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(400);
      const generations = () =>
        a.frames.flatMap((m) => (m.type === "conversation.batch" ? [m.generation] : []));
      expect(generations()).toHaveLength(1);

      // A, then B, then A again with the same native IDs and the same rows: each change ends
      // the generation, and each new one is new.
      for (const next of ["Other", "Hello"]) {
        const batch = a.frames.filter((m) => m.type === "conversation.batch").at(-1)!;
        a.receive({
          type: "conversation.applied",
          subscriptionId: id("a"),
          generation: batch.generation,
          batchId: batch.batchId,
          revision: batch.revision,
          oldestId: batch.entries[0]!.id,
          newestId: batch.entries.at(-1)!.id,
          retainedCount: batch.entries.length,
        });
        settled = false;
        text = next;
        f.event({ type: "conversation-changed", sessionId: "herdr:a" });
        await vi.advanceTimersByTimeAsync(0);
        const clearAt = a.frames.length - 1;
        const clear = a.frames[clearAt]!;
        if (clear.type !== "conversation.clear") throw new Error(`expected a clear: ${clear.type}`);
        expect(clear.reason).toBe("changed");
        a.receive({
          type: "conversation.cleared",
          subscriptionId: id("a"),
          clearId: clear.clearId,
        });
        await vi.advanceTimersByTimeAsync(300);
        const clearedAt = Date.now();
        settled = true;
        f.event({ type: "conversation-settled" });
        await vi.advanceTimersByTimeAsync(0);
        const after = a.frames.slice(clearAt + 1);
        // No Checking or Unavailable in between: the next conversation frame is the new page.
        expect(after[0]).toMatchObject({ type: "conversation.batch", operation: "reset" });
        expect(after[0]).toMatchObject({ entries: [{ text: next }] });
        expect(Date.now() - clearedAt).toBeLessThan(CONVERSATION_RETRY_MS);
      }
      expect(new Set(generations()).size).toBe(3);
    } finally {
      f.coordinator.close();
    }
  });

  it("ends an idle reader's generation when a fresh proof outside it finds another conversation", async () => {
    const f = fixture();
    const a = f.route("a");
    try {
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(400);
      expect(a.frames.some((m) => m.type === "conversation.batch")).toBe(true);
      f.coordinator.sessionChanged("herdr:other");
      expect(a.frames.some((m) => m.type === "conversation.clear")).toBe(false);
      f.coordinator.sessionChanged("herdr:a");
      await vi.advanceTimersByTimeAsync(0);
      expect(a.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
      expect(f.readers[0]!.follower.close).toHaveBeenCalled();
    } finally {
      f.coordinator.close();
    }
  });

  it("never delivers a read that finishes after its source changed", async () => {
    const f = fixture();
    const a = f.route("a");
    try {
      a.lease.focus("herdr:a");
      a.subscribe();
      await vi.advanceTimersByTimeAsync(400);
      const follower = f.readers[0]!.follower;
      let late!: (poll: TranscriptPoll) => void;
      vi.mocked(follower.confirm).mockResolvedValue({ status: "changed" });
      vi.mocked(follower.poll).mockReturnValueOnce(
        new Promise((resolve) => {
          late = resolve;
        }),
      );
      const batch = a.frames.filter((m) => m.type === "conversation.batch").at(-1)!;
      a.receive({
        type: "conversation.applied",
        subscriptionId: id("a"),
        generation: batch.generation,
        batchId: batch.batchId,
        revision: batch.revision,
        oldestId: batch.entries[0]!.id,
        newestId: batch.entries.at(-1)!.id,
        retainedCount: batch.entries.length,
      });
      await vi.advanceTimersByTimeAsync(1200);
      expect(late).toBeDefined();
      f.event({ type: "conversation-changed", sessionId: "herdr:a" });
      const before = a.frames.filter((m) => m.type === "conversation.batch").length;
      late({
        status: "snapshot",
        caughtUp: true,
        discontinuity: 0,
        snapshot: {
          state: "ready",
          entries: [{ id: "stale", kind: "assistant", text: "Stale" }],
          history: "complete",
          change: "replace",
          revision: 9,
          branch: { kind: "codex" },
        },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.frames.filter((m) => m.type === "conversation.batch")).toHaveLength(before);
      expect(JSON.stringify(a.frames)).not.toContain("Stale");
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

describe("a chat's own id on its rows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => vi.useRealTimers());

  async function run() {
    const session = "11111111-1111-4111-8111-111111111111";
    const reference = {
      agent: "claude" as const,
      kind: "id" as const,
      value: session,
      owner: "o1",
    };
    const chatId = vi.fn(() => "chat-of-these-rows");
    let sequence = 0;
    const coordinator = new ConversationCoordinator({
      backend: {
        on: () => () => {},
        conversationReference: vi.fn(async () => ({ ...reference })),
      } as unknown as BackendRegistry,
      enabled: () => true,
      now: () => Date.now(),
      followers: {
        // Like a real reader: its first poll proves ownership through the identity port.
        create: (options: TranscriptFileOptions) => ({
          poll: async (): Promise<TranscriptPoll> => {
            await options.identity(new AbortController().signal);
            return {
              status: "snapshot",
              caughtUp: true,
              discontinuity: 0,
              snapshot: {
                state: "ready",
                entries: [{ id: "row", kind: "assistant", text: "Hello" }],
                history: "complete",
                change: "replace",
                revision: 1,
                branch: { kind: "claude", nodes: [{ id: "n", start: 0 }] },
                queued: [{ text: "Next" }],
              },
            };
          },
          confirm: async () => ({ status: "confirmed" as const, caughtUp: true }),
          close: () => {},
          drained: Promise.resolve(),
          // The reference its open file was proved from.
          reference,
        }),
        close: () => {},
      },
      locator: {
        locate: vi.fn(async () => ({
          status: "candidate" as const,
          candidate: { agent: "claude" as const, path: `/test/${session}.jsonl`, session },
        })),
      },
      newId: () => id(++sequence),
      roots: { claude: [], codex: [] },
      chat: { idFor: chatId, knownId: chatId },
    });
    const frames: ConversationMessage[] = [];
    const lease = coordinator.attach({
      current: () => true,
      send: (message) => {
        frames.push(message);
        return true;
      },
      background: (producer) => ({
        wake: () => {
          for (let i = 0; i < 10 && producer(); i++);
        },
        close: () => {},
      }),
    });
    const message: ConversationMessage = {
      type: "conversation.subscribe",
      subscriptionId: id("a"),
      sessionId: "herdr:a",
    };
    lease.receive(message, encodeCbor(message).byteLength + 128);
    await vi.advanceTimersByTimeAsync(400);
    coordinator.close();
    const ready = frames.find(
      (m): m is Extract<ConversationMessage, { type: "conversation.status" }> =>
        m.type === "conversation.status" && m.state === "ready",
    );
    return { ready, chatId, reference };
  }

  it("names the chat its rows were proved from", async () => {
    const { ready, chatId, reference } = await run();
    expect(chatId).toHaveBeenCalledWith("herdr:a", expect.objectContaining(reference));
    expect(ready).toMatchObject({ chat: "chat-of-these-rows", queued: [{ text: "Next" }] });
  });
});
