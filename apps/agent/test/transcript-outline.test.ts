import { describe, expect, it } from "vitest";
import { TranscriptDocument } from "../src/conversation/transcript-document.js";
import { TRANSCRIPT_READ_BYTES } from "../src/conversation/transcript-file.js";
import {
  TRANSCRIPT_LINE_BYTES,
  TranscriptJsonl,
  type TranscriptLine,
} from "../src/conversation/transcript-jsonl.js";
import {
  TRANSCRIPT_OMITTED,
  type TranscriptOutline,
  TranscriptOutlineReader,
} from "../src/conversation/transcript-outline.js";
import {
  decodeTranscriptRecord,
  type TranscriptRecord,
  transcriptOutline,
} from "../src/conversation/transcript-record.js";

const session = "11111111-1111-4111-8111-111111111111";
const LARGE = "x".repeat(TRANSCRIPT_LINE_BYTES + 70_000);

function lines(text: string, outline: TranscriptOutline | null, window = TRANSCRIPT_READ_BYTES) {
  const bytes = Buffer.from(text);
  const decoder = new TranscriptJsonl(0, false, outline);
  const out: TranscriptLine[] = [];
  for (let at = 0; at < bytes.length; ) {
    const result = decoder.push(bytes.subarray(at, at + window));
    out.push(...result.lines);
    at += result.consumed;
  }
  return out;
}
function decode(values: readonly unknown[], outline = true): TranscriptRecord[] {
  const text = values.map((value) => `${JSON.stringify(value)}\n`).join("");
  return lines(text, outline ? transcriptOutline("claude") : null).map((line) =>
    decodeTranscriptRecord("claude", line),
  );
}
/** The same record as a buffered line, with the large text already replaced. */
function buffered(value: unknown): TranscriptRecord {
  const text = JSON.stringify(value).replaceAll(LARGE, TRANSCRIPT_OMITTED);
  return decode([JSON.parse(text)], false)[0]!;
}
function read(text: string, outline: TranscriptOutline, split: number) {
  const reader = new TranscriptOutlineReader(outline);
  const bytes = Buffer.from(text);
  reader.push(bytes.subarray(0, split));
  reader.push(bytes.subarray(split));
  return reader.finish();
}

