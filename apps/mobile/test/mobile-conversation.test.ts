import {
  CONVERSATION_LIMITS,
  type ConversationBatch,
  type ConversationMessage,
  encodeCbor,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { MobileConversation } from "../src/net/mobile-conversation";

const id = (value: string | number) => String(value).padStart(22, "0");
const SUB = id("subscription");
const GEN = id("generation");
const row = (value: number, text = `Message ${value}`) => ({
  id: id(value),
  kind: "assistant" as const,
  text,
});
const initial = (
  entries = [row(1)],
  overrides: Partial<ConversationBatch> = {},
): ConversationBatch => ({
  type: "conversation.batch",
  subscriptionId: SUB,
  generation: GEN,
  batchId: id("batch1"),
  baseRevision: 0,
  revision: 1,
  operation: "reset",
  entries,
  olderCursor: id("cursor"),
  history: "unloaded",
  ...overrides,
});
const patch = (
  base: number,
  anchor: string | null,
  entries: ConversationBatch["entries"],
  overrides: Partial<ConversationBatch> = {},
): ConversationBatch => ({
  type: "conversation.batch",
  subscriptionId: SUB,
  generation: GEN,
  batchId: id(`batch${base + 1}`),
  baseRevision: base,
  revision: base + 1,
  operation: "patch",
  anchor,
  entries,
  ...overrides,
});
function fixture() {
  const frames: ConversationMessage[] = [];
  let next = 0;
  const state = { now: 0, send: (_message: ConversationMessage) => true };
  const view = new MobileConversation({
    subscriptionId: SUB,
    sessionId: "herdr:pane",
    now: () => state.now,
    newRequestId: () => id(`request${++next}`),
    send: (message) => {
      frames.push(message);
      return state.send(message);
    },
  });
  const receive = (message: unknown, bytes = encodeCbor(message).byteLength) =>
    view.receive(message, bytes);
  const clear = (name: string, reason: "changed" | "disabled" | "skipped" = "changed") =>
    receive({ type: "conversation.clear", subscriptionId: SUB, clearId: id(name), reason });
  expect(view.start()).toBe(true);
  return { view, state, frames, receive, clear };
}
const applied = (frames: ConversationMessage[]) =>
  frames.filter((frame) => frame.type === "conversation.applied");

describe("memory-only phone conversation", () => {
  it("applies bounded range edits without replacing the latest retained messages", () => {
    const f = fixture();
    f.receive(initial([row(1), row(2), row(3)]));
    expect(f.receive(patch(1, null, [row(1, "Updated")], { after: id(2) }))).toBe(true);
    expect(f.view.snapshot.entries.map((entry) => entry.text)).toEqual([
      "Updated",
      "Message 2",
      "Message 3",
    ]);
    expect(f.receive(patch(2, id(1), [row(4)], { after: id(2) }))).toBe(true);
    expect(f.view.snapshot.entries.map((entry) => entry.id)).toEqual([id(1), id(4), id(2), id(3)]);
    expect(f.receive(patch(3, id(1), [], { after: id(2) }))).toBe(true);
    expect(f.view.snapshot.entries.map((entry) => entry.id)).toEqual([id(1), id(2), id(3)]);
    expect(f.receive(patch(4, id(3), [row(5)], { after: id(1) }))).toBe(false);
  });
  it("preserves live rows when an older page crosses the entry cap", () => {
    const f = fixture();
    let base = 0;
    let next = 100;
    for (let count = 0; count < 1936; ) {
      const size = Math.min(64, 1936 - count);
      const entries = Array.from({ length: size }, () => row(next++));
      expect(
        f.receive(base === 0 ? initial(entries) : patch(base, id(next - size - 1), entries)),
      ).toBe(true);
      base++;
      count += size;
    }
    expect(f.view.requestOlder()).toBe(true);
    const request = f.frames.at(-1)!;
    if (request.type !== "conversation.history.get") throw new Error("missing request");
    expect(f.receive(patch(base++, id(next - 1), [row(next++)]))).toBe(true);
    expect(
      f.receive(
        patch(
          base,
          id(100),
          Array.from({ length: 64 }, (_, i) => row(i + 36)),
          {
            operation: "prepend",
            requestId: request.requestId,
            olderCursor: id("older"),
            history: "unloaded",
          },
        ),
      ),
    ).toBe(true);
    expect(f.view.snapshot).toMatchObject({
      state: "ready",
      notice: "evicted",
      historyStatus: "limit",
    });
    expect(f.view.snapshot.entries).toHaveLength(2000);
    expect(f.view.snapshot.entries[0]?.id).toBe(id(37));
    expect(f.view.snapshot.entries.at(-1)?.id).toBe(id(next - 1));
    expect(applied(f.frames).at(-1)).toMatchObject({
      revision: base + 1,
      retainedCount: 2000,
      oldestId: id(37),
    });
  });

  it("preserves live rows when an older page crosses the byte cap", () => {
    const f = fixture();
    const text = "x".repeat(CONVERSATION_LIMITS.textBytes);
    const detail = "y".repeat(CONVERSATION_LIMITS.detailBytes);
    let base = 0;
    let next = 100;
    while (
      f.view.snapshot.entries.reduce((sum, entry) => sum + encodeCbor(entry).byteLength, 0) <
      CONVERSATION_LIMITS.retainedBytes - 60_000
    ) {
      const entry = { ...row(next++, text), detail };
      expect(f.receive(base === 0 ? initial([entry]) : patch(base, id(next - 2), [entry]))).toBe(
        true,
      );
      base++;
    }
    expect(f.view.requestOlder()).toBe(true);
    const request = f.frames.at(-1)!;
    if (request.type !== "conversation.history.get") throw new Error("missing request");
    for (let i = 0; i < 2; i++) {
      const entry = { ...row(next++, text), detail };
      expect(f.receive(patch(base++, id(next - 2), [entry]))).toBe(true);
    }
    expect(
      f.receive(
        patch(base, id(100), [{ ...row(99, text), detail }], {
          operation: "prepend",
          requestId: request.requestId,
          olderCursor: id("older"),
          history: "unloaded",
        }),
      ),
    ).toBe(true);
    expect(f.view.snapshot).toMatchObject({
      state: "ready",
      notice: "evicted",
      historyStatus: "limit",
    });
    expect(f.view.snapshot.entries.at(-1)?.id).toBe(id(next - 1));
    expect(
      f.view.snapshot.entries.reduce((sum, entry) => sum + encodeCbor(entry).byteLength, 0),
    ).toBeLessThanOrEqual(CONVERSATION_LIMITS.retainedBytes);
  });

  it.each(["page", "complete"])(
    "contains a late %s after the live tail evicts the page anchor",
    (response) => {
      const f = fixture();
      f.receive(initial([row(100)]));
      f.view.requestOlder();
      const request = f.frames.at(-1)!;
      if (request.type !== "conversation.history.get") throw new Error("missing request");
      let next = 101;
      for (let base = 1; base <= 32; base++) {
        const entries = Array.from({ length: 64 }, () => row(next++));
        f.receive(patch(base, id(next - 65), entries));
      }
      const retained = f.view.snapshot.entries;
      expect(f.view.snapshot).toMatchObject({ historyStatus: "limit", notice: "evicted" });
      expect(f.view.nextDeadline()).toBeNull();
      if (response === "page") {
        expect(
          f.receive(
            patch(33, id(100), [row(99)], {
              operation: "prepend",
              requestId: request.requestId,
              olderCursor: null,
              history: "complete",
            }),
          ),
        ).toBe(true);
        expect(applied(f.frames).at(-1)).toMatchObject({
          revision: 34,
          oldestId: retained[0]?.id,
          retainedCount: 2000,
        });
      } else {
        f.receive({
          type: "conversation.history.end",
          subscriptionId: SUB,
          generation: GEN,
          requestId: request.requestId,
          reason: "complete",
        });
      }
      expect(f.view.snapshot.entries).toEqual(retained);
      expect(f.view.snapshot).toMatchObject({
        state: "ready",
        historyStatus: "limit",
        history: "unloaded",
        canRequestOlder: false,
      });
    },
  );

  it("preserves current rows when an older cursor expires", () => {
    const f = fixture();
    f.receive(initial());
    f.view.requestOlder();
    const request = f.frames.at(-1)!;
    if (request.type !== "conversation.history.get") throw new Error("missing request");
    f.receive({
      type: "conversation.history.end",
      subscriptionId: SUB,
      generation: GEN,
      requestId: request.requestId,
      reason: "changed",
    });
    expect(f.view.snapshot).toMatchObject({
      state: "ready",
      historyStatus: "unavailable",
      canRequestOlder: false,
    });
    expect(f.view.snapshot.entries).toHaveLength(1);
  });

  it("retries unadmitted refreshes and times out an admitted but unanswered refresh", () => {
    const f = fixture();
    f.state.send = () => false;
    f.view.refresh();
    expect(f.view.nextDeadline()).toBe(250);
    f.state.now = 249;
    f.view.tick();
    expect(f.frames.filter((m) => m.type === "conversation.refresh")).toHaveLength(1);
    f.state.now = 250;
    f.view.tick();
    expect(f.view.nextDeadline()).toBe(750);
    f.state.now = 750;
    f.state.send = () => true;
    f.view.tick();
    expect(f.view.nextDeadline()).toBe(750 + CONVERSATION_LIMITS.progressMs);
    expect(f.frames.filter((m) => m.type === "conversation.refresh")).toHaveLength(3);
    f.state.now = 750 + CONVERSATION_LIMITS.progressMs;
    f.view.tick();
    expect(f.frames.filter((m) => m.type === "conversation.refresh")).toHaveLength(4);
    f.clear("answer");
    expect(f.view.nextDeadline()).toBeNull();
  });

  it("keeps a pending clear acknowledgement across forced recovery", () => {
    const f = fixture();
    f.receive(initial());
    f.state.send = (message) => message.type !== "conversation.cleared";
    f.clear("pending");
    f.view.refresh();
    f.state.send = () => true;
    f.clear("pending");
    expect(f.view.nextDeadline()).toBeNull();
    expect(f.view.snapshot.state).toBe("checking");
    expect(f.receive(initial([row(2)], { generation: id("next-generation") }))).toBe(true);
    expect(f.view.snapshot.entries).toEqual([row(2)]);
  });

  it("coalesces malformed signals and ignores progress statuses until recovery clears", () => {
    const f = fixture();
    f.receive(initial());
    f.view.malformed();
    f.view.malformed();
    expect(f.frames.filter((m) => m.type === "conversation.refresh")).toHaveLength(1);
    for (const state of ["ready", "checking"]) {
      expect(f.receive({ type: "conversation.status", subscriptionId: SUB, state })).toBe(false);
      expect(f.view.snapshot).toMatchObject({
        state: "unavailable",
        entries: [],
        reason: "protocol",
      });
    }
    f.clear("recovered");
    expect(f.view.nextDeadline()).toBeNull();
  });

  it.each(["disable", "close", "clear"])("cancels refresh retry on %s", (action) => {
    const f = fixture();
    f.state.send = () => false;
    f.view.refresh();
    if (action === "clear") f.clear("next");
    else f.view[action as "disable" | "close"]();
    f.state.now = 50_000;
    f.view.tick();
    expect(f.view.nextDeadline()).toBeNull();
    expect(f.frames.filter((m) => m.type === "conversation.refresh")).toHaveLength(1);
  });

  it("preserves opt-out truth despite late batches and malformed traffic", () => {
    const f = fixture();
    f.receive(initial());
    f.view.disable();
    expect(f.receive(patch(1, id(1), [row(2)]))).toBe(false);
    expect(f.receive(initial(), 0)).toBe(false);
    f.view.refresh();
    expect(f.view.snapshot).toMatchObject({ state: "disabled", entries: [] });
    expect(f.frames.some((m) => m.type === "conversation.refresh")).toBe(false);
  });
  it("subscribes independently and keeps loaded older rows through suffix updates", () => {
    const f = fixture();
    expect(f.frames[0]).toEqual({
      type: "conversation.subscribe",
      subscriptionId: SUB,
      sessionId: "herdr:pane",
    });
    expect(f.receive(initial([row(3), row(4)]))).toBe(true);
    expect(f.view.requestOlder()).toBe(true);
    const request = f.frames.at(-1)!;
    if (request.type !== "conversation.history.get") throw new Error("missing history request");
    expect(
      f.receive({
        ...patch(1, id(3), [row(1), row(2)]),
        operation: "prepend",
        requestId: request.requestId,
        olderCursor: null,
        history: "complete",
      }),
    ).toBe(true);
    expect(f.receive(patch(2, id(4), [row(5, "Growing reply")]))).toBe(true);
    expect(f.receive(patch(3, id(4), [row(5, "Finished reply")]))).toBe(true);
    expect(f.view.snapshot.entries.map((entry) => entry.text)).toEqual([
      "Message 1",
      "Message 2",
      "Message 3",
      "Message 4",
      "Finished reply",
    ]);
    expect(applied(f.frames).at(-1)).toMatchObject({
      revision: 4,
      oldestId: id(1),
      newestId: id(5),
      retainedCount: 5,
    });
    expect(f.view.snapshot).toMatchObject({
      state: "ready",
      history: "complete",
      canRequestOlder: false,
    });
  });

  it("requires clear acknowledgement before a different generation and does not replay an old clear", () => {
    const f = fixture();
    f.receive(initial());
    expect(f.receive(initial([row(9)], { generation: id("next") }))).toBe(false);
    expect(f.view.snapshot.entries).toEqual([]);
    expect(f.frames.at(-1)?.type).toBe("conversation.refresh");
    f.clear("clear1");
    expect(f.frames.at(-1)?.type).toBe("conversation.cleared");
    expect(f.receive(initial([row(9)], { generation: id("next") }))).toBe(true);
    f.clear("clear1");
    expect(f.view.snapshot.entries.map((entry) => entry.id)).toEqual([id(9)]);
    f.clear("clear2", "disabled");
    expect(f.view.snapshot).toMatchObject({
      state: "disabled",
      entries: [],
      canRequestOlder: false,
    });
  });

  it("keeps a refused clear ACK pending and permits a new generation only after its retry succeeds", () => {
    const f = fixture();
    f.receive(initial());
    f.state.send = (message) => message.type !== "conversation.cleared";
    f.clear("clear1");
    expect(f.view.snapshot.entries).toEqual([]);
    f.state.send = () => true;
    f.clear("clear1");
    expect(f.receive(initial([row(2)], { generation: id("next") }))).toBe(true);
  });

  it("does not let an old clear ACK lift a newer recovery barrier", () => {
    const f = fixture();
    f.receive(initial());
    f.clear("clear1");
    f.receive(initial([row(2)], { generation: id("next") }));
    f.receive(patch(9, id(2), [row(3)], { generation: id("next") }));
    f.clear("clear1");
    expect(f.receive(initial([row(4)], { generation: id("third") }))).toBe(false);
    f.clear("clear2");
    expect(f.receive(initial([row(4)], { generation: id("third") }))).toBe(true);
  });

  it("does not reuse a retired generation after clear", () => {
    const f = fixture();
    f.receive(initial());
    f.clear("clear1");
    expect(f.receive(initial())).toBe(false);
    expect(f.view.snapshot.entries).toEqual([]);
  });

  it("drops records on a disabled status even if the explicit clear arrives later", () => {
    const f = fixture();
    f.receive(initial());
    f.receive({ type: "conversation.status", subscriptionId: SUB, state: "disabled" });
    expect(f.view.snapshot.entries).toEqual([]);
    f.receive({
      type: "conversation.status",
      subscriptionId: SUB,
      state: "ready",
      caughtUp: false,
    });
    expect(f.receive(initial([row(2)], { generation: id("next") }))).toBe(false);
    f.clear("clear1");
    expect(f.receive(initial([row(2)], { generation: id("next") }))).toBe(true);
  });

  it("acknowledges identical retransmission once more without duplicating rows", () => {
    const f = fixture();
    const batch = initial();
    f.receive(batch);
    f.receive(batch);
    expect(f.view.snapshot.entries).toHaveLength(1);
    expect(applied(f.frames)).toHaveLength(2);
    expect(f.receive({ ...batch, entries: [row(1, "Changed under the same batch ID")] })).toBe(
      false,
    );
    expect(f.view.snapshot.entries).toEqual([]);
  });

  it.each([
    patch(1, id("missing"), [row(2)]),
    patch(1, null, [row(2)]),
    patch(2, id(1), [row(2)]),
    patch(1, id(1), [row(1)]),
    {
      ...patch(1, id(1), [row(0)]),
      operation: "prepend",
      requestId: id("unsolicited"),
      olderCursor: null,
      history: "complete",
    },
  ])("recovers instead of applying an unproven patch or page", (batch) => {
    const f = fixture();
    f.receive(initial());
    expect(f.receive(batch)).toBe(false);
    expect(f.view.snapshot).toMatchObject({
      state: "unavailable",
      entries: [],
      reason: "protocol",
    });
    expect(f.frames.at(-1)?.type).toBe("conversation.refresh");
  });

  it("keeps a timed-out page request owned for an explicit retry and late valid response", () => {
    const f = fixture();
    f.receive(initial([row(3)]));
    expect(f.view.requestOlder()).toBe(true);
    const first = f.frames.at(-1)!;
    expect(f.view.requestOlder()).toBe(false);
    f.state.now = CONVERSATION_LIMITS.progressMs;
    f.view.tick();
    expect(f.view.nextDeadline()).toBeNull();
    expect(f.view.snapshot).toMatchObject({ historyStatus: "unavailable", canRequestOlder: true });
    expect(f.view.requestOlder()).toBe(true);
    expect(f.frames.at(-1)).toEqual(first);
    if (first.type !== "conversation.history.get") throw new Error("missing request");
    f.receive({
      ...patch(1, id(3), [row(2)]),
      operation: "prepend",
      requestId: first.requestId,
      olderCursor: id("older"),
      history: "unloaded",
    });
    expect(f.view.snapshot.entries.map((entry) => entry.id)).toEqual([id(2), id(3)]);
    expect(f.view.snapshot.historyStatus).toBe("idle");
    expect(f.view.nextDeadline()).toBeNull();
  });

  it("keeps the same history request after send refusal and accepts only its matching end", () => {
    const f = fixture();
    f.receive(initial());
    f.state.send = (message) => message.type !== "conversation.history.get";
    expect(f.view.requestOlder()).toBe(false);
    const request = f.frames.at(-1)!;
    if (request.type !== "conversation.history.get") throw new Error("missing request");
    f.state.send = () => true;
    expect(f.view.requestOlder()).toBe(true);
    expect(f.frames.at(-1)).toEqual(request);
    expect(
      f.receive({
        type: "conversation.history.end",
        subscriptionId: SUB,
        generation: GEN,
        requestId: id("wrong"),
        reason: "complete",
      }),
    ).toBe(false);
    f.receive({
      type: "conversation.history.end",
      subscriptionId: SUB,
      generation: GEN,
      requestId: request.requestId,
      reason: "complete",
    });
    expect(f.view.snapshot).toMatchObject({
      history: "complete",
      historyStatus: "idle",
      canRequestOlder: false,
    });
  });

  it("bounds retained entry count, marks eviction and reports the actual retained boundary", () => {
    const f = fixture();
    let next = 0;
    let base = 0;
    for (let batch = 0; batch < 32; batch++) {
      const entries = Array.from({ length: 64 }, () => row(next++));
      expect(f.receive(batch === 0 ? initial(entries) : patch(base, id(next - 65), entries))).toBe(
        true,
      );
      base++;
    }
    expect(f.view.snapshot.entries).toHaveLength(CONVERSATION_LIMITS.retainedEntries);
    expect(f.view.snapshot.entries[0]?.id).toBe(id(48));
    expect(f.view.snapshot.notice).toBe("evicted");
    expect(applied(f.frames).at(-1)).toMatchObject({
      oldestId: id(48),
      newestId: id(2047),
      retainedCount: 2000,
    });
  });

  it("bounds retained encoded content separately from entry count", () => {
    const f = fixture();
    const text = "x".repeat(CONVERSATION_LIMITS.textBytes);
    const detail = "y".repeat(CONVERSATION_LIMITS.detailBytes);
    for (let index = 0; index < 180; index++) {
      const entries = [{ ...row(index, text), detail }];
      expect(f.receive(index === 0 ? initial(entries) : patch(index, id(index - 1), entries))).toBe(
        true,
      );
    }
    const entries = f.view.snapshot.entries;
    expect(entries.length).toBeLessThan(180);
    expect(entries.at(-1)?.id).toBe(id(179));
    expect(
      entries.reduce((sum, entry) => sum + encodeCbor(entry).byteLength, 0),
    ).toBeLessThanOrEqual(CONVERSATION_LIMITS.retainedBytes);
    expect(f.view.snapshot.notice).toBe("evicted");
  });

  it("reserves room for a bounded older page before asking the computer to read it", () => {
    const f = fixture();
    let next = 0;
    for (let batch = 0; batch < 31; batch++) {
      const entries = Array.from({ length: 64 }, () => row(next++));
      f.receive(batch === 0 ? initial(entries) : patch(batch, id(next - 65), entries));
    }
    expect(f.view.snapshot.entries).toHaveLength(1984);
    expect(f.view.requestOlder()).toBe(false);
    expect(f.view.snapshot.historyStatus).toBe("limit");
    expect(f.frames.some((message) => message.type === "conversation.history.get")).toBe(false);
  });

  it("owns immutable presentation values and clears before a reentrant close observer", () => {
    const f = fixture();
    const batch = initial();
    f.receive(batch);
    batch.entries[0]!.text = "Caller changed input";
    expect(f.view.snapshot.entries[0]?.text).toBe("Message 1");
    expect(Object.isFrozen(f.view.snapshot.entries)).toBe(true);
    expect(Object.isFrozen(f.view.snapshot.entries[0])).toBe(true);
    f.state.send = (message) => {
      if (message.type === "conversation.cancel") {
        expect(f.view.snapshot).toMatchObject({ state: "ended", entries: [] });
        expect(f.receive(initial())).toBe(false);
      }
      return true;
    };
    f.view.close();
    expect(f.view.start()).toBe(false);
    expect(f.view.requestOlder()).toBe(false);
    expect(f.view.nextDeadline()).toBeNull();
  });

  it("cannot retain data when the route closes during an applied acknowledgement", () => {
    const f = fixture();
    f.state.send = (message) => {
      if (message.type === "conversation.applied") f.view.close();
      return true;
    };
    f.receive(initial());
    expect(f.view.snapshot).toMatchObject({ state: "ended", entries: [] });
    expect(f.frames.filter((m) => m.type === "conversation.cancel")).toHaveLength(1);
  });

  it("ignores stale subscription traffic and contains malformed owned traffic", () => {
    const f = fixture();
    f.receive(initial());
    expect(f.receive({ ...initial(), subscriptionId: id("stale") }, 0)).toBe(false);
    expect(f.view.snapshot.entries).toHaveLength(1);
    expect(f.receive(patch(1, id(1), [row(2)]), CONVERSATION_LIMITS.envelopeBytes + 1)).toBe(false);
    expect(f.view.snapshot.entries).toEqual([]);
    const refreshes = f.frames.filter((message) => message.type === "conversation.refresh").length;
    f.receive(patch(1, id(1), [row(2)]), 0);
    expect(f.frames.filter((message) => message.type === "conversation.refresh")).toHaveLength(
      refreshes,
    );
  });

  it("keeps a skipped-history notice across the next generation", () => {
    const f = fixture();
    f.receive(initial());
    f.clear("clear1", "skipped");
    f.receive(initial([row(2)], { generation: id("next") }));
    expect(f.view.snapshot.notice).toBe("skipped");
    f.view.close();
    expect(f.view.snapshot.notice).toBeNull();
  });

  it("clears the skipped notice once the new generation has caught up", () => {
    const f = fixture();
    f.receive(initial());
    f.clear("clear1", "skipped");
    const ready = (caughtUp: boolean) =>
      f.receive({ type: "conversation.status", subscriptionId: SUB, state: "ready", caughtUp });
    ready(true);
    expect(f.view.snapshot.notice).toBe("skipped");
    f.receive(initial([row(2)], { generation: id("next") }));
    ready(false);
    expect(f.view.snapshot.notice).toBe("skipped");
    ready(true);
    expect(f.view.snapshot.notice).toBeNull();
  });
});
