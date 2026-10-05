import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  ClientOriginatedMessageSchema,
  CoordRangeSchema,
  CoordSchema,
  GetBufferResponseSchema,
  GetPropertyRequestSchema,
  GetPropertyResponseSchema,
  LineContentsSchema,
  RangeSchema,
  ServerOriginatedMessageSchema,
  WindowedCoordRangeSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import * as history from "../src/backends/iterm2/history.js";

interface WireField {
  readonly number: number;
  readonly type: number;
  readonly value: bigint | Uint8Array;
}

function readVarint(bytes: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  for (let shift = 0n; ; shift += 7n) {
    const byte = bytes[offset++];
    if (byte === undefined) throw new Error("truncated varint");
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset];
  }
}

function wireFields(bytes: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const [tag, afterTag] = readVarint(bytes, offset);
    const number = Number(tag >> 3n);
    const type = Number(tag & 7n);
    if (type === 0) {
      const [value, afterValue] = readVarint(bytes, afterTag);
      fields.push({ number, type, value });
      offset = afterValue;
    } else if (type === 2) {
      const [length, afterLength] = readVarint(bytes, afterTag);
      const end = afterLength + Number(length);
      if (end > bytes.length) throw new Error("truncated length-delimited field");
      fields.push({ number, type, value: bytes.slice(afterLength, end) });
      offset = end;
    } else {
      throw new Error(`unsupported wire type ${type}`);
    }
  }
  return fields;
}

function fieldBytes(fields: WireField[], number: number): Uint8Array {
  const value = fields.find((field) => field.number === number)?.value;
  if (!(value instanceof Uint8Array)) throw new Error(`missing bytes field ${number}`);
  return value;
}

function bufferRange(
  from: number,
  to: number,
  options: {
    status?: number;
    start?: { x: number; y: bigint };
    end?: { x: number; y: bigint };
    columns?: { location: bigint; length: bigint };
    count?: number;
  } = {},
) {
  const count = options.count ?? to - from;
  return create(GetBufferResponseSchema, {
    status: options.status ?? 0,
    contents: Array.from({ length: count }, () => create(LineContentsSchema)),
    windowedCoordRange: create(WindowedCoordRangeSchema, {
      coordRange: create(CoordRangeSchema, {
        start:
          options.start === undefined
            ? create(CoordSchema, { x: 0, y: BigInt(from) })
            : create(CoordSchema, options.start),
        end:
          options.end === undefined
            ? create(CoordSchema, { x: 0, y: BigInt(to) })
            : create(CoordSchema, options.end),
      }),
      ...(options.columns === undefined ? {} : { columns: create(RangeSchema, options.columns) }),
    }),
  });
}

describe("parseHistoryFacts", () => {
  it("derives origin independently from first visible row", () => {
    expect(
      history.parseHistoryFacts('{"overflow":7,"history":3,"grid":24,"first_visible":2}'),
    ).toEqual({ overflow: 7, history: 3, grid: 24, firstVisible: 2, origin: 10 });
  });

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"overflow":"7","history":3,"grid":24,"first_visible":2}',
    '{"overflow":true,"history":3,"grid":24,"first_visible":2}',
    '{"overflow":-1,"history":3,"grid":24,"first_visible":2}',
    '{"overflow":7.5,"history":3,"grid":24,"first_visible":2}',
    '{"overflow":7,"history":3,"grid":0,"first_visible":2}',
    '{"overflow":9007199254740992,"history":3,"grid":24,"first_visible":2}',
    '{"overflow":9007199254740991,"history":1,"grid":24,"first_visible":2}',
  ])("rejects malformed or unsafe facts: %s", (json) => {
    expect(history.parseHistoryFacts(json)).toBeNull();
  });

  it("allows unrelated object keys", () => {
    expect(
      history.parseHistoryFacts(
        '{"overflow":7,"history":3,"grid":24,"first_visible":2,"other":"ignored"}',
      ),
    ).toMatchObject({ origin: 10 });
  });
});

