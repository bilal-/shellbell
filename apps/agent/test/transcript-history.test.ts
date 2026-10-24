import { describe, expect, it } from "vitest";
import { TranscriptDocument } from "../src/conversation/transcript-document.js";
import type { TranscriptRead } from "../src/conversation/transcript-file.js";
import { TranscriptHistory } from "../src/conversation/transcript-history.js";
import { decodeTranscriptRecord } from "../src/conversation/transcript-record.js";

const session = "11111111-1111-4111-8111-111111111111";
function reply(uuid: string, parentUuid: string, tool: string, text?: string) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: session,
    message: {
      role: "assistant",
      id: `response-${uuid}`,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        { type: "tool_use", id: tool, name: "Bash", input: { command: tool } },
      ],
    },
  };
}
function result(uuid: string, parentUuid: string, tool: string) {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: session,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] },
  };
}

function decode(values: readonly unknown[], at = 0) {
  let offset = at;
  return values.map((value) => {
    const start = offset;
    offset += Buffer.byteLength(JSON.stringify(value)) + 1;
    return decodeTranscriptRecord("claude", {
      kind: "record",
      start,
      end: offset,
      value: value as Record<string, unknown>,
    });
  });
}
/** Current Claude Code: thinking, a queued-command attachment and hidden context have no rows. */
function hidden(
  uuid: string,
  parentUuid: string,
  kind: "thinking" | "attachment" | "meta",
  response = "",
) {
  if (kind === "thinking")
    return {
      type: "assistant",
      uuid,
      parentUuid,
      sessionId: session,
      message: { role: "assistant", id: response, content: [{ type: "thinking", thinking: "" }] },
    };
  if (kind === "attachment")
    return {
      type: "attachment",
      uuid,
      parentUuid,
      sessionId: session,
      attachment: { type: "queued_command" },
    };
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: session,
    isMeta: true,
    message: { role: "user", content: "context" },
  };
}

describe("older transcript pages", () => {
  it("starts a page at a reply whose thinking and queued input come before its first row", () => {
    const values = [
      reply("c1", "r0", "t1"),
      result("r1", "c1", "t1"),
      hidden("q1", "r1", "attachment"),
      hidden("m1", "q1", "meta"),
      hidden("k2", "m1", "thinking", "response-x2"),
      {
        type: "assistant",
        uuid: "x2",
        parentUuid: "k2",
        sessionId: session,
        message: {
          role: "assistant",
          id: "response-x2",
          content: [{ type: "text", text: "Next" }],
        },
      },
    ];
    const records = decode(values, 1000);
    const document = new TranscriptDocument("claude", session);
    document.beginWindow(1000);
    document.append(records);
    expect(document.snapshot().entries.map((entry) => entry.text)).toContain("Next");
    expect(document.anchor(records[5]!.entries[0]!.id)).not.toBeNull();
  });

  it("starts a page at its oldest cut so the next page can continue", async () => {
    // Prompt, a reply with text and a call, then calls and results: 66 rows before the
    // anchor. A 64-row page would otherwise start at a call inside the text reply's record.
    const values: Record<string, unknown>[] = [
      {
        type: "user",
        uuid: "root",
        parentUuid: null,
        sessionId: session,
        message: { role: "user", content: "Question" },
      },
      reply("c0", "root", "t0", "Looking"),
      result("r0", "c0", "t0"),
    ];
    for (let i = 1; i <= 32; i++)
      values.push(reply(`c${i}`, `r${i - 1}`, `t${i}`), result(`r${i}`, `c${i}`, `t${i}`));
    const bytes = Buffer.from(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
    let offset = 0;
    const records = values.map((value) => {
      const start = offset;
      offset += Buffer.byteLength(JSON.stringify(value)) + 1;
      return decodeTranscriptRecord("claude", { kind: "record", start, end: offset, value });
    });
    const live = new TranscriptDocument("claude", session);
    for (let i = 0; i < records.length; i += 64) live.append(records.slice(i, i + 64));
    live.snapshot();
    const last = records.at(-2)!;
    const anchor = live.anchor(last.entries[0]!.id)!;
    expect(anchor).not.toBeNull();
    const read = async (at: number, length: number): Promise<TranscriptRead> => ({
      status: "data",
      bytes: Uint8Array.from(bytes.subarray(at, at + length)),
      offset: at,
      size: bytes.byteLength,
    });

    const first = new TranscriptHistory(anchor, session, null);
    let page = await first.next(read);
    while (page.status === "reading") page = await first.next(read);
    if (page.status !== "page") throw new Error(page.status);
    expect(page.entries[0]).toMatchObject({ entry: { text: "Bash · t1" } });
    expect(page.entries[0]!.anchor).not.toBeNull();
    expect(page.more).toBe(true);

    const second = new TranscriptHistory(page.entries[0]!.anchor!, session, null);
    let next = await second.next(read);
    while (next.status === "reading") next = await second.next(read);
    expect(next).toMatchObject({ status: "page", history: "complete", more: false });
    if (next.status === "page")
      expect(next.entries.map((item) => item.entry.text)).toEqual([
        "Question",
        "Looking",
        "Bash · t0",
        "Tool result",
      ]);
  });

  it("refuses a cut at a reply whose previous result belongs to a call it can't see", () => {
    const values = [reply("c1", "r0", "t1"), result("r1", "c1", "t1"), reply("c2", "r1", "t2")];
    let offset = 1000;
    const records = values.map((value) => {
      const start = offset;
      offset += Buffer.byteLength(JSON.stringify(value)) + 1;
      return decodeTranscriptRecord("claude", { kind: "record", start, end: offset, value });
    });
    const document = new TranscriptDocument("claude", session);
    document.beginWindow(1000);
    document.append(records);
    const entries = document.snapshot().entries;
    // c1's parent result is outside the window, so the view starts at c2 instead.
    expect(entries.map((entry) => entry.text)).toEqual([
      "Earlier conversation is not loaded.",
      "Bash · t2",
    ]);
    expect(document.anchor(records[2]!.entries[0]!.id)).not.toBeNull();
  });
});
