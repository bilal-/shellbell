import { describe, expect, it } from "vitest";
import {
  BOUNDED_STREAM_FEATURE,
  decodeCbor,
  encodeCbor,
  parseInner,
  parseInnerLoose,
  StreamChunkSchema,
  StreamMessageSchema,
  StreamTransferMetaSchema,
  supportsBoundedStream,
} from "../src/index.js";
import { parseInner as oldParseInner } from "./fixtures/legacy-protocol-20260921/inner.js";
import { parseInnerLoose as oldParseInnerLoose } from "./fixtures/legacy-protocol-20260921/loose.js";

const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
const transferId = "BBBBBBBBBBBBBBBBBBBBBB";
const requestId = "CCCCCCCCCCCCCCCCCCCCCC";
const sessionId = "tmux:1";

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    type: "stream.chunk",
    subscriptionId,
    transferId,
    sessionId,
    sequence: 1,
    index: 0,
    count: 1,
    totalBytes: 1,
    data: new Uint8Array([42]),
    meta: { kind: "snapshot", generation: 0 },
    ...overrides,
  };
}

describe("bounded stream negotiation and frozen legacy compatibility", () => {
  it("preserves the offer through current CBOR parsing while both old parsers strip it", () => {
    const hello = {
      type: "conn.hello",
      n: new Uint8Array(16),
      features: ["bounded-stream-v1"],
    };
    expect(parseInner(decodeCbor(encodeCbor(hello)))).toEqual(hello);
    expect(parseInnerLoose(hello)).toEqual(hello);
    expect(oldParseInner(hello)).toEqual({ type: "conn.hello", n: hello.n });
    expect(oldParseInnerLoose(hello)).toEqual({ type: "conn.hello", n: hello.n });
  });

  it("requires the exact feature offer on both sides", () => {
    expect(supportsBoundedStream([BOUNDED_STREAM_FEATURE], undefined)).toBe(false);
    expect(supportsBoundedStream(undefined, [BOUNDED_STREAM_FEATURE])).toBe(false);
    expect(supportsBoundedStream(["bounded-stream-v2"], [BOUNDED_STREAM_FEATURE])).toBe(false);
    expect(supportsBoundedStream([BOUNDED_STREAM_FEATURE], ["bounded-stream-v2"])).toBe(false);
    expect(supportsBoundedStream([BOUNDED_STREAM_FEATURE], [BOUNDED_STREAM_FEATURE])).toBe(true);
  });

  it("bounds the optional offer without rejecting unknown names", () => {
    const hello = { type: "conn.hello", n: new Uint8Array(16) };
    expect(parseInner(hello)).toEqual(hello);
    expect(parseInner({ ...hello, features: ["future-feature"] })).toEqual({
      ...hello,
      features: ["future-feature"],
    });
    for (const features of [[""], ["x".repeat(33)], Array(9).fill("x")]) {
      expect(() => parseInner({ ...hello, features })).toThrow(/malformed/);
    }
  });

  it("proves an old parser rejects a new chunk type", () => {
    expect(() => oldParseInner(chunk())).toThrow(/malformed/);
    expect(() => oldParseInnerLoose(chunk())).toThrow(/malformed/);
  });
});

