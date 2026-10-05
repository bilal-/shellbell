import { describe, expect, it } from "vitest";
import { encodeCbor, ProtocolError } from "../src/codec.js";
import * as protocol from "../src/index.js";
import type { Line } from "../src/screen.js";
import type { StreamTransferMeta } from "../src/stream-wire.js";

const requestId = "AAAAAAAAAAAAAAAAAAAAAA";
const meta: StreamTransferMeta = { kind: "history", generation: 7, requestId, before: 3 };
const page = (
  lines: Line[] = [{ r: [{ t: "old", fg: [1, 2, 3] }] }, { r: [], w: false }],
  before = 3,
) => ({
  kind: "history" as const,
  generation: 7,
  requestId,
  before,
  status: "page" as const,
  from: before - lines.length,
  to: before,
  oldestAvailable: 0,
  lines,
});
const boundary = (reason = "end", before = 10, oldestAvailable = 10) => ({
  kind: "history",
  generation: 7,
  requestId,
  before,
  status: "boundary",
  reason,
  oldestAvailable,
});
const invalid = { ok: false, code: "invalid-transfer" };
const oversized = (before = 3) => ({ ok: false, code: "history-line-too-large", before });
const read = (value: unknown, metadata = meta) =>
  protocol.decodeStreamHistory(metadata, encodeCbor(value));
