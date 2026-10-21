import { describe, expect, it } from "vitest";
import {
  acceptsContinuation,
  CONTINUATION_EXTENSIONS,
  decodeCbor,
  encodeCbor,
  parseInner,
  parseInnerLoose,
  StreamMessageSchema,
  StreamTransferMetaSchema,
  selectStreamExtensions,
} from "../src/index.js";

const subscriptionId = "S".repeat(22);
const capture = "C".repeat(22);

describe("per-subscription continuation negotiation", () => {
  it("accepts the whole set or none, independently for each peer", () => {
    expect(selectStreamExtensions(undefined, CONTINUATION_EXTENSIONS)).toEqual([]);
    for (const missing of CONTINUATION_EXTENSIONS) {
      const partial = CONTINUATION_EXTENSIONS.filter((name) => name !== missing);
      expect(selectStreamExtensions(partial, CONTINUATION_EXTENSIONS)).toEqual([]);
      expect(selectStreamExtensions(CONTINUATION_EXTENSIONS, partial)).toEqual([]);
      expect(acceptsContinuation(CONTINUATION_EXTENSIONS, partial)).toBe(false);
    }
    expect(
      selectStreamExtensions([...CONTINUATION_EXTENSIONS, "future"], CONTINUATION_EXTENSIONS),
    ).toEqual(CONTINUATION_EXTENSIONS);
    expect(acceptsContinuation(CONTINUATION_EXTENSIONS, CONTINUATION_EXTENSIONS)).toBe(true);
    expect(acceptsContinuation([], CONTINUATION_EXTENSIONS)).toBe(false);
    expect(
      acceptsContinuation(CONTINUATION_EXTENSIONS, [...CONTINUATION_EXTENSIONS, "future"]),
    ).toBe(false);
  });

  it("carries bounded offers, acceptance and applied/status controls through both inner parsers", () => {
    const messages = [
      {
        type: "stream.subscribe",
        subscriptionId,
        sessionId: "tmux:1",
        mode: "vt",
        extensions: [...CONTINUATION_EXTENSIONS, "future"],
      },
      { type: "stream.accepted", subscriptionId, extensions: [...CONTINUATION_EXTENSIONS] },
      { type: "stream.applied", subscriptionId, capture, generation: 1, offset: 0 },
      {
        type: "stream.status",
        subscriptionId,
        capture,
        generation: 1,
        offset: 42,
        state: "quiescent",
      },
    ];
    for (const message of messages) {
      const decoded = decodeCbor(encodeCbor(message));
      expect(parseInner(decoded)).toEqual(message);
      expect(parseInnerLoose(decoded)).toEqual(message);
    }
    for (const extensions of [[""], ["x".repeat(65)], Array(17).fill("future")]) {
      expect(StreamMessageSchema.safeParse({ ...messages[0], extensions }).success).toBe(false);
      expect(StreamMessageSchema.safeParse({ ...messages[1], extensions }).success).toBe(false);
    }
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(StreamMessageSchema.safeParse({ ...messages[2], offset }).success).toBe(false);
      expect(StreamMessageSchema.safeParse({ ...messages[3], offset }).success).toBe(false);
    }
    expect(StreamMessageSchema.safeParse({ ...messages[2], capture: "bad" }).success).toBe(false);
  });

  it("keeps negotiated seed metadata flat, bounded and strict", () => {
    const meta = {
      kind: "vt-seed",
      generation: 1,
      cols: 80,
      rows: 24,
      capture,
      disposition: "discontinuity",
      reason: "resize",
      cursor: "guessed",
      alternate: "unknown",
    };
    expect(StreamTransferMetaSchema.parse(meta)).toEqual(meta);
    for (const change of [
      { capture: "bad" },
      { cols: 513 },
      { rows: 257 },
      { cursor: "inferred" },
      { alternate: "guessed" },
      { disposition: "continuous" },
      { reason: "unknown" },
      { sourceHistory: true },
    ])
      expect(StreamTransferMetaSchema.safeParse({ ...meta, ...change }).success).toBe(false);
  });
});
