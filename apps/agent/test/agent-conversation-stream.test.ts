import { createHash } from "node:crypto";
import {
  CONVERSATION_LIMITS,
  type ConversationBatch,
  type ConversationMessage,
  ConversationMessageSchema,
  encodeCbor,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentConversationStream } from "../src/conversation/agent-conversation-stream.js";
import type {
  ConversationSnapshot,
  TranscriptPageAnchor,
} from "../src/conversation/transcript-document.js";
import type {
  TranscriptFollower,
  TranscriptOlder,
  TranscriptPoll,
} from "../src/conversation/transcript-follower.js";

const id = (value: number | string) => String(value).padStart(22, "0");
vi.mock("node:crypto", { spy: true });
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
function fixture(
  count = 100,
  chat?: { id?: () => string | undefined; known?: () => string | undefined },
) {
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
    ...(chat && {
      chat: { adopt: () => chat.id?.(), known: () => (chat.known ?? chat.id)?.() },
    }),
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
  it("reuses idle wire projections while still polling and confirming source ownership", async () => {
    const f = fixture(1000);
    let acknowledged = 0;
    for (let i = 0; i < 100; i++) {
      await f.step();
      if (f.batches().length > acknowledged) {
        f.acknowledge();
        acknowledged = f.batches().length;
      }
    }
    const before = vi.mocked(createHash).mock.calls.length;
    const polls = vi.mocked(f.follower.poll).mock.calls.length;
    const confirms = vi.mocked(f.follower.confirm).mock.calls.length;
    f.state.snapshot = { ...f.state.snapshot, revision: 2, change: "unchanged" };
    for (let i = 0; i < 3; i++) await f.step();
    expect(vi.mocked(createHash).mock.calls.length - before).toBe(0);
    // A follower without a cheap idle check is polled, and each poll proves itself; nothing
    // is proved again just to say the source is still there.
    expect(vi.mocked(f.follower.poll).mock.calls.length).toBeGreaterThan(polls);
    expect(vi.mocked(f.follower.confirm).mock.calls.length).toBe(confirms);
    expect(f.batches()).toHaveLength(acknowledged);

    f.state.snapshot = snapshot(1001, 3);
    await f.step();
    await f.step();
    expect(
      f
        .batches()
        .at(-1)!
        .entries.map((entry) => entry.text),
    ).toContain("Reply 1000");
    f.source.close();
  });
  it.each(["applied", "projected"])(
    "rejects an older page already contradicted by the %s live branch",
    async (stage) => {
      const f = fixture(3);
      const live = f.state.snapshot.branch!;
      if (live.kind !== "claude") throw new Error("Expected Claude fixture");
      const rewritten = {
        kind: "claude" as const,
        nodes: [{ id: "hidden", start: 9000 }, ...live.nodes],
      };
      f.state.snapshot = {
        ...f.state.snapshot,
        history: "unloaded",
        ...(stage === "applied" && { branch: rewritten }),
      };
      const anchor: TranscriptPageAnchor = {
        agent: "claude",
        start: 0,
        end: 100,
        recordHash: "proof",
        entryHash: "proof",
        entryId: "private-row-0",
        nodeId: "native-0",
      };
      f.follower.anchor = () => anchor;
      f.follower.older = async () => ({
        status: "page",
        entries: [{ entry: row(-1), anchor: null }],
        history: "complete",
        branch: { kind: "claude", nodes: [{ id: "hidden", start: 42 }] },
      });
      await f.step();
      await f.step();
      f.acknowledge();
      const initial = f.batches()[0]!;
      if (stage === "projected") {
        f.state.snapshot = { ...f.state.snapshot, revision: 2, branch: rewritten };
        await f.step();
      }
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: initial.generation,
        requestId: id("older"),
        cursor: initial.olderCursor!,
      });
      await f.step();
      expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
      expect(f.batches()).toHaveLength(1);
      f.source.close();
    },
  );

  it("keeps reading a long older page without waiting between reads", async () => {
    const f = fixture(3);
    f.state.snapshot = { ...f.state.snapshot, history: "unloaded" };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = () => anchor;
    let reads = 0;
    f.follower.older = vi.fn(async () => {
      reads++;
      return { status: "reading" as const };
    });
    await f.step();
    await f.step();
    f.acknowledge();
    f.receive({
      type: "conversation.history.get",
      subscriptionId: id("sub"),
      generation: f.batches()[0]!.generation,
      requestId: id("older"),
      cursor: f.batches()[0]!.olderCursor!,
    });
    await f.step();
    expect(reads).toBe(1);
    // Without the clock moving, the next read is due at once.
    expect(f.source.needsWork).toBe(true);
    await f.source.work();
    expect(reads).toBe(2);
    f.source.close();
  });

  it("stops physical paging at the private ancestor budget without clearing loaded rows", async () => {
    const f = fixture(3);
    f.state.snapshot = { ...f.state.snapshot, history: "unloaded" };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = () => anchor;
    let page = 0;
    f.follower.older = async () => {
      const offset = page++ * 2048;
      return {
        status: "page",
        entries: [{ entry: row(-page), anchor }],
        history: "unloaded",
        more: true,
        branch: {
          kind: "claude",
          nodes: Array.from({ length: 2048 }, (_, i) => ({
            id: `older-${offset + i}`,
            start: offset + i,
          })),
        },
      };
    };
    await f.step();
    await f.step();
    f.acknowledge();
    for (let i = 0; i < 3; i++) {
      const previous = f.batches().at(-1)!;
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: previous.generation,
        requestId: id(`older-${i}`),
        cursor: previous.olderCursor!,
      });
      await f.step();
      if (i < 2) f.acknowledge();
    }
    expect(f.batches()).toHaveLength(3);
    expect(f.frames.at(-1)).toMatchObject({
      type: "conversation.history.end",
      reason: "unavailable",
    });
    expect(f.frames.some((message) => message.type === "conversation.clear")).toBe(false);
    f.source.close();
  });

  it.each(["old-root", "hidden-parent"])(
    "invalidates a rewritten ancestor remembered only by a loaded page: %s",
    async (changed) => {
      const f = fixture(3);
      const live = [
        { id: "live-parent", start: 1000 },
        { id: "live-leaf", start: 2000 },
      ];
      f.state.snapshot = {
        ...f.state.snapshot,
        history: "unloaded",
        branch: { kind: "claude", nodes: live },
      };
      const anchor: TranscriptPageAnchor = {
        agent: "claude",
        start: 1000,
        end: 1100,
        recordHash: "proof",
        entryHash: "proof",
        entryId: "private-row-0",
        nodeId: "live-parent",
      };
      f.follower.anchor = () => anchor;
      f.follower.older = async () => ({
        status: "page",
        entries: [{ entry: { id: "0:0", kind: "user", text: "Older ancestor" }, anchor: null }],
        history: "complete",
        branch: {
          kind: "claude",
          nodes: [
            { id: "old-root", start: 0 },
            { id: "hidden-parent", start: 42 },
          ],
        },
      });
      await f.step();
      await f.step();
      f.acknowledge();
      const initial = f.batches()[0]!;
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: initial.generation,
        requestId: id("older"),
        cursor: initial.olderCursor!,
      });
      await f.step();
      f.acknowledge();
      f.state.snapshot = {
        ...f.state.snapshot,
        revision: 2,
        history: "truncated",
        entries: [
          { id: "9000:0", kind: "user", text: "Rewritten ancestor" },
          ...f.state.snapshot.entries,
        ],
        branch: { kind: "claude", nodes: [{ id: changed, start: 9000 }, ...live] },
      };
      await f.step();
      expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
      expect(JSON.stringify(f.frames)).not.toMatch(/old-root|live-parent|native/);
      f.source.close();
    },
  );

  it("starts a clipped projection at its first row that older pages can start from", async () => {
    const f = fixture(1000);
    f.state.snapshot = {
      ...f.state.snapshot,
      history: "unloaded",
      entries: f.state.snapshot.entries.map((entry) => ({ ...entry, text: "x".repeat(400) })),
    };
    const cut = (entry: string) => Number(entry.split("-").at(-1)) % 10 === 0;
    const anchors = new Map<string, TranscriptPageAnchor>();
    f.follower.anchor = (_revision, entry) => {
      if (!cut(entry)) return null;
      const anchor = anchors.get(entry) ?? {
        agent: "claude",
        start: 0,
        end: 100,
        recordHash: "proof",
        entryHash: "proof",
        entryId: entry,
        nodeId: entry,
      };
      anchors.set(entry, anchor);
      return anchor;
    };
    const older = vi.fn(
      async (_anchor: Readonly<TranscriptPageAnchor>): Promise<TranscriptOlder> => ({
        status: "page",
        entries: [],
        history: "complete",
      }),
    );
    f.follower.older = older;
    await f.step();
    await f.step();
    let batch = f.batches().at(-1)!;
    f.acknowledge(batch);
    for (let page = 0; batch.olderCursor && page < 30 && !older.mock.calls.length; page++) {
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: batch.generation,
        requestId: id(`page${page}`),
        cursor: batch.olderCursor,
      });
      await f.step();
      await f.step();
      if (f.batches().at(-1) !== batch) {
        batch = f.batches().at(-1)!;
        f.acknowledge(batch);
      }
    }
    // Paging reached the projection's oldest row and asked the file for the rows before it.
    expect(older).toHaveBeenCalledOnce();
    expect(cut(older.mock.calls[0]![0].entryId)).toBe(true);
    f.source.close();
  });
  it("does not claim complete history when a trimmed physical page has no next anchor", async () => {
    const f = fixture(3);
    f.state.snapshot = { ...f.state.snapshot, history: "unloaded" };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = (_revision, entry) => (entry === anchor.entryId ? anchor : null);
    f.follower.older = async () => ({
      status: "page",
      entries: Array.from({ length: 64 }, (_, i) => ({
        entry: { ...row(-64 + i), text: "x".repeat(2048) },
        anchor: null,
      })),
      history: "complete",
      more: false,
    });
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    f.receive({
      type: "conversation.history.get",
      subscriptionId: id("sub"),
      generation: initial.generation,
      requestId: id("older"),
      cursor: initial.olderCursor!,
    });
    await f.step();
    const page = f.batches().at(-1)!;
    expect(page.entries.length).toBeLessThan(64);
    expect(page).toMatchObject({ operation: "prepend", history: "unloaded", olderCursor: null });
    f.source.close();
  });

  it("preserves a discovered unlinked boundary when a later page reaches the file start", async () => {
    const f = fixture(3);
    f.state.snapshot = { ...f.state.snapshot, history: "unloaded" };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = (_revision, entry) => (entry === anchor.entryId ? anchor : null);
    f.follower.older = vi
      .fn()
      .mockResolvedValueOnce({
        status: "page",
        entries: [{ entry: row(-1), anchor }],
        history: "unlinked",
        more: true,
      })
      .mockResolvedValueOnce({
        status: "page",
        entries: [{ entry: row(-2), anchor: null }],
        history: "complete",
        more: false,
      });
    await f.step();
    await f.step();
    f.acknowledge();
    for (let i = 0; i < 2; i++) {
      const previous = f.batches().at(-1)!;
      f.receive({
        type: "conversation.history.get",
        subscriptionId: id("sub"),
        generation: previous.generation,
        requestId: id(`older-${i}`),
        cursor: previous.olderCursor!,
      });
      await f.step();
      expect(f.batches().at(-1)?.history).toBe("unlinked");
      f.acknowledge();
    }
    expect(f.batches().at(-1)?.olderCursor).toBeNull();
    f.source.close();
  });

  it("pages past a leading side-chain notice using the next content row's private anchor", async () => {
    const f = fixture(3);
    f.state.snapshot = {
      ...f.state.snapshot,
      history: "unloaded",
      entries: [
        { id: "unlinked-side", kind: "unsupported", text: "Some activity is unlinked" },
        ...f.state.snapshot.entries,
      ],
    };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = (_revision, entry) => (entry === anchor.entryId ? anchor : null);
    f.follower.older = vi.fn(
      async (): Promise<TranscriptOlder> => ({
        status: "page",
        entries: [{ entry: row(-1), anchor: null }],
        history: "complete",
      }),
    );
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    expect(initial.olderCursor).toBeTruthy();
    f.receive({
      type: "conversation.history.get",
      subscriptionId: id("sub"),
      generation: initial.generation,
      requestId: id("older"),
      cursor: initial.olderCursor!,
    });
    await f.step();
    expect(f.follower.older).toHaveBeenCalledWith(anchor);
    expect(f.batches().at(-1)).toMatchObject({
      operation: "prepend",
      anchor: initial.entries[0]!.id,
      entries: [{ text: "Reply -1" }],
    });
    f.acknowledge();
    expect(f.frames.some((message) => message.type === "conversation.clear")).toBe(false);
    f.source.close();
  });

  it("rejects overlapping physical history without clearing the displayed conversation", async () => {
    const f = fixture(3);
    f.state.snapshot = { ...f.state.snapshot, history: "unloaded" };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = () => anchor;
    f.follower.older = async () => ({
      status: "page",
      entries: [{ entry: row(1), anchor }],
      history: "complete",
    });
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    f.receive({
      type: "conversation.history.get",
      subscriptionId: id("sub"),
      generation: initial.generation,
      requestId: id("older"),
      cursor: initial.olderCursor!,
    });
    await f.step();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.history.end", reason: "changed" });
    expect(f.batches()).toHaveLength(1);
    expect(f.frames.some((message) => message.type === "conversation.clear")).toBe(false);
    f.source.close();
  });

  it("discards a physical page completed after consent is revoked", async () => {
    const f = fixture(3);
    f.state.snapshot = { ...f.state.snapshot, history: "unloaded" };
    const anchor: TranscriptPageAnchor = {
      agent: "claude",
      start: 0,
      end: 100,
      recordHash: "proof",
      entryHash: "proof",
      entryId: "private-row-0",
      nodeId: "native-0",
    };
    f.follower.anchor = () => anchor;
    let finish!: (result: Awaited<ReturnType<NonNullable<TranscriptFollower["older"]>>>) => void;
    f.follower.older = vi.fn(
      () =>
        new Promise<TranscriptOlder>((resolve) => {
          finish = resolve;
        }),
    );
    await f.step();
    await f.step();
    f.acknowledge();
    const initial = f.batches()[0]!;
    f.receive({
      type: "conversation.history.get",
      subscriptionId: id("sub"),
      generation: initial.generation,
      requestId: id("older"),
      cursor: initial.olderCursor!,
    });
    const pending = f.step();
    expect(f.follower.older).toHaveBeenCalledOnce();
    f.state.enabled = false;
    f.source.invalidate("disabled");
    finish({ status: "page", entries: [{ entry: row(-1), anchor }], history: "complete" });
    await pending;
    expect(f.batches()).toHaveLength(1);
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "disabled" });
    f.source.close();
  });

  it("retries a missing identity soon, backing off to a bounded delay, without a manual refresh", async () => {
    const f = fixture(3);
    const stopped = { status: "stopped" as const, reason: "unbound" as const };
    for (let i = 0; i < 8; i++) vi.mocked(f.follower.poll).mockResolvedValueOnce(stopped);
    const attempt = async (ms: number) => {
      f.state.now += ms;
      f.source.tick();
      await f.source.work();
      f.drain();
    };
    await attempt(0);
    expect(f.frames.at(-1)).toMatchObject({ state: "unavailable", reason: "unbound" });
    // 250, 500, 1000, 2000, 4000, then at most 5000 ms apart.
    for (const wait of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
      const before = f.follow.mock.calls.length;
      await attempt(wait - 1);
      expect(f.follow).toHaveBeenCalledTimes(before);
      await attempt(1);
      expect(f.follow).toHaveBeenCalledTimes(before + 1);
    }
    await attempt(5000);
    expect(f.batches()).toHaveLength(1);
    f.source.close();
  });

  it("sends the messages seen queued with a ready status, and starts again for a new generation", async () => {
    const f = fixture(3, {});
    await f.step();
    f.acknowledge();
    const statuses = () =>
      f.frames.filter(
        (m): m is Extract<ConversationMessage, { type: "conversation.status" }> =>
          m.type === "conversation.status" && m.state === "ready",
      );
    // Nothing queued: the field is left out.
    expect(statuses().at(-1)).toMatchObject({ state: "ready" });
    expect(statuses().at(-1)).not.toHaveProperty("queued");
    // Only the queue changes: no batch, one ready status under the poll's proof.
    const batches = f.batches().length;
    f.state.snapshot = { ...f.state.snapshot, revision: 2, queued: [{ text: "Next, please" }] };
    await f.step();
    expect(f.batches()).toHaveLength(batches);
    expect(statuses().at(-1)).toMatchObject({ queued: [{ text: "Next, please" }] });
    const sent = statuses().length;
    await f.step();
    expect(statuses()).toHaveLength(sent);
    // A new generation starts without the old queue.
    f.source.invalidate("changed");
    f.drain();
    f.clearAck();
    f.state.snapshot = { ...snapshot(3, 3), queued: [{ attachment: true }] };
    await f.step();
    expect(f.batches().at(-1)!.generation).not.toBe(f.batches()[0]!.generation);
    expect(statuses().at(-1)).toMatchObject({ queued: [{ attachment: true }] });
    f.source.close();
  });

  it("names the rows' chat and queue on each ready status", async () => {
    let chat: string | undefined = "chat-one";
    const f = fixture(3, { id: () => chat });
    f.state.snapshot = { ...f.state.snapshot, queued: [{ text: "Next" }] };
    await f.step();
    f.acknowledge();
    const ready = f.frames.filter(
      (m): m is Extract<ConversationMessage, { type: "conversation.status" }> =>
        m.type === "conversation.status" && m.state === "ready",
    );
    expect(ready.length).toBeGreaterThan(0);
    for (const status of ready) {
      expect(ConversationMessageSchema.safeParse(status).success).toBe(true);
      expect(status).toMatchObject({ chat: "chat-one", queued: [{ text: "Next" }] });
    }
    // A new generation names the chat it belongs to now.
    chat = "chat-two";
    f.source.invalidate("changed");
    f.drain();
    f.clearAck();
    await f.step();
    const last = f.frames.filter((m) => m.type === "conversation.status").at(-1)!;
    expect(last).toMatchObject({ state: "ready", chat: "chat-two" });
    f.source.close();
  });

  it("only reads the rows' chat while idle, and names it only in a status it sends", async () => {
    const id = vi.fn(() => "chat-one");
    const known = vi.fn(() => "chat-one");
    const f = fixture(3, { id, known });
    await f.step();
    f.acknowledge();
    await f.step();
    const named = id.mock.calls.length;
    expect(named).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await f.step();
    // Asking whether anything changed never adopts a chat; only a ready status names one.
    expect(id).toHaveBeenCalledTimes(named);
    expect(known.mock.calls.length).toBeGreaterThan(0);
    f.source.close();
  });

  it("retries at once when the backend says proofs are available again", async () => {
    const f = fixture(3);
    vi.mocked(f.follower.poll).mockResolvedValueOnce({ status: "stopped", reason: "unbound" });
    await f.step();
    f.source.retry();
    await f.source.work();
    f.drain();
    expect(f.batches()).toHaveLength(1);
    // Once a generation is current, a later hint does nothing.
    const polls = vi.mocked(f.follower.poll).mock.calls.length;
    f.source.retry();
    await f.source.work();
    expect(vi.mocked(f.follower.poll).mock.calls.length).toBe(polls);
    f.source.close();
  });

  it("says it is checking once while a new reader catches up, not on every read", async () => {
    const f = fixture(3);
    let reads = 0;
    f.follower.poll = vi.fn(async () => {
      reads++;
      return reads < 40
        ? { status: "catching-up" as const, discontinuity: 0, pending: true }
        : {
            status: "snapshot" as const,
            snapshot: f.state.snapshot,
            discontinuity: 0,
            caughtUp: true,
          };
    });
    for (let i = 0; i < 40; i++) {
      await f.source.work();
      for (let j = 0; j < 10 && f.source.offer(); j++);
    }
    const checking = f.frames.filter(
      (m) => m.type === "conversation.status" && m.state === "checking",
    );
    expect(reads).toBe(40);
    expect(checking.length).toBeLessThanOrEqual(1);
    f.source.close();
  });

  it("keeps the view when parallel tool calls move the newest record beside the chain", async () => {
    const f = fixture(3);
    await f.step();
    await f.step();
    f.acknowledge();
    const branch = f.state.snapshot.branch;
    if (branch?.kind !== "claude") throw new Error("no Claude branch");
    const nodes = branch.nodes;
    const tip = nodes.at(-1)!;
    // The result of the first parallel call hangs off its call, beside the second call.
    const result = { id: "result-a", start: 900 };
    f.state.snapshot = {
      ...snapshot(4, 2),
      branch: { kind: "claude", nodes: [...nodes.slice(0, -1), result], parallel: [tip] },
    };
    await f.step();
    await f.step();
    expect(f.frames.some((m) => m.type === "conversation.clear")).toBe(false);
    expect(f.batches().at(-1)).toMatchObject({ operation: "patch" });
    // A real rewind, where the old tip is neither on the chain nor a parallel sibling, resets.
    f.acknowledge();
    f.state.snapshot = {
      ...snapshot(4, 3),
      branch: { kind: "claude", nodes: [...nodes.slice(0, -1), { id: "edit", start: 1000 }] },
    };
    await f.step();
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "changed" });
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

  it("proves a batch held back by the wire once, while that proof still authorizes it", async () => {
    const f = fixture(3);
    await f.step();
    f.acknowledge();
    f.state.snapshot = snapshot(4, 2);
    // The wire is full: the new batch waits.
    f.state.send = () => false;
    const confirms = () => vi.mocked(f.follower.confirm).mock.calls.length;
    await f.step();
    const proved = confirms();
    // Passes within the proof's 200 ms window don't prove the same batch again.
    for (let i = 0; i < 5; i++) {
      f.source.tick();
      await f.source.work();
      f.drain();
    }
    expect(confirms()).toBe(proved);
    // Nothing more to do until the proof runs out: no pass is due meanwhile.
    expect(f.source.needsWork).toBe(false);
    // Once the wire takes it, the batch goes under that proof.
    f.state.send = () => true;
    const batches = f.batches().length;
    f.drain();
    expect(f.batches().length).toBeGreaterThan(batches);
    f.source.close();
  });

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
    const before = vi.mocked(createHash).mock.calls.length;
    for (let i = 0; i < 3; i++) await f.step();
    expect(vi.mocked(createHash).mock.calls.length - before).toBe(0);
    const initialBatches = f.batches().length;
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
    expect(f.batches().length).toBeGreaterThan(initialBatches);
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
    // The first send used its poll's proof; the retransmission proves again.
    expect(f.follower.confirm).toHaveBeenCalledTimes(1);
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
    // The scheduler refuses the first send, so the queued batch must be proved again.
    f.state.send = () => false;
    await f.step();
    f.state.send = () => true;
    const attempted = f.batches().length;
    let resolve!: (value: { status: "confirmed"; caughtUp: boolean }) => void;
    vi.mocked(f.follower.confirm).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    f.state.now += 1000;
    const pending = f.source.work();
    expect(f.follower.confirm).toHaveBeenCalledOnce();
    f.state.enabled = false;
    f.source.invalidate("disabled");
    resolve({ status: "confirmed", caughtUp: true });
    await pending;
    f.drain();
    expect(f.batches()).toHaveLength(attempted);
    expect(f.frames.at(-1)).toMatchObject({ type: "conversation.clear", reason: "disabled" });
    f.clearAck();
    await f.step();
    expect(f.follow).toHaveBeenCalledTimes(1);
    f.source.close();
  });

  it("expires the delivery proof while waiting for scheduler budget", async () => {
    const f = fixture(1);
    // The poll proved the snapshot, but the scheduler has no budget for it yet.
    f.state.send = () => false;
    await f.step();
    f.state.send = () => true;
    const attempted = f.batches().length;
    f.state.now += 201;
    f.drain();
    expect(f.batches()).toHaveLength(attempted);
    await f.step();
    expect(f.batches()).toHaveLength(attempted + 1);
    expect(f.follower.confirm).toHaveBeenCalledTimes(1);
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

describe("Gemini messages written again", () => {
  it("update their rows in place in one batch instead of briefly showing both versions", async () => {
    const { TranscriptDocument } = await import("../src/conversation/transcript-document.js");
    const { TranscriptJsonl } = await import("../src/conversation/transcript-jsonl.js");
    const { decodeTranscriptRecord, transcriptOutline } = await import(
      "../src/conversation/transcript-record.js"
    );
    const session = "11111111-1111-4111-8111-111111111111";
    const lines = [
      { sessionId: session, projectHash: "x", kind: "main" },
      { id: "u1", type: "user", content: "hi" },
      {
        id: "m1",
        type: "gemini",
        content: "",
        toolCalls: [{ name: "read_file", status: "executing" }],
      },
    ];
    const project = () => {
      const document = new TranscriptDocument("gemini", session);
      const text = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      const framed = new TranscriptJsonl(0, false, transcriptOutline("gemini")).push(text);
      document.append(framed.lines.map((line) => decodeTranscriptRecord("gemini", line)));
      return document.snapshot();
    };
    const f = fixture(0);
    f.state.snapshot = project();
    /** Polls until the stream sends its next batch, then applies it as the phone would. */
    const next = async () => {
      const sent = f.batches().length;
      for (let i = 0; i < 10 && f.batches().length === sent; i++) await f.step();
      expect(f.batches().length).toBeGreaterThan(sent);
      f.acknowledge();
      return f.batches().at(-1)!;
    };
    await next();
    expect(f.state.snapshot.entries).toHaveLength(2);
    // Gemini finishes the tool call by writing the whole message again, further down the file.
    lines.push({
      id: "m1",
      type: "gemini",
      content: "",
      toolCalls: [{ name: "read_file", status: "success" }],
    });
    f.state.snapshot = { ...project(), revision: 2 };
    const batch = await next();
    // One patch replaces the tool call's rows; the phone never holds the old and new versions.
    expect(batch.operation).not.toBe("reset");
    expect(f.state.snapshot.entries).toHaveLength(3);
    const applied = f.frames
      .filter((m) => m.type === "conversation.batch")
      .reduce<string[]>((rows, b) => {
        const entries = (b as ConversationBatch).entries.map((e) => e.id);
        if ((b as ConversationBatch).operation === "reset") return entries;
        const at =
          (b as ConversationBatch).anchor === null
            ? 0
            : rows.indexOf((b as ConversationBatch).anchor!) + 1;
        const after = (b as ConversationBatch).after;
        return [
          ...rows.slice(0, at),
          ...entries,
          ...(after ? rows.slice(rows.indexOf(after)) : []),
        ];
      }, []);
    expect(applied).toHaveLength(3);
  });
});