function packed(value: unknown) {
  const result = protocol.prepareStreamHistory(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected packed history");
  return result;
}
// Zero-cell styled text isolates encoded-byte limits from declared row geometry.
function bytePage(target: number, before = 3) {
  const lines: Line[] = [
    { r: Array.from({ length: 15 }, () => ({ t: "a".repeat(4096), n: 0, fg: [1, 2, 3] })) },
  ];
  const padding = { t: "a".repeat(1000), n: 0 };
  lines[0]!.r.push(padding);
  const source = page(lines, before);
  const length = () => encodeCbor({ ...source, nextBefore: source.from }).length;
  padding.t += "a".repeat(target - length());
  padding.t = padding.t.slice(0, padding.t.length + target - length());
  expect(length()).toBe(target);
  expect(padding.t.length).toBeLessThanOrEqual(4096);
  return source;
}

describe("bounded stream history records", () => {
  it("exports the public helpers and round-trips a lossless page", () => {
    expect(protocol.prepareStreamHistory).toBeTypeOf("function");
    expect(protocol.decodeStreamHistory).toBeTypeOf("function");
    expect(protocol.StreamHistoryRecordSchema).toBeDefined();
    expect(protocol.STREAM_LIMITS.historyCells).toBe(4096);
    const result = packed(page());
    expect(result.record).toEqual({ ...page(), nextBefore: 1 });
    expect(protocol.decodeStreamHistory(meta, result.bytes)).toEqual(result.record);
  });
  it("owns nested lines, runs, RGB colors and bytes independently", () => {
    const source = page([{ r: [{ t: "old", fg: [1, 2, 3], bg: [4, 5, 6] }] }, { r: [], w: false }]);
    const result = packed(source);
    const original = structuredClone(result.record);
    (source.lines[0]!.r[0]!.fg as number[])[0] = 99;
    (source.lines[0]!.r[0]!.bg as number[])[0] = 99;
    source.lines[0]!.r[0]!.t = "changed";
    source.lines[1]!.w = true;
    source.lines.push({ r: [] });
    expect(result.record).toEqual(original);
    if (result.record.status === "page") result.record.lines[0]!.r[0]!.t = "again";
    expect(protocol.decodeStreamHistory(meta, result.bytes)).toEqual(original);
    const decoded = protocol.decodeStreamHistory(meta, result.bytes);
    result.bytes.fill(0);
    expect(decoded).toEqual(original);
  });
  it.each([
    ["end", 10, 10],
    ["truncated", 9, 10],
  ])("accepts explicit %s boundaries", (reason, before, oldest) => {
    const result = packed(boundary(reason as string, before as number, oldest as number));
    expect(
      protocol.decodeStreamHistory({ ...meta, before: before as number }, result.bytes),
    ).toEqual(result.record);
  });
  it.each([
    ["end", 9, 10],
    ["end", 11, 10],
    ["truncated", 10, 10],
    ["truncated", 11, 10],
    ["busy", 10, 10],
  ])("rejects unsupported boundary %s %i %i", (reason, before, oldest) => {
    expect(
      protocol.prepareStreamHistory(boundary(reason as string, before as number, oldest as number)),
    ).toEqual(invalid);
  });
  it.each([
    { generation: -1 },
    { generation: 0.5 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { generation: NaN },
    { generation: Infinity },
    { before: -1 },
    { before: 3.5 },
    { from: -1 },
    { from: 2 },
    { to: 4 },
    { oldestAvailable: 2 },
    { oldestAvailable: -1 },
    { requestId: "short" },
    { requestId: "!".repeat(22) },
    { kind: "snapshot" },
    { extra: true },
    { nextBefore: 1 },
    { lines: [] },
    { lines: "invalid" },
    { before: Number.MAX_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER, from: Number.MAX_SAFE_INTEGER },
  ])("rejects malformed source header %j", (extra) => {
    expect(protocol.prepareStreamHistory({ ...page(), ...extra })).toEqual(invalid);
  });
  it.each([
    { r: [], extra: true },
    { r: [], w: 0 },
    { r: "bad" },
    { r: [{ t: "x", extra: 1 }] },
    { r: [{ t: "x", fg: [1, 2] }] },
    { r: [{ t: "x", fg: [1, 2, 3, 4] }] },
    { r: [{ t: "x", bg: [1, 2, 256] }] },
    { r: [{ t: "x", fg: { r: 1, g: 2, b: 3 } }] },
    { r: [{ t: "x", fg: -1 }] },
    { r: [{ t: "x", n: 4097 }] },
    { r: [{ t: "x", n: -1 }] },
    { r: [{ t: "x", n: 0.5 }] },
    { r: [{ t: "x", b: 1 }] },
    { r: [{ t: "x".repeat(4097) }] },
    { r: [{ t: "\ud800" }] },
    { r: [{ t: "\udc00" }] },
    { r: [{ t: "\ud800a" }] },
  ])("rejects malformed admitted row %j", (line) => {
    expect(protocol.prepareStreamHistory({ ...page(), from: 2, lines: [line] })).toEqual(invalid);
  });
  it("preserves scalar text, BOM, combining text, widths and explicit flags", () => {
    const source = page([
      {
        r: [
          {
            t: "\ufeff界e\u0301😀",
            n: 3,
            fg: 255,
            bg: [0, 255, 4],
            b: false,
            i: true,
            u: false,
            s: true,
            f: false,
          },
        ],
        w: false,
      },
    ]);
    expect(packed(source).record).toEqual({ ...source, nextBefore: 2 });
  });
  it("accepts the safe counter ceiling without overflowing", () => {
    const source = page([{ r: [] }], Number.MAX_SAFE_INTEGER);
    expect(packed(source).record).toEqual({ ...source, nextBefore: Number.MAX_SAFE_INTEGER - 1 });
  });
  it("accepts 200 rows and rejects 201 without inspecting excess rows", () => {
    const lines: Line[] = Array.from({ length: 200 }, () => ({ r: [] }));
    expect(packed(page(lines, 200)).record).toMatchObject({ from: 0, nextBefore: 0 });
    lines.push(
      Object.defineProperty({}, "r", {
        get() {
          throw new Error("excess row scanned");
        },
      }) as Line,
    );
    expect(protocol.prepareStreamHistory(page(lines, 201))).toEqual(invalid);
  });
  it("distinguishes 4096/4097 cumulative cells and keeps the newer suffix", () => {
    const wide: Line = {
      r: [
        { t: "x", n: 4096 },
        { t: "y", n: 1 },
      ],
    };
    expect(packed(page([{ r: [{ t: "x", n: 4096 }] }])).record).toMatchObject({ from: 2 });
    expect(protocol.prepareStreamHistory(page([wide]))).toEqual(oversized());
    expect(packed(page([wide, { r: [{ t: "newest" }] }])).record).toMatchObject({
      from: 2,
      nextBefore: 2,
    });
    expect(
      protocol.prepareStreamHistory(page([{ r: [{ t: "a".repeat(4096) }, { t: "😀" }] }])),
    ).toEqual(oversized());
  });
  it("bounds 2048/2049 runs before scanning excess and stops at an older oversized row", () => {
    const line: Line = { r: Array.from({ length: 2048 }, () => ({ t: "", n: 0 })) };
    expect(packed(page([line])).record).toMatchObject({ from: 2 });
    line.r.push(
      Object.defineProperty({}, "t", {
        get() {
          throw new Error("excess run scanned");
        },
      }) as Line["r"][number],
    );
    expect(protocol.prepareStreamHistory(page([line]))).toEqual(oversized());
    expect(packed(page([{ r: [{ t: "\ud800" }] }, line, { r: [] }])).record).toMatchObject({
      from: 2,
      nextBefore: 2,
    });
  });
  it.each([65535, 65536, 65537])("measures full record bytes at %i", (bytes) => {
    const source = bytePage(bytes);
    if (bytes <= 65536) expect(packed(source).bytes.length).toBe(bytes);
    else expect(protocol.prepareStreamHistory(source)).toEqual(oversized());
    const full = { ...source, nextBefore: source.from };
    expect(protocol.StreamHistoryRecordSchema.safeParse(full).success).toBe(bytes <= 65536);
    if (bytes > 65536) expect(() => read(full)).toThrow(ProtocolError);
  });
  it("bounds encoded runs before reaching later malformed zero-cell text", () => {
    const line: Line = {
      r: Array.from({ length: 2048 }, () => ({ t: "界".repeat(4096), n: 0, fg: [1, 2, 3] })),
    };
    line.r[100] = { t: "\ud800" };
    expect(protocol.prepareStreamHistory(page([line]))).toEqual(oversized());
    expect(packed(page([line, { r: [] }])).record).toMatchObject({ from: 2 });
  });
  it("rejects encountered malformed older rows instead of concealing them", () => {
    expect(protocol.prepareStreamHistory(page([{ r: [{ t: "\ud800" }] }, { r: [] }]))).toEqual(
      invalid,
    );
  });
  it.each([24, 256, 65536, 2 ** 32])(
    "matches exhaustive suffix encoding around counter %i",
    (before) => {
      const lines = [{ r: [] }, ...bytePage(65500, before).lines, { r: [] }, { r: [] }];
      for (let offset = -1; offset <= 1; offset++) {
        const source = page(lines, before + offset);
        let expected: unknown;
        for (let i = lines.length - 1; i >= 0; i--) {
          const candidate = {
            ...source,
            from: source.from + i,
            nextBefore: source.from + i,
            lines: lines.slice(i),
          };
          if (encodeCbor(candidate).length <= 65536) expected = candidate;
        }
        expect(packed(source).record).toEqual(expected);
      }
    },
  );
  it("finds a fitting suffix after a smaller suffix overflows at a shrinking counter header", () => {
    const newest = bytePage(65538, 2 ** 32 + 1);
    const source = page([{ r: [] }, ...newest.lines], newest.before);
    const full = { ...source, nextBefore: source.from };
    expect(encodeCbor(full).length).toBe(65534);
    expect(packed(source).record).toEqual(full);
  });
  it("pages without gaps or duplicates and leaves an oversized cursor explicit", () => {
    const lines: Line[] = Array.from({ length: 30 }, (_, i) => ({
      r: [{ t: `${i}:${"x".repeat(3000)}`, n: 0 }],
    }));
    let before = lines.length;
    const indices: number[] = [];
    while (before > 0) {
      const result = packed(page(lines.slice(0, before), before));
      if (result.record.status !== "page") throw new Error("expected page");
      expect(result.record.to).toBe(before);
      indices.unshift(...result.record.lines.map((line) => Number(line.r[0]!.t.split(":")[0])));
      before = result.record.nextBefore;
    }
    expect(indices).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const wide = { r: [{ t: "x", n: 4096 }, { t: "y" }] };
    const first = packed(page([wide, { r: [] }], 2));
    expect(first.record).toMatchObject({ nextBefore: 1 });
    expect(protocol.prepareStreamHistory(page([wide], 1))).toEqual(oversized(1));
  });
  it.each([
    { kind: "snapshot", generation: 7 },
    { ...meta, generation: 8 },
    { ...meta, before: 4 },
    { ...meta, requestId: "BBBBBBBBBBBBBBBBBBBBBB" },
    { ...meta, extra: true },
  ])("requires exact transfer metadata %j", (metadata) => {
    expect(() =>
      protocol.decodeStreamHistory(metadata as StreamTransferMeta, packed(page()).bytes),
    ).toThrow(ProtocolError);
  });
  it.each([{ nextBefore: 0 }, { lines: [] }, { extra: true }, { to: 4 }])(
    "strictly validates decoded page %j",
    (extra) => {
      expect(() => read({ ...page(), nextBefore: 1, ...extra })).toThrow(ProtocolError);
    },
  );
  it("rejects page-only fields on boundaries", () => {
    expect(protocol.prepareStreamHistory({ ...boundary(), lines: [] })).toEqual(invalid);
    expect(() => read({ ...boundary(), nextBefore: 10 }, { ...meta, before: 10 })).toThrow(
      ProtocolError,
    );
  });
  it("rejects malformed, deep and oversized CBOR without terminal content in diagnostics", () => {
    const sentinel = "PRIVATE_TERMINAL_SENTINEL";
    let deep: unknown = sentinel;
    for (let i = 0; i < 20; i++) deep = [deep];
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0xff]),
      new Uint8Array(65537),
      encodeCbor(deep),
      encodeCbor({ ...page([{ r: [{ t: sentinel, n: -1 }] }]), nextBefore: 2 }),
    ]) {
      try {
        protocol.decodeStreamHistory(meta, bytes);
        throw new Error("unexpected success");
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect(String(error)).not.toContain(sentinel);
      }
    }
  });
});