describe("hasFullRowRange", () => {
  it("accepts exact full-row evidence including an empty exact range", () => {
    expect(history.hasFullRowRange(bufferRange(3, 5), 3, 5)).toBe(true);
    expect(history.hasFullRowRange(bufferRange(3, 3), 3, 3)).toBe(true);
    expect(
      history.hasFullRowRange(bufferRange(3, 5, { columns: { location: 0n, length: 0n } }), 3, 5),
    ).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid from argument before coordinate conversion: %s",
    (from) => {
      expect(history.hasFullRowRange(bufferRange(0, 1), from, 1)).toBe(false);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid to argument before coordinate conversion: %s",
    (to) => {
      expect(history.hasFullRowRange(bufferRange(0, 1), 0, to)).toBe(false);
    },
  );

  it("rejects a backwards range", () => {
    expect(history.hasFullRowRange(bufferRange(0, 1), 1, 0)).toBe(false);
  });

  it.each([
    ["non-OK status", bufferRange(3, 5, { status: 1 })],
    [
      "missing start",
      create(GetBufferResponseSchema, {
        contents: [create(LineContentsSchema), create(LineContentsSchema)],
        windowedCoordRange: create(WindowedCoordRangeSchema, {
          coordRange: create(CoordRangeSchema, { end: create(CoordSchema, { x: 0, y: 5n }) }),
        }),
      }),
    ],
    [
      "missing end",
      create(GetBufferResponseSchema, {
        contents: [create(LineContentsSchema), create(LineContentsSchema)],
        windowedCoordRange: create(WindowedCoordRangeSchema, {
          coordRange: create(CoordRangeSchema, { start: create(CoordSchema, { x: 0, y: 3n }) }),
        }),
      }),
    ],
    ["partial row start", bufferRange(3, 5, { start: { x: 1, y: 3n } })],
    ["partial row end", bufferRange(3, 5, { end: { x: 1, y: 5n } })],
    ["wrong start", bufferRange(3, 5, { start: { x: 0, y: 2n } })],
    ["wrong end", bufferRange(3, 5, { end: { x: 0, y: 4n } })],
    ["unsafe start coordinate", bufferRange(3, 5, { start: { x: 0, y: 9007199254740992n } })],
    ["unsafe end coordinate", bufferRange(3, 5, { end: { x: 0, y: 9007199254740992n } })],
    ["nonzero column location", bufferRange(3, 5, { columns: { location: 1n, length: 0n } })],
    ["nonzero column length", bufferRange(3, 5, { columns: { location: 0n, length: 1n } })],
    ["short contents", bufferRange(3, 5, { count: 1 })],
    ["extra contents", bufferRange(3, 5, { count: 3 })],
  ])("rejects %s", (_name, response) => {
    expect(history.hasFullRowRange(response, 3, 5)).toBe(false);
  });
});

describe("GetProperty wire transport", () => {
  it("encodes the request wrapper at 112 and session identifier at 3", () => {
    const bytes = toBinary(
      ClientOriginatedMessageSchema,
      create(ClientOriginatedMessageSchema, {
        id: 9n,
        submessage: {
          case: "getPropertyRequest",
          value: create(GetPropertyRequestSchema, {
            identifier: { case: "sessionId", value: "S1" },
            name: "history",
          }),
        },
      }),
    );

    const outer = wireFields(bytes);
    expect(outer.map(({ number, type }) => [number, type])).toEqual([
      [1, 0],
      [112, 2],
    ]);
    const property = wireFields(fieldBytes(outer, 112));
    expect(property.map(({ number, type }) => [number, type])).toEqual([
      [2, 2],
      [3, 2],
    ]);
    expect(new TextDecoder().decode(fieldBytes(property, 3))).toBe("S1");
  });

  it("encodes the response wrapper at 112 without relying on a self-roundtrip", () => {
    const bytes = toBinary(
      ServerOriginatedMessageSchema,
      create(ServerOriginatedMessageSchema, {
        id: 9n,
        submessage: {
          case: "getPropertyResponse",
          value: create(GetPropertyResponseSchema, { status: 2, jsonValue: '{"x":1}' }),
        },
      }),
    );

    const outer = wireFields(bytes);
    expect(outer.map(({ number, type }) => [number, type])).toEqual([
      [1, 0],
      [112, 2],
    ]);
    const property = wireFields(fieldBytes(outer, 112));
    expect(property.map(({ number, type }) => [number, type])).toEqual([
      [1, 0],
      [2, 2],
    ]);
    expect(property[0]?.value).toBe(2n);
    expect(new TextDecoder().decode(fieldBytes(property, 2))).toBe('{"x":1}');
  });
});