describe("oversized transcript lines", () => {
  it("accepts and rejects the same lines JSON.parse does, at every split", () => {
    const outline: TranscriptOutline = {
      keys: { a: {}, b: { items: {} }, c: { keys: { d: {} } }, "é\n": {} },
    };
    const inputs = [
      '{"a":1}',
      ' {"a" : -0.5e+3 , "b" : [true,false,null,"s\\u00e9\\n"] } ',
      '{"c":{"d":"\\"q\\"","e":[{"f":1}]},"z":{"y":[1,[2,[3]]]}}',
      '{"\\u00e9\\n":"key escape","a":"🐈"}',
      '{"a":[],"b":[],"c":{}}',
      "{}",
      "[]",
      '"text"',
      "1",
      "{",
      '{"a":}',
      '{"a":1,}',
      '{"a" 1}',
      '{"a":01}',
      '{"a":1.}',
      '{"a":tru}',
      '{"a":"\\x"}',
      '{"a":"\\u12g4"}',
      '{"a":"tab\there"}',
      '{"a":1}{}',
      '{"a":1} x',
      "[1,]",
      '{"a":[1 2]}',
      '{"a":1]',
    ];
    for (const input of inputs) {
      let expected: unknown;
      try {
        expected = JSON.parse(input);
      } catch {
        expected = undefined;
      }
      const object =
        typeof expected === "object" && expected !== null && !Array.isArray(expected)
          ? (expected as Record<string, unknown>)
          : null;
      for (let split = 0; split <= Buffer.byteLength(input); split++) {
        const result = read(input, outline, split);
        if (!object) {
          expect(result, input).toEqual({ kind: "skipped", reason: "invalid-json" });
          continue;
        }
        expect(result?.kind, input).toBe("record");
        if (result?.kind !== "record") continue;
        for (const name of ["a", "b", "é\n"]) expect(result.value[name]).toEqual(object[name]);
        if (object.c) expect(result.value.c).toEqual({ d: (object.c as { d?: string }).d });
        expect(result.value).not.toHaveProperty("z");
      }
    }
  });

  it("rejects invalid UTF-8 and ignores a line of only spaces", () => {
    const reader = new TranscriptOutlineReader({});
    reader.push(Buffer.from('{"a":"'));
    reader.push(Uint8Array.of(0xc3));
    reader.push(Buffer.from('"}'));
    expect(reader.finish()).toEqual({ kind: "skipped", reason: "invalid-utf8" });
    expect(read("   ", {}, 1)).toBeNull();
  });

  it("keeps only listed text and replaces long text", () => {
    const value = {
      a: LARGE,
      b: ["short", LARGE],
      dropped: Array.from({ length: 50_000 }, (_, i) => `line ${i}`),
    };
    const result = read(JSON.stringify(value), { keys: { a: {}, b: { items: {} } } }, 7);
    expect(result).toEqual({
      kind: "record",
      value: { a: TRANSCRIPT_OMITTED, b: ["short", TRANSCRIPT_OMITTED] },
    });
  });

  it("stops keeping text after its budget but still reads the line", () => {
    const parts = Array.from({ length: 20 }, () => "y".repeat(10_000));
    const result = read(JSON.stringify({ parts }), { keys: { parts: { items: {} } } }, 3);
    if (result?.kind !== "record") throw new Error("unread");
    const kept = result.value.parts as string[];
    expect(kept).toHaveLength(20);
    expect(kept.slice(0, 13).every((part) => part.length === 10_000)).toBe(true);
    expect(kept.slice(13).every((part) => part === TRANSCRIPT_OMITTED)).toBe(true);
  });

  it("keeps short fields that come after text has used up the budget", () => {
    // Claude Code writes `uuid`, `parentUuid` and `timestamp` after `message`. Long text that
    // uses up the outline's text budget must not cost a record its ID and place in the chain.
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    const value = { parts: Array.from({ length: 8 }, () => "y".repeat(16_384)), uuid: id };
    const result = read(JSON.stringify(value), { keys: { parts: { items: {} }, uuid: {} } }, 5);
    expect(result).toMatchObject({ kind: "record", value: { uuid: id } });
  });

  it("keeps a Claude record linked however much text comes before its IDs", () => {
    // Eight long text blocks use up the text budget; tool results of many short blocks use up
    // the short-string allowance. The record's own fields after them must still survive.
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    const parent = "bbbbbbbb-1111-4111-8111-111111111111";
    const results = Array.from({ length: 5 }, (_, i) => ({
      type: "tool_result",
      tool_use_id: `t${i}`,
      content: Array.from({ length: 64 }, () => ({ type: "text", text: "s".repeat(250) })),
    }));
    const value = {
      parentUuid: parent,
      isSidechain: false,
      message: {
        role: "user",
        content: [
          ...results,
          ...Array.from({ length: 8 }, () => ({ type: "text", text: "z".repeat(16_384) })),
          // Too long to be short strings, so they draw down what the text budget has left.
          ...Array.from({ length: 30 }, () => ({ type: "text", text: "m".repeat(300) })),
        ],
      },
      type: "user",
      uuid: id,
      timestamp: "2026-10-24T10:00:00.000Z",
      sessionId: session,
    };
    const [record] = decode([value]);
    expect(record!.kind).not.toBe("unsupported");
    expect(record!.node).toMatchObject({
      id,
      parent,
      session,
      timestamp: "2026-10-24T10:00:00.000Z",
    });
  });

  it("keeps one array item past the decoder's block limit", () => {
    const result = read(
      JSON.stringify({ b: Array(100).fill(1) }),
      { keys: { b: { items: {} } } },
      2,
    );
    expect(result).toMatchObject({ kind: "record", value: { b: Array(65).fill(1) } });
  });

  it("refuses nesting deeper than it can follow", () => {
    expect(read(`${"[".repeat(600)}${"]".repeat(600)}`, {}, 10)).toEqual({
      kind: "skipped",
      reason: "invalid-json",
    });
  });

  it("is read whole without an outline only when it fits the line buffer", () => {
    const text = `${JSON.stringify({ type: "user", text: LARGE })}\n`;
    expect(lines(text, null)).toEqual([
      { kind: "skipped", reason: "line-too-large", start: 0, end: Buffer.byteLength(text) },
    ]);
    expect(lines(text, { keys: { type: {} } }, 4096)).toEqual([
      {
        kind: "record",
        outlined: true,
        start: 0,
        end: Buffer.byteLength(text),
        value: { type: "user" },
      },
    ]);
  });

  it.each([
    [
      "a sidechain marked only by its agent",
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "p1",
        sessionId: session,
        agentId: "helper",
        message: { role: "assistant", id: "m1", content: [{ type: "text", text: LARGE }] },
      },
    ],
    [
      "an analysis-channel message",
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "p1",
        sessionId: session,
        message: { role: "assistant", channel: "analysis", content: LARGE },
      },
    ],
    [
      "mixed text and tool results",
      {
        type: "user",
        uuid: "u1",
        parentUuid: "a1",
        sessionId: session,
        timestamp: "2026-10-24T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: LARGE, is_error: true },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: LARGE }] },
            { type: "text", text: "and also" },
          ],
        },
        toolUseResult: { stdout: LARGE, lines: Array(10_000).fill("short") },
      },
    ],
    [
      "a typed prompt",
      {
        type: "user",
        uuid: "u2",
        parentUuid: null,
        sessionId: session,
        message: { role: "user", content: LARGE },
      },
    ],
    [
      "a tool call with large input",
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: "u2",
        sessionId: session,
        message: {
          role: "assistant",
          id: "m3",
          content: [
            {
              type: "tool_use",
              id: "t3",
              name: "Write",
              input: { file_path: "a.ts", content: LARGE },
            },
          ],
        },
      },
    ],
  ])("classifies %s like a record that fit", (_name, value) => {
    const [record] = decode([value]);
    const expected = buffered(value);
    expect(record!.kind).toBe(expected.kind);
    expect(record!.node).toEqual(expected.node);
    expect(record!.entries.map(({ truncated: _, ...entry }) => entry)).toEqual(
      expected.entries.map(({ truncated: _, ...entry }) => entry),
    );
    for (const entry of record!.entries)
      if (`${entry.text}${entry.detail ?? ""}`.includes(TRANSCRIPT_OMITTED))
        expect(entry.truncated).toBe(true);
    expect(JSON.stringify(record)).not.toContain("xxxx");
  });

  it("keeps the parent chain through a large tool result so older prompts stay reachable", () => {
    const values = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: session,
        message: { role: "user", content: "First" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: session,
        message: {
          role: "assistant",
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat big" } }],
        },
      },
      {
        type: "user",
        uuid: "r1",
        parentUuid: "a1",
        sessionId: session,
        sourceToolAssistantUUID: "a1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: LARGE }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "r1",
        sessionId: session,
        message: { role: "assistant", id: "m2", content: [{ type: "text", text: "Done" }] },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a2",
        sessionId: session,
        message: { role: "user", content: "Second" },
      },
    ];
    const anchored = (outline: boolean) => {
      const records = decode(values, outline);
      const document = new TranscriptDocument("claude", session);
      document.append(records);
      const snapshot = document.snapshot();
      expect(snapshot.state).toBe("ready");
      return {
        texts: snapshot.entries.map((entry) => entry.text),
        first: document.anchor(records[0]!.entries[0]!.id),
      };
    };
    const before = anchored(false);
    expect(before.first).toBeNull();
    const after = anchored(true);
    expect(after.first).not.toBeNull();
    expect(after.texts).toEqual(["First", "Bash · cat big", "Tool result", "Done", "Second"]);
  });
});
