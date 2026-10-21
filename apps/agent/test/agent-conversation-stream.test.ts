import {
  CONVERSATION_LIMITS,
  type ConversationBatch,
  type ConversationMessage,
  encodeCbor,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentConversationStream } from "../src/conversation/agent-conversation-stream.js";
import type { ConversationSnapshot } from "../src/conversation/transcript-document.js";
import type {
  TranscriptFollower,
  TranscriptPoll,
} from "../src/conversation/transcript-follower.js";

const id = (value: number | string) => String(value).padStart(22, "0");
const row = (index: number) => ({
  id: `private-row-${index}`,
  kind: "assistant" as const,
  text: `Reply ${index}`,
});
function snapshot(count: number, revision = 1): ConversationSnapshot {
  return {
    state: "ready",
    entries: Array.from({ length: count }, (_, i) => row(i)),
    history: "complete",
    change: "replace",
    revision,
    branch: {
      kind: "claude",
      nodes: Array.from({ length: count || 1 }, (_, i) => ({
        id: `private-node-${i}`,
        start: i * 100,
      })),
    },
  };
}
function fixture(count = 100) {
  const state = {
    now: 1,
    enabled: true,
    snapshot: snapshot(count),
    discontinuity: 0,
    send: (_message: ConversationMessage) => true,
  };
  const frames: ConversationMessage[] = [];
  const follower: TranscriptFollower = {
    poll: vi.fn(
      async (): Promise<TranscriptPoll> => ({
        status: "snapshot",
        snapshot: state.snapshot,
        discontinuity: state.discontinuity,
        caughtUp: true,
      }),
    ),
    confirm: vi.fn(async () => ({ status: "confirmed" as const, caughtUp: true })),
    close: vi.fn(),
    drained: Promise.resolve(),
  };
  let sequence = 0;
  const follow = vi.fn(() => follower);
  const source = new AgentConversationStream({
    subscriptionId: id("sub"),
    sessionId: "herdr:pane",
    now: () => state.now,
    newId: () => id(++sequence),
    enabled: () => state.enabled,
    follow,
    wake: vi.fn(),
    send: (message) => {
      frames.push(message);
      return state.send(message);
    },
  });
  const drain = () => {
    for (let i = 0; i < 10 && source.offer(); i++);
  };
  const step = async () => {
    state.now += 1000;
    source.tick();
    await source.work();
    drain();
  };
  const receive = (message: ConversationMessage) =>
    source.receive(message, encodeCbor(message).byteLength + 128);
  const batches = () =>
    frames.filter((m): m is ConversationBatch => m.type === "conversation.batch");
  let retained: string[] = [];
  const acknowledge = (batch = batches().at(-1)!) => {
    if (batch.operation === "reset") retained = batch.entries.map((e) => e.id);
    else if (batch.operation === "prepend")
      retained = [...batch.entries.map((e) => e.id), ...retained];
    else
      retained = [
        ...retained.slice(0, batch.anchor === null ? 0 : retained.indexOf(batch.anchor!) + 1),
        ...batch.entries.map((e) => e.id),
        ...(batch.after ? retained.slice(retained.indexOf(batch.after)) : []),
      ];
    retained = retained.slice(-CONVERSATION_LIMITS.retainedEntries);
    receive({
      type: "conversation.applied",
      subscriptionId: id("sub"),
      generation: batch.generation,
      batchId: batch.batchId,
      revision: batch.revision,
      oldestId: retained[0] ?? null,
      newestId: retained.at(-1) ?? null,
      retainedCount: retained.length,
    });
  };
  const clearAck = () => {
    const clear = frames.filter((m) => m.type === "conversation.clear").at(-1)!;
    receive({ type: "conversation.cleared", subscriptionId: id("sub"), clearId: clear.clearId });
  };
  return {
    state,
    source,
    follower,
    follow,
    frames,
    step,
    drain,
    receive,
    batches,
    acknowledge,
    clearAck,
  };
}

