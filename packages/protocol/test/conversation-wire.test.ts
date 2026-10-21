import { describe, expect, it } from "vitest";
import {
  CONVERSATION_LIMITS,
  ConversationBatchSchema,
  ConversationEntrySchema,
  ConversationMessageSchema,
  decodeCbor,
  encodeCbor,
  parseInner,
  parseInnerLoose,
} from "../src/index.js";

const id = (letter: string) => letter.repeat(22);
const entry = { id: id("E"), kind: "assistant", text: "A growing reply" } as const;
const reset = {
  type: "conversation.batch",
  subscriptionId: id("S"),
  generation: id("G"),
  batchId: id("B"),
  baseRevision: 0,
  revision: 1,
  operation: "reset",
  entries: [entry],
  olderCursor: id("C"),
  history: "unloaded",
} as const;
const patch = {
  ...reset,
  operation: "patch",
  baseRevision: 1,
  revision: 2,
  anchor: id("A"),
  olderCursor: undefined,
  history: undefined,
} as const;
const prepend = {
  ...patch,
  operation: "prepend",
  requestId: id("R"),
  olderCursor: id("C"),
  history: "unloaded",
} as const;

describe("conversation direct wire", () => {
  it("allows bounded live ranges and rejects range anchors outside a patch", () => {
    expect(
      ConversationBatchSchema.safeParse({ ...patch, anchor: null, after: id("A") }).success,
    ).toBe(true);
    expect(ConversationBatchSchema.safeParse({ ...reset, after: id("A") }).success).toBe(false);
    expect(ConversationBatchSchema.safeParse({ ...prepend, after: id("A") }).success).toBe(false);
    expect(ConversationBatchSchema.safeParse({ ...patch, after: id("A") }).success).toBe(false);
    expect(ConversationBatchSchema.safeParse({ ...patch, after: entry.id }).success).toBe(false);
  });
  it.each([
    { ...reset, history: "complete" },
    { ...patch, olderCursor: id("C"), history: "unloaded" },
    { ...patch, anchor: null, olderCursor: null },
    { ...prepend, history: "complete" },
  ])("rejects inconsistent or misplaced history boundaries", (batch) => {
    expect(ConversationBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("allows a cursor before a proven but incomplete source window", () => {
    for (const history of ["unloaded", "unlinked", "truncated"])
      expect(ConversationBatchSchema.safeParse({ ...reset, history }).success).toBe(true);
    expect(
      ConversationBatchSchema.safeParse({ ...reset, history: "complete", olderCursor: null })
        .success,
    ).toBe(true);
  });
  it.each([
    { type: "conversation.subscribe", subscriptionId: id("S"), sessionId: "herdr:pane" },
    { type: "conversation.cancel", subscriptionId: id("S") },
    { type: "conversation.refresh", subscriptionId: id("S") },
    { type: "conversation.status", subscriptionId: id("S"), state: "checking", reason: "busy" },
    { type: "conversation.status", subscriptionId: id("S"), state: "ready", caughtUp: false },
    { type: "conversation.clear", subscriptionId: id("S"), clearId: id("Q"), reason: "disabled" },
    { type: "conversation.cleared", subscriptionId: id("S"), clearId: id("Q") },
    reset,
    patch,
    prepend,
    {
      type: "conversation.applied",
      subscriptionId: id("S"),
      generation: id("G"),
      batchId: id("B"),
      revision: 1,
      oldestId: id("E"),
      newestId: id("E"),
      retainedCount: 1,
    },
    {
      type: "conversation.history.get",
      subscriptionId: id("S"),
      generation: id("G"),
      requestId: id("R"),
      cursor: id("C"),
    },
    {
      type: "conversation.history.end",
      subscriptionId: id("S"),
      generation: id("G"),
      requestId: id("R"),
      reason: "complete",
    },
  ])("round trips $type through both negotiated inner parsers", (message) => {
    const wire = decodeCbor(encodeCbor(message));
    expect(ConversationMessageSchema.parse(wire)).toEqual(message);
    expect(parseInner(wire)).toEqual(message);
    expect(parseInnerLoose(wire)).toEqual(message);
    expect(() =>
      ConversationMessageSchema.parse({ ...message, privatePath: "/not-allowed" }),
    ).toThrow();
  });

  it.each([
    { ...reset, revision: 2 },
    { ...reset, baseRevision: 1, revision: 2 },
    { ...reset, anchor: null },
    { ...reset, requestId: id("R") },
    { ...reset, history: undefined },
    { ...reset, olderCursor: undefined },
    { ...reset, entries: [entry, entry] },
    { ...patch, anchor: undefined },
    { ...patch, anchor: entry.id },
    { ...patch, requestId: id("R") },
    { ...patch, baseRevision: Number.MAX_SAFE_INTEGER, revision: Number.MAX_SAFE_INTEGER },
    { ...prepend, anchor: null },
    { ...prepend, requestId: undefined },
    { ...prepend, entries: [] },
    { ...prepend, olderCursor: undefined },
  ])("rejects invalid revision, anchor or page metadata", (message) => {
    expect(ConversationBatchSchema.safeParse(message).success).toBe(false);
  });

  it("allows an empty initial conversation and a patch to an empty applied base", () => {
    expect(
      ConversationBatchSchema.safeParse({
        ...reset,
        entries: [],
        olderCursor: null,
        history: "complete",
      }).success,
    ).toBe(true);
    expect(
      ConversationBatchSchema.safeParse({
        ...patch,
        anchor: null,
        history: undefined,
        olderCursor: undefined,
      }).success,
    ).toBe(true);
  });

  it("bounds text by UTF-8 bytes and the full encoded batch before delivery", () => {
    const full = {
      ...entry,
      text: "🙂".repeat(CONVERSATION_LIMITS.textBytes / 4),
      detail: "x".repeat(CONVERSATION_LIMITS.detailBytes),
    };
    expect(ConversationBatchSchema.safeParse({ ...reset, entries: [full] }).success).toBe(true);
    expect(ConversationEntrySchema.safeParse({ ...full, text: `${full.text}x` }).success).toBe(
      false,
    );
    expect(ConversationEntrySchema.safeParse({ ...full, detail: `${full.detail}x` }).success).toBe(
      false,
    );
    expect(
      ConversationBatchSchema.safeParse({ ...reset, entries: [full, { ...full, id: id("F") }] })
        .success,
    ).toBe(false);
  });

  it("bounds entry count separately from encoded size", () => {
    const entries = Array.from({ length: CONVERSATION_LIMITS.entriesPerBatch + 1 }, (_, index) => ({
      ...entry,
      id: String(index).padStart(22, "0"),
      text: "",
    }));
    expect(
      ConversationBatchSchema.safeParse({ ...reset, entries: entries.slice(0, -1) }).success,
    ).toBe(true);
    expect(ConversationBatchSchema.safeParse({ ...reset, entries }).success).toBe(false);
  });

  it.each(["123:0", "00000000-0000-4000-8000-000000000001", "/tmp/transcript.jsonl"])(
    "requires opaque IDs instead of native source reference %s",
    (privateId) => {
      expect(ConversationEntrySchema.safeParse({ ...entry, id: privateId }).success).toBe(false);
    },
  );

  it.each([
    { oldestId: null, newestId: id("E"), retainedCount: 0 },
    { oldestId: null, newestId: null, retainedCount: 1 },
    { oldestId: id("E"), newestId: id("F"), retainedCount: 1 },
    { oldestId: id("E"), newestId: id("E"), retainedCount: 2 },
    {
      oldestId: id("E"),
      newestId: id("F"),
      retainedCount: CONVERSATION_LIMITS.retainedEntries + 1,
    },
  ])("rejects an inconsistent retained boundary", (boundary) => {
    expect(
      ConversationMessageSchema.safeParse({
        type: "conversation.applied",
        subscriptionId: id("S"),
        generation: id("G"),
        batchId: id("B"),
        revision: 1,
        ...boundary,
      }).success,
    ).toBe(false);
  });

  it("does not let an unavailable source claim it is caught up", () => {
    expect(
      ConversationMessageSchema.safeParse({
        type: "conversation.status",
        subscriptionId: id("S"),
        state: "unavailable",
        caughtUp: true,
      }).success,
    ).toBe(false);
  });
});
