import { describe, expect, it } from "vitest";
import { encodeCbor, ProtocolError } from "../src/codec.js";
import * as protocol from "../src/index.js";
import type { Line, ScreenDiff, ScreenSnapshot } from "../src/screen.js";
import type { StreamTransferMeta } from "../src/stream-wire.js";

const snapshot = (extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot => ({
  cols: 4,
  rows: 2,
  cursor: { x: 4, y: -1 },
  lines: [{ r: [{ t: "界", n: 2, fg: 1 }], w: true }, { r: [{ t: "e\u0301", n: 1 }] }],
  scrollbackTotal: 0,
  gen: 1,
  ...extra,
});
const diff = (extra: Partial<ScreenDiff> = {}): ScreenDiff => ({
  scroll: 0,
  changed: [],
  cursor: { x: 0, y: 0 },
  scrollbackTotal: 0,
  gen: 2,
  ...extra,
});
const record = (value = snapshot()) => ({ kind: "snapshot" as const, ...value });
const diffRecord = (value = diff()) => ({ kind: "diff" as const, ...value });
const meta: StreamTransferMeta = { kind: "snapshot", generation: 1 };
const read = (value: unknown, metadata: StreamTransferMeta = meta) =>
  protocol.decodeStreamScreen(metadata, encodeCbor(value));
const invalid = { ok: false, code: "invalid-transfer" };
const tooLarge = { ok: false, code: "screen-too-large" };

// Explicit zero-width combining marks exercise run/byte bounds independently of cells.
const runSnapshot = (count: number, styled = false): ScreenSnapshot => {
  const lines: Line[] = [];
  while (count > 0) {
    const size = Math.min(count, 2048);
    lines.push({
      r: Array.from({ length: size }, () =>
        styled
          ? {
              t: "\u0301",
              n: 0,
              fg: [1, 2, 3],
              bg: [4, 5, 6],
              b: true,
              i: true,
              u: true,
              s: true,
              f: true,
            }
          : { t: "\u0301", n: 0 },
      ),
    });
    count -= size;
  }
  return snapshot({ rows: lines.length, lines });
};

function byteSnapshot(target: number): ScreenSnapshot {
  const value = runSnapshot(12000, true);
  for (const line of value.lines) {
    const first = line.r[0];
    if (first) {
      first.t = "界";
      first.n = 2;
    }
  }
  const padding: Line = { r: [{ t: "a".repeat(1000), n: 0 }] };
  value.lines.push(padding);
  value.rows++;
  let remaining = target - encodeCbor(record(value)).length;
  while (remaining > 3000) {
    padding.r.push({ t: "a".repeat(2990), n: 0 });
    remaining = target - encodeCbor(record(value)).length;
  }
  const first = padding.r[0];
  if (!first) throw new Error("fixture has no padding");
  first.t += "a".repeat(remaining);
  // The final string may cross a CBOR length-header boundary.
  first.t = first.t.slice(0, first.t.length + target - encodeCbor(record(value)).length);
  expect(encodeCbor(record(value)).length).toBe(target);
  return value;
}

describe("bounded stream screen API", () => {
  it("exports the record schema and the four screen helpers", () => {
    for (const name of [
      "decodeStreamScreen",
      "applyStreamScreen",
      "prepareStreamSnapshot",
      "encodeStreamDiff",
    ])
      expect(Reflect.get(protocol, name), name).toBeTypeOf("function");
    expect(Reflect.get(protocol, "StreamScreenRecordSchema")).toBeDefined();
  });
});

describe("strict bounded screen records", () => {
  it("rejects foreign fields and kind injection into local inputs", () => {
    const value = Object.assign(snapshot(), { kind: "snapshot" });
    expect(protocol.prepareStreamSnapshot(value)).toEqual(invalid);
    expect(protocol.applyStreamScreen(value, diffRecord())).toEqual(invalid);
    expect(() => protocol.encodeStreamDiff(Object.assign(diff(), { kind: "diff" }))).toThrow(
      ProtocolError,
    );
    const forged = Object.assign(snapshot(), { kind: "snapshot" });
    expect(() => protocol.encodeStreamDiff(forged as unknown as ScreenDiff)).toThrow(ProtocolError);
  });

  it("roundtrips all style fields, explicit widths, wrapping, supplementary pairs and leading BOM", () => {
    const value = snapshot({
      lines: [
        {
          r: [
            {
              t: "\ufeff界🚀",
              n: 3,
              fg: 255,
              bg: [0, 128, 255],
              b: true,
              i: false,
              u: true,
              s: false,
              f: true,
            },
          ],
          w: false,
        },
        { r: [] },
      ],
    });
    const prepared = protocol.prepareStreamSnapshot(value);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(read(record(value))).toEqual(record(value));
    expect(protocol.decodeStreamScreen(meta, prepared.bytes)).toEqual(record(value));
    expect(prepared.snapshot).toEqual(value);
    expect(protocol.StreamScreenRecordSchema.safeParse(record(value)).success).toBe(true);
    const changes = diff({ changed: [{ i: 1, line: { r: [{ t: "x", fg: [1, 2, 3], bg: 0 }] } }] });
    expect(
      protocol.decodeStreamScreen(
        { kind: "diff", generation: 2 },
        protocol.encodeStreamDiff(changes),
      ),
    ).toEqual(diffRecord(changes));
  });

  it.each([
    ["root", (v: ReturnType<typeof record>) => Object.assign(v, { secret: "supplied-secret" })],
    [
      "line",
      (v: ReturnType<typeof record>) =>
        Object.assign(v.lines[0] ?? {}, { secret: "supplied-secret" }),
    ],
    [
      "run",
      (v: ReturnType<typeof record>) =>
        Object.assign(v.lines[0]?.r[0] ?? {}, { secret: "supplied-secret" }),
    ],
    [
      "cursor",
      (v: ReturnType<typeof record>) => Object.assign(v.cursor, { secret: "supplied-secret" }),
    ],
  ])("rejects unknown %s fields without echoing content", (_name, mutate) => {
    const value = record();
    mutate(value);
    expect(() => read(value)).toThrow(ProtocolError);
    try {
      read(value);
    } catch (error) {
      expect(String(error)).not.toContain("supplied-secret");
    }
    expect(protocol.StreamScreenRecordSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["row count", { lines: [{ r: [] }] }],
    ["zero columns", { cols: 0 }],
    ["fractional columns", { cols: 1.5 }],
    ["zero rows", { rows: 0, lines: [] }],
    ["negative cursor x", { cursor: { x: -1, y: 0 } }],
    ["cursor past wrap", { cursor: { x: 5, y: 0 } }],
    ["cursor below screen", { cursor: { x: 0, y: 2 } }],
    ["cursor below sentinel", { cursor: { x: 0, y: -2 } }],
    ["fractional cursor", { cursor: { x: 0.5, y: 0 } }],
    ["unsafe generation", { gen: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe history", { scrollbackTotal: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative history", { scrollbackTotal: -1 }],
    ["negative generation", { gen: -1 }],
    ["too many cells", { lines: [{ r: [{ t: "wide", n: 5 }] }, { r: [] }] }],
    ["overlong run", { lines: [{ r: [{ t: "x".repeat(4097), n: 0 }] }, { r: [] }] }],
    ["invalid cells", { lines: [{ r: [{ t: "x", n: -1 }] }, { r: [] }] }],
    ["oversized cells", { lines: [{ r: [{ t: "x", n: 4097 }] }, { r: [] }] }],
    ["invalid color", { lines: [{ r: [{ t: "x", fg: 256 }] }, { r: [] }] }],
  ] satisfies [string, Partial<ScreenSnapshot>][])(
    "rejects malformed %s before normalization",
    (_name, extra) => {
      const value = snapshot(extra);
      expect(protocol.prepareStreamSnapshot(value)).toEqual(invalid);
      expect(() => read(record(value))).toThrow(ProtocolError);
      expect(protocol.applyStreamScreen(undefined, record(value))).toEqual(invalid);
    },
  );

  it.each(["\ud800", "\udc00", "x\ud800y", "\udc00\ud800"])(
    "rejects unpaired UTF-16 before encoding: %j",
    (t) => {
      expect(
        protocol.prepareStreamSnapshot(snapshot({ lines: [{ r: [{ t }] }, { r: [] }] })),
      ).toEqual(invalid);
      expect(() =>
        protocol.encodeStreamDiff(diff({ changed: [{ i: 0, line: { r: [{ t }] } }] })),
      ).toThrow(ProtocolError);
    },
  );

  it("accepts exact dimensions, safe counters, run length and code-point limits", () => {
    const value = snapshot({
      cols: 512,
      rows: 256,
      gen: Number.MAX_SAFE_INTEGER,
      scrollbackTotal: Number.MAX_SAFE_INTEGER,
      cursor: { x: 512, y: 255 },
      lines: Array.from({ length: 256 }, () => ({ r: [{ t: "x".repeat(512) }] })),
    });
    const prepared = protocol.prepareStreamSnapshot(value);
    expect(prepared.ok).toBe(true);
    expect(read(record(value), { kind: "snapshot", generation: Number.MAX_SAFE_INTEGER })).toEqual(
      record(value),
    );
    expect(
      protocol.prepareStreamSnapshot(
        snapshot({ gen: 0, lines: [{ r: [{ t: "🚀".repeat(2048), n: 4 }] }, { r: [] }] }),
      ).ok,
    ).toBe(true);
  });

  it.each([
    ["columns", snapshot({ cols: 513 })],
    ["rows", snapshot({ rows: 257, lines: Array.from({ length: 257 }, () => ({ r: [] })) })],
    [
      "code points",
      snapshot({
        rows: 33,
        lines: Array.from({ length: 33 }, (_, i) => ({
          r: [{ t: "a".repeat(i === 32 ? 1 : 4096), n: 0 }],
        })),
      }),
    ],
  ])("classifies well-formed excess %s as too large without cropping", (_name, value) => {
    const before = structuredClone(value);
    expect(protocol.prepareStreamSnapshot(value)).toEqual(tooLarge);
    expect(() => read(record(value))).toThrow(ProtocolError);
    expect(value).toEqual(before);
  });

  it("rejects incoming per-line and aggregate run excess but degrades valid local source once", () => {
    const boundary = runSnapshot(32768);
    expect(read(record(boundary))).toEqual(record(boundary));
    const excess = runSnapshot(32769);
    expect(() => read(record(excess))).toThrow(ProtocolError);
    const lineExcess = snapshot({
      lines: [{ r: Array.from({ length: 2049 }, () => ({ t: "\u0301", n: 0, fg: 1 })) }, { r: [] }],
    });
    for (const value of [excess, lineExcess]) {
      expect(protocol.StreamScreenRecordSchema.safeParse(record(value)).success).toBe(false);
      const prepared = protocol.prepareStreamSnapshot(value);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.snapshot.degraded).toBe(true);
      expect(prepared.snapshot.lines.map((line) => line.r.map((r) => r.t).join(""))).toEqual(
        value.lines.map((line) => line.r.map((r) => r.t).join("")),
      );
      expect(prepared.snapshot.lines.every((line) => line.r.every((r) => r.n === 0))).toBe(true);
    }
    lineExcess.lines[0]?.r.push({ t: "x".repeat(4097), n: 0 });
    expect(protocol.prepareStreamSnapshot(lineExcess)).toEqual(invalid);
  });

  it("enforces exact encoded-byte boundary, falling back losslessly for oversized styles", () => {
    const exact = byteSnapshot(524288);
    const validation = protocol.StreamScreenRecordSchema.safeParse(record(exact));
    expect(validation.success, validation.error?.message).toBe(true);
    expect(read(record(exact))).toEqual(record(exact));
    const exactPrepared = protocol.prepareStreamSnapshot(exact);
    expect(exactPrepared.ok).toBe(true);
    if (exactPrepared.ok) expect(exactPrepared.snapshot.degraded).toBeUndefined();
    const excessive = byteSnapshot(524289);
    const before = structuredClone(excessive);
    expect(() => read(record(excessive))).toThrow(ProtocolError);
    const prepared = protocol.prepareStreamSnapshot(excessive);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.bytes.length).toBeLessThanOrEqual(524288);
    expect(prepared.snapshot.degraded).toBe(true);
    expect(prepared.snapshot.lines.map((line) => line.r.map((r) => r.t).join(""))).toEqual(
      excessive.lines.map((line) => line.r.map((r) => r.t).join("")),
    );
    expect(
      prepared.snapshot.lines.map((line) =>
        line.r.reduce((cells, run) => cells + (run.n ?? Array.from(run.t).length), 0),
      ),
    ).toEqual([2, 2, 2, 2, 2, 2, 0]);
    expect(excessive).toEqual(before);
  });

  it("rejects a plain viewport still too large after the sole fallback", () => {
    const value = snapshot({
      cols: 512,
      rows: 256,
      lines: Array.from({ length: 256 }, () => ({ r: [{ t: "🚀".repeat(512) }] })),
    });
    const before = structuredClone(value);
    expect(protocol.prepareStreamSnapshot(value)).toEqual(tooLarge);
    expect(value).toEqual(before);
  });

  it.each([
    { kind: "diff", generation: 1 },
    { kind: "snapshot", generation: 2 },
    { kind: "history", generation: 1, requestId: "a".repeat(22), before: 0 },
  ] satisfies StreamTransferMeta[])(
    "binds decoded records to authenticated metadata %j",
    (metadata) => {
      expect(() => read(record(), metadata)).toThrow(ProtocolError);
    },
  );

  it.each([
    ["zero generation", { gen: 0 }],
    ["negative scroll", { scroll: -1 }],
    ["oversized scroll", { scroll: 257 }],
    [
      "duplicate index",
      {
        changed: [
          { i: 0, line: { r: [] } },
          { i: 0, line: { r: [] } },
        ],
      },
    ],
    ["negative index", { changed: [{ i: -1, line: { r: [] } }] }],
    ["fractional index", { changed: [{ i: 0.5, line: { r: [] } }] }],
    ["oversized index", { changed: [{ i: 256, line: { r: [] } }] }],
    [
      "oversized changed",
      { changed: Array.from({ length: 257 }, (_, i) => ({ i, line: { r: [] } })) },
    ],
    ["out-of-bounds cursor", { cursor: { x: 513, y: 0 } }],
    ["oversized row", { changed: [{ i: 0, line: { r: [{ t: "a".repeat(513) }] } }] }],
  ] satisfies [string, Partial<ScreenDiff>][])("rejects standalone diff %s", (_name, extra) => {
    const value = diff(extra);
    expect(() => protocol.encodeStreamDiff(value)).toThrow(ProtocolError);
    expect(() => read(diffRecord(value), { kind: "diff", generation: value.gen })).toThrow(
      ProtocolError,
    );
  });

  it("accepts exact diff geometry but rejects encoded diff byte excess", () => {
    const value = diff({
      scroll: 256,
      changed: Array.from({ length: 256 }, (_, i) => ({ i, line: { r: [] } })),
      cursor: { x: 512, y: 255 },
    });
    expect(
      protocol.decodeStreamScreen(
        { kind: "diff", generation: 2 },
        protocol.encodeStreamDiff(value),
      ),
    ).toEqual(diffRecord(value));
    const huge = byteSnapshot(524400);
    expect(() =>
      protocol.encodeStreamDiff(diff({ changed: huge.lines.map((line, i) => ({ i, line })) })),
    ).toThrow(ProtocolError);
  });
});

describe("atomic viewport application", () => {
  it("applies scrolling and changed rows without history, carries degradation and clears one-shot reset", () => {
    const previous = snapshot({ reset: true, degraded: true });
    const result = protocol.applyStreamScreen(
      previous,
      diffRecord(
        diff({ scroll: 1, changed: [{ i: 1, line: { r: [{ t: "new" }] } }], scrollbackTotal: 1 }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      screen: {
        cols: 4,
        rows: 2,
        lines: [{ r: [{ t: "e\u0301", n: 1 }] }, { r: [{ t: "new" }] }],
        cursor: { x: 0, y: 0 },
        gen: 2,
        scrollbackTotal: 1,
        degraded: true,
      },
    });
    if (!result.ok) return;
    expect(protocol.applyStreamScreen(result.screen, record(snapshot({ gen: 3 })))).toEqual({
      ok: true,
      screen: snapshot({ gen: 3 }),
    });
    expect(protocol.applyStreamScreen(previous, diffRecord(diff({ scroll: 2 })))).toMatchObject({
      ok: true,
      screen: { lines: [{ r: [] }, { r: [] }] },
    });
  });

  it("requires a baseline and consecutive generation", () => {
    expect(protocol.applyStreamScreen(undefined, diffRecord())).toEqual({
      ok: false,
      code: "missing-baseline",
    });
    for (const gen of [1, 3])
      expect(protocol.applyStreamScreen(snapshot(), diffRecord(diff({ gen })))).toEqual({
        ok: false,
        code: "missing-baseline",
      });
  });

  it.each([
    { scroll: 3 },
    { changed: [{ i: 2, line: { r: [] } }] },
    { cursor: { x: 5, y: 0 } },
    { cursor: { x: 0, y: 2 } },
    { changed: [{ i: 0, line: { r: [{ t: "12345" }] } }] },
  ] satisfies Partial<ScreenDiff>[])(
    "rejects baseline-specific geometry atomically: %j",
    (extra) => {
      const previous = snapshot();
      const before = structuredClone(previous);
      expect(protocol.applyStreamScreen(previous, diffRecord(diff(extra)))).toEqual(invalid);
      expect(previous).toEqual(before);
    },
  );

  it("rechecks unchanged rows against resultant run, code-point and byte caps", () => {
    const runs = runSnapshot(32768);
    runs.lines.push({ r: [] });
    runs.rows++;
    const points = snapshot({
      rows: 33,
      lines: [
        ...Array.from({ length: 32 }, () => ({ r: [{ t: "a".repeat(4096), n: 0 }] })),
        { r: [] },
      ],
    });
    const bytes = byteSnapshot(524288);
    for (const previous of [runs, points, bytes]) {
      const before = structuredClone(previous);
      const index = previous.rows - 1;
      const line: Line = { r: [...(previous.lines[index]?.r ?? []), { t: "x", n: 0 }] };
      expect(
        protocol.applyStreamScreen(previous, diffRecord(diff({ changed: [{ i: index, line }] }))),
      ).toEqual(invalid);
      expect(previous).toEqual(before);
    }
  });

  it("clones all returned rows, runs, colors and cursors for snapshots, unchanged and changed rows", () => {
    const source = snapshot({ lines: [{ r: [{ t: "a", fg: [1, 2, 3] }] }, { r: [{ t: "b" }] }] });
    const initial = protocol.applyStreamScreen(undefined, record(source));
    const prepared = protocol.prepareStreamSnapshot(source);
    expect(initial.ok && prepared.ok).toBe(true);
    if (!initial.ok || !prepared.ok) return;
    const changes = diff({ changed: [{ i: 1, line: { r: [{ t: "c", bg: [4, 5, 6] }] } }] });
    const applied = protocol.applyStreamScreen(initial.screen, diffRecord(changes));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    applied.screen.cursor.x = 3;
    const fg = applied.screen.lines[0]?.r[0]?.fg;
    if (Array.isArray(fg)) fg[0] = 9;
    const changed = applied.screen.lines[1]?.r[0];
    if (changed) changed.t = "mutated";
    expect(initial.screen).toEqual(source);
    expect(changes.changed[0]?.line.r[0]?.t).toBe("c");
    initial.screen.lines[0]?.r.push({ t: "x" });
    prepared.snapshot.lines[1]?.r.push({ t: "y" });
    expect(source.lines).toEqual([{ r: [{ t: "a", fg: [1, 2, 3] }] }, { r: [{ t: "b" }] }]);
  });
});