describe("owned Conversation source", () => {
  it("retries a missing identity after a bounded delay instead of requiring manual refresh", async () => {
    const f = fixture(3);
    vi.mocked(f.follower.poll).mockResolvedValueOnce({ status: "stopped", reason: "unbound" });
    await f.step();
    expect(f.frames.at(-1)).toMatchObject({ state: "unavailable", reason: "unbound" });
    for (let i = 0; i < 4; i++) await f.step();
    expect(f.follow).toHaveBeenCalledTimes(1);
    await f.step();
    expect(f.follow).toHaveBeenCalledTimes(2);
    await f.step();
    expect(f.batches()).toHaveLength(1);
    f.source.close();
  });

  it("describes a reordered loaded range as changed rather than skipped", async () => {
    const f = fixture(100);
    await f.step();
    await f.step();
    f.acknowledge();
    const entries = [...f.state.snapshot.entries];
    [entries[36], entries[37]] = [entries[37]!, entries[36]!];
    f.state.snapshot = { ...snapshot(100, 2), entries };
    await f.step();
    await f.step();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
    f.source.close();
  });

  it("reports prolonged shared-reader contention and recovers without clearing loaded rows", async () => {
    const f = fixture(3);
    await f.step();
    await f.step();
    f.acknowledge();
    const liveFrames = f.frames.length;
    vi.mocked(f.follower.poll).mockResolvedValueOnce({ status: "busy" });
    f.state.now += CONVERSATION_LIMITS.progressMs;
    await f.step();
    expect(f.frames.slice(liveFrames)).toContainEqual({
      type: "conversation.status",
      subscriptionId: id("sub"),
      state: "checking",
      reason: "busy",
    });
    await f.step();
    await f.step();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.status", state: "ready" });
    expect(f.frames.some((message) => message.type === "conversation.clear")).toBe(false);
    expect(f.batches()).toHaveLength(1);
    f.source.close();
  });

  it("updates a growing old group without removing the visible latest reply", async () => {
    const f = fixture(100);
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    f.state.snapshot = {
      ...snapshot(100, 2),
      entries: snapshot(100).entries.map((entry, i) =>
        i === 40 ? { ...entry, text: "Updated group" } : entry,
      ),
    };
    await f.step();
    await f.step();
    const patch = f.batches().at(-1)!;
    expect(patch).toMatchObject({
      operation: "patch",
      anchor: initial.entries[3]!.id,
      after: initial.entries[5]!.id,
      entries: [{ text: "Updated group" }],
    });
    f.acknowledge();
    expect(f.frames.some((message) => message.type === "conversation.clear")).toBe(false);
    f.source.close();
  });

  it("delivers new leading notices and removes superseded leading rows in complete history", async () => {
    const f = fixture(3);
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    f.state.snapshot = {
      ...snapshot(3, 2),
      entries: [{ id: "notice", kind: "unsupported", text: "New notice" }, ...snapshot(3).entries],
    };
    await f.step();
    await f.step();
    expect(f.batches().at(-1)).toMatchObject({
      anchor: null,
      after: initial.entries[0]!.id,
      entries: [{ text: "New notice" }],
    });
    f.acknowledge();
    f.state.snapshot = snapshot(3, 3);
    await f.step();
    await f.step();
    expect(f.batches().at(-1)).toMatchObject({
      anchor: null,
      after: initial.entries[0]!.id,
      entries: [],
    });
    f.source.close();
  });

  it("clears an appended ancestor rewrite even when the newest leaf is unchanged", async () => {
    const f = fixture(3);
    await f.step();
    await f.step();
    f.acknowledge();
    f.state.snapshot = {
      ...snapshot(3, 2),
      branch: {
        kind: "claude",
        nodes: [
          { id: "private-node-0", start: 800 },
          { id: "private-node-1", start: 100 },
          { id: "private-node-2", start: 200 },
        ],
      },
    };
    await f.step();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
    f.source.close();
  });

  it.each(["catching-up", "changed"])(
    "preserves the conversation when a history request follows %s",
    async (state) => {
      const f = fixture(100);
      await f.step();
      await f.step();
      f.acknowledge();
      const initial = f.batches()[0]!;
      if (state === "catching-up") {
        vi.mocked(f.follower.poll).mockResolvedValueOnce({
          status: "catching-up",
          discontinuity: 0,
        });
        await f.step();
      } else vi.mocked(f.follower.confirm).mockResolvedValueOnce({ status: "changed" });
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: initial.generation,
        requestId: id("history"),
        cursor: initial.olderCursor!,
      });
      f.state.snapshot = snapshot(101, 2);
      await f.step();
      await f.step();
      await f.step();
      expect(f.frames.some((message) => message.type === "conversation.clear")).toBe(false);
      expect(f.batches().at(-1)?.operation).toBe("prepend");
      f.source.close();
    },
  );

  it("keeps a completed history outcome through delayed status delivery and retries", async () => {
    const f = fixture(100);
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    f.state.snapshot = { ...snapshot(100, 2), entries: snapshot(100).entries.slice(36) };
    await f.step();
    f.state.send = () => false;
    const request = {
      type: "conversation.history.get" as const,
      subscriptionId: id("sub"),
      generation: initial.generation,
      requestId: id("history"),
      cursor: initial.olderCursor!,
    };
    f.receive(request);
    await f.step();
    await f.step();
    await f.step();
    f.state.send = () => true;
    f.drain();
    f.receive(request);
    f.drain();
    const results = f.frames.filter((message) => message.type === "conversation.history.end");
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((message) => message.reason === "complete")).toBe(true);
    f.source.close();
  });

  it("preserves a stronger clear reason that arrives after the first clear was sent", async () => {
    const f = fixture(1);
    f.source.invalidate("changed");
    f.drain();
    f.source.invalidate("ended");
    f.drain();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
    f.clearAck();
    f.drain();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "ended" });
    f.clearAck();
    await f.step();
    expect(f.follow).not.toHaveBeenCalled();
    f.source.close();
  });

  it("never reports clipped source projection history as complete", async () => {
    const f = fixture(1000);
    f.state.snapshot = {
      ...f.state.snapshot,
      entries: f.state.snapshot.entries.map((entry) => ({ ...entry, text: "x".repeat(400) })),
    };
    await f.step();
    await f.step();
    let batch = f.batches().at(-1)!;
    f.acknowledge(batch);
    for (let page = 0; batch.olderCursor && page < 30; page++) {
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: batch.generation,
        requestId: id(`page${page}`),
        cursor: batch.olderCursor,
      });
      await f.step();
      batch = f.batches().at(-1)!;
      f.acknowledge(batch);
    }
    expect(batch.olderCursor).toBeNull();
    expect(batch.history).toBe("truncated");
    f.source.close();
  });
  it("sends newest rows first, pages older on demand, and retains loaded rows through a live suffix", async () => {
    const f = fixture();
    await f.step();
    await f.step();
    const initial = f.batches()[0]!;
    expect(initial.entries.map((e) => e.text)).toEqual(
      Array.from({ length: 64 }, (_, i) => `Reply ${36 + i}`),
    );
    expect(initial.olderCursor).toBeTruthy();
    expect(JSON.stringify(f.frames)).not.toContain("private-");
    f.acknowledge();
    f.receive({
      type: "conversation.history.get",
      subscriptionId: id("sub"),
      generation: initial.generation,
      requestId: id("history"),
      cursor: initial.olderCursor!,
    });
    await f.step();
    const older = f.batches().at(-1)!;
    expect(older.operation).toBe("prepend");
    expect(older.entries).toHaveLength(36);
    expect(older.history).toBe("complete");
    f.acknowledge();
    f.state.snapshot = snapshot(101, 2);
    await f.step();
    await f.step();
    const live = f.batches().at(-1)!;
    expect(live).toMatchObject({
      operation: "patch",
      anchor: initial.entries.at(-1)!.id,
      entries: [{ text: "Reply 100" }],
      revision: 3,
    });
    expect(live).not.toHaveProperty("olderCursor");
    f.source.close();
  });

  it("waits for applied ACK, revalidates retransmission, and rejects invented retained boundaries", async () => {
    const f = fixture(3);
    await f.step();
    await f.step();
    const batch = f.batches()[0]!;
    await f.step();
    expect(f.batches()).toHaveLength(1);
    f.state.now += CONVERSATION_LIMITS.progressMs;
    await f.step();
    expect(f.batches()).toEqual([batch, batch]);
    expect(f.follower.confirm).toHaveBeenCalledTimes(2);
    f.receive({
      type: "conversation.applied",
      subscriptionId: id("sub"),
      generation: batch.generation,
      batchId: batch.batchId,
      revision: 1,
      oldestId: id("invented"),
      newestId: batch.entries.at(-1)!.id,
      retainedCount: 3,
    });
    f.drain();
    expect(f.frames.at(-1)?.type).toBe("conversation.clear");
    expect(f.follower.close).toHaveBeenCalled();
  });

  it("requires clear acknowledgement before a replacement branch can send records", async () => {
    const f = fixture(3);
    await f.step();
    await f.step();
    f.acknowledge();
    f.state.snapshot = {
      ...snapshot(3, 2),
      branch: { kind: "claude", nodes: [{ id: "other-branch", start: 900 }] },
    };
    await f.step();
    const clear = f.frames.at(-1)!;
    expect(clear.type).toBe("conversation.clear");
    await f.step();
    expect(f.batches()).toHaveLength(1);
    f.receive({ type: "conversation.cleared", subscriptionId: id("sub"), clearId: id("stale") });
    await f.step();
    expect(f.batches()).toHaveLength(1);
    f.clearAck();
    await f.step();
    await f.step();
    expect(f.batches()).toHaveLength(2);
    expect(f.batches()[1]!.generation).not.toBe(f.batches()[0]!.generation);
    f.source.close();
  });

  it("does not treat ordinary source-window eviction as a branch replacement", async () => {
    const f = fixture(100);
    await f.step();
    await f.step();
    f.acknowledge();
    const next = snapshot(101, 2);
    f.state.snapshot = {
      ...next,
      entries: next.entries.slice(60),
      history: "truncated",
      branch: {
        kind: "claude",
        nodes: [
          { id: "private-node-99", start: 9900 },
          { id: "private-node-100", start: 10000 },
        ],
      },
    };
    await f.step();
    await f.step();
    expect(f.frames.some((m) => m.type === "conversation.clear")).toBe(false);
    expect(f.batches().at(-1)).toMatchObject({
      operation: "patch",
      entries: [{ text: "Reply 100" }],
    });
    f.source.close();
  });

  it("drops queued records synchronously on opt-out and never revives a late confirmation", async () => {
    const f = fixture(3);
    await f.step();
    let resolve!: (value: { status: "confirmed"; caughtUp: boolean }) => void;
    vi.mocked(f.follower.confirm).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    f.state.now += 1000;
    const pending = f.source.work();
    f.state.enabled = false;
    f.source.invalidate("disabled");
    resolve({ status: "confirmed", caughtUp: true });
    await pending;
    f.drain();
    expect(f.batches()).toHaveLength(0);
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "disabled" });
    f.clearAck();
    await f.step();
    expect(f.follow).toHaveBeenCalledTimes(1);
    f.source.close();
  });

  it("expires the delivery proof while waiting for scheduler budget", async () => {
    const f = fixture(1);
    await f.step();
    f.state.now += 1000;
    await f.source.work();
    f.state.now += 201;
    f.drain();
    expect(f.batches()).toHaveLength(0);
    await f.step();
    expect(f.batches()).toHaveLength(1);
    expect(f.follower.confirm).toHaveBeenCalledTimes(2);
    f.source.close();
  });

  it("coalesces repeated refreshes behind the latest clear", async () => {
    const f = fixture(1);
    f.receive({ type: "conversation.refresh", subscriptionId: id("sub") });
    f.drain();
    const first = f.frames.at(-1)!;
    f.receive({ type: "conversation.refresh", subscriptionId: id("sub") });
    f.drain();
    expect(f.frames.at(-1)).toEqual(first);
    expect(f.follow).not.toHaveBeenCalled();
    f.source.close();
  });

  it("fits large rows and opaque cursor overhead into every atomic envelope", async () => {
    const f = fixture(3);
    f.state.snapshot = {
      ...f.state.snapshot,
      entries: f.state.snapshot.entries.map((entry) => ({
        ...entry,
        text: "x".repeat(16_384),
        detail: "y".repeat(8192),
      })),
    };
    await f.step();
    await f.step();
    expect(f.batches()).toHaveLength(1);
    expect(f.batches()[0]!.entries).toHaveLength(1);
    expect(encodeCbor(f.batches()[0]).byteLength).toBeLessThanOrEqual(
      CONVERSATION_LIMITS.batchBytes,
    );
    f.source.close();
  });
});