describe("stream wire messages", () => {
  it("parses every exact stream member through both wire and inner unions", () => {
    const messages = [
      { type: "stream.subscribe", subscriptionId, sessionId },
      { type: "stream.cancel", subscriptionId },
      { type: "stream.refresh", subscriptionId },
      { type: "stream.ack", subscriptionId, through: 1 },
      { type: "stream.history.get", subscriptionId, requestId, before: 0, count: 200 },
      { type: "stream.error", subscriptionId, code: "history-reset", requestId },
      chunk(),
    ];
    for (const message of messages) {
      expect(StreamMessageSchema.parse(message)).toEqual(message);
      expect(parseInner(message)).toEqual(message);
      expect(parseInnerLoose(message)).toEqual(message);
    }
  });

  it("rejects malformed IDs, session IDs, unsafe integers and invalid history requests", () => {
    for (const badId of ["short", "a".repeat(23), `${"a".repeat(21)}+`, `${"a".repeat(21)}=`]) {
      expect(
        StreamMessageSchema.safeParse({ type: "stream.cancel", subscriptionId: badId }).success,
      ).toBe(false);
    }
    expect(
      StreamMessageSchema.safeParse({ type: "stream.subscribe", subscriptionId, sessionId: "" })
        .success,
    ).toBe(false);
    expect(
      StreamMessageSchema.safeParse({
        type: "stream.subscribe",
        subscriptionId,
        sessionId: "x".repeat(129),
      }).success,
    ).toBe(false);
    for (const through of [0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      expect(
        StreamMessageSchema.safeParse({ type: "stream.ack", subscriptionId, through }).success,
      ).toBe(false);
    }
    for (const count of [0, 201, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        StreamMessageSchema.safeParse({
          type: "stream.history.get",
          subscriptionId,
          requestId,
          before: 0,
          count,
        }).success,
      ).toBe(false);
    }
    for (const before of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        StreamMessageSchema.safeParse({
          type: "stream.history.get",
          subscriptionId,
          requestId,
          before,
          count: 1,
        }).success,
      ).toBe(false);
    }
  });

  it("preserves a bounded optional reason for history that cannot be fetched", () => {
    const message = {
      type: "stream.error",
      subscriptionId,
      requestId: "R".repeat(22),
      code: "history-unavailable",
      historyReason: "fetch-window",
    };
    expect(StreamMessageSchema.parse(message)).toEqual(message);
    expect(StreamMessageSchema.safeParse({ ...message, historyReason: "arbitrary" }).success).toBe(
      false,
    );
    const { historyReason: _reason, ...legacy } = message;
    expect(StreamMessageSchema.parse(legacy)).toEqual(legacy);
  });

  it("limits errors to the specified codes and optional request ID", () => {
    const codes = [
      "screen-too-large",
      "history-unavailable",
      "history-reset",
      "history-line-too-large",
      "stalled",
      "invalid-transfer",
      "unsupported",
      "session-gone",
    ];
    for (const code of codes) {
      expect(
        StreamMessageSchema.safeParse({ type: "stream.error", subscriptionId, code }).success,
      ).toBe(true);
    }
    expect(
      StreamMessageSchema.safeParse({ type: "stream.error", subscriptionId, code: "other" })
        .success,
    ).toBe(false);
    expect(
      StreamMessageSchema.safeParse({
        type: "stream.error",
        subscriptionId,
        code: "stalled",
        requestId: "bad",
      }).success,
    ).toBe(false);
  });

  it("requires strict metadata by transfer kind", () => {
    expect(
      StreamTransferMetaSchema.parse({ kind: "history", generation: 0, requestId, before: 0 }),
    ).toEqual({
      kind: "history",
      generation: 0,
      requestId,
      before: 0,
    });
    for (const meta of [
      { kind: "history", generation: 0, before: 0 },
      { kind: "history", generation: 0, requestId, before: 0, extra: 1 },
      { kind: "snapshot", generation: 0, requestId, before: 0 },
      { kind: "diff", generation: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "history", generation: 0, requestId, before: -1 },
    ]) {
      expect(StreamTransferMetaSchema.safeParse(meta).success).toBe(false);
    }
  });

  it("accepts a complete 16 KiB chunk and a 512 KiB screen's 32nd chunk", () => {
    const fullChunk = chunk({ totalBytes: 16384, data: new Uint8Array(16384) });
    expect(StreamChunkSchema.safeParse(fullChunk).success).toBe(true);
    expect(parseInner(decodeCbor(encodeCbor(fullChunk)))).toEqual(fullChunk);
    expect(
      StreamChunkSchema.safeParse(
        chunk({ index: 1, count: 2, totalBytes: 16385, data: new Uint8Array(1) }),
      ).success,
    ).toBe(true);
    expect(
      StreamChunkSchema.safeParse(
        chunk({
          sequence: 32,
          index: 31,
          count: 32,
          totalBytes: 524288,
          data: new Uint8Array(16384),
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a 64 KiB history boundary and rejects one byte more", () => {
    const history = { kind: "history", generation: 0, requestId, before: 0 };
    expect(
      StreamChunkSchema.safeParse(
        chunk({
          meta: history,
          index: 3,
          count: 4,
          totalBytes: 65536,
          data: new Uint8Array(16384),
        }),
      ).success,
    ).toBe(true);
    expect(
      StreamChunkSchema.safeParse(
        chunk({
          meta: history,
          index: 0,
          count: 5,
          totalBytes: 65537,
          data: new Uint8Array(16384),
        }),
      ).success,
    ).toBe(false);
    expect(
      StreamChunkSchema.safeParse(chunk({ totalBytes: 524289, data: new Uint8Array(16384) }))
        .success,
    ).toBe(false);
  });

  it("rejects mismatched count, index, payload remainder and invalid sequence", () => {
    for (const bad of [
      { sequence: 0 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { count: 0 },
      { count: 33 },
      { index: 1 },
      { index: 32 },
      { totalBytes: 0, data: new Uint8Array(0) },
      { totalBytes: 16385, count: 1, data: new Uint8Array(16384) },
      { totalBytes: 16385, count: 2, index: 0, data: new Uint8Array(16383) },
      { totalBytes: 16385, count: 2, index: 1, data: new Uint8Array(2) },
      { totalBytes: 16384, data: new Uint8Array(16385) },
      { totalBytes: 1, data: new Uint8Array(2) },
    ]) {
      expect(StreamChunkSchema.safeParse(chunk(bad)).success).toBe(false);
    }
  });
});
