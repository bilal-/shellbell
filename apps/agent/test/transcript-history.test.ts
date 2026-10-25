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
  it("widens an older page without reading the same bytes again", async () => {
    // Screenshots push the page's start back past several windows before a cut appears.
    const same = (value: ReturnType<typeof reply>) => ({
      ...value,
      message: { ...value.message, id: "response-c0" },
    });
    const shot = (uuid: string, parentUuid: string, tool: string) => ({
      ...result(uuid, parentUuid, tool),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tool, content: "s".repeat(100_000) }],
      },
    });
    const values: Record<string, unknown>[] = [
      {
        type: "user",
        uuid: "root",
        parentUuid: null,
        sessionId: session,
        message: { role: "user", content: "Question" },
      },
      reply("c0", "root", "t0", "Looking"),
      shot("r0", "c0", "t0"),
      // One long reply, so none of its later blocks can start a page.
      same(reply("c1", "r0", "t1")),
      shot("r1", "c1", "t1"),
      same(reply("c2", "r1", "t2")),
      shot("r2", "c2", "t2"),
      same(reply("c3", "r2", "t3")),
      result("r3", "c3", "t3"),
      reply("c4", "r3", "t4", "Next"),
      result("r4", "c4", "t4"),
    ];
    const bytes = Buffer.from(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
    const records = decode(values);
    const live = new TranscriptDocument("claude", session);
    live.append(records);
    live.snapshot();
    const anchor = live.anchor(records.at(-2)!.entries[0]!.id)!;
    expect(anchor).not.toBeNull();
    let total = 0;
    const read = async (at: number, length: number): Promise<TranscriptRead> => {
      total += Math.min(length, bytes.length - at);
      return {
        status: "data",
        bytes: Uint8Array.from(bytes.subarray(at, at + length)),
        offset: at,
        size: bytes.byteLength,
      };
    };
    const history = new TranscriptHistory(anchor, session, null);
    let page = await history.next(read);
    while (page.status === "reading") page = await history.next(read);
    expect(page).toMatchObject({ status: "page" });
    if (page.status === "page") expect(page.entries[0]!.entry.text).toBe("Question");
    // Every byte before the anchor is read once, except the one line that straddled the
    // narrower window's start, which that window only partly read. Before, each wider window
    // read everything again (564 KB here).
    expect(total).toBeLessThanOrEqual(anchor.end + 110_000);
  });

  it("stops keeping records for a wider window past its limit, and still finds the page", async () => {
    const shot = (uuid: string, parentUuid: string, tool: string) => ({
      ...result(uuid, parentUuid, tool),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: tool, content: "s".repeat(100_000) }],
      },
    });
    const same = (value: ReturnType<typeof reply>) => ({
      ...value,
      message: { ...value.message, id: "response-c0" },
    });
    const noise = Array.from({ length: 3000 }, (_, i) => ({ type: "progress", n: i }));
    const values: Record<string, unknown>[] = [
      {
        type: "user",
        uuid: "root",
        parentUuid: null,
        sessionId: session,
        message: { role: "user", content: "Question" },
      },
      reply("c0", "root", "t0", "Looking"),
      shot("r0", "c0", "t0"),
      ...noise,
      same(reply("c1", "r0", "t1")),
      shot("r1", "c1", "t1"),
      same(reply("c2", "r1", "t2")),
      result("r2", "c2", "t2"),
      reply("c3", "r2", "t3", "Next"),
      result("r3", "c3", "t3"),
    ];
    const bytes = Buffer.from(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
    const records = decode(values);
    const live = new TranscriptDocument("claude", session);
    for (let i = 0; i < records.length; i += 64) live.append(records.slice(i, i + 64));
    live.snapshot();
    const anchor = live.anchor(records.at(-2)!.entries[0]!.id)!;
    expect(anchor).not.toBeNull();
    const read = async (at: number, length: number): Promise<TranscriptRead> => ({
      status: "data",
      bytes: Uint8Array.from(bytes.subarray(at, at + length)),
      offset: at,
      size: bytes.byteLength,
    });
    const history = new TranscriptHistory(anchor, session, null);
    let peak = 0;
    let page = await history.next(read);
    while (page.status === "reading") {
      const kept = (history as unknown as { decoded: unknown[] | null }).decoded;
      peak = Math.max(peak, kept?.length ?? 0);
      page = await history.next(read);
    }
    expect(peak).toBeLessThanOrEqual(2048);
    // Page back to the start; the rows must be the same as reading each window whole.
    const texts: string[] = [];
    for (let pages = 0; page.status === "page" && pages < 20; pages++) {
      texts.unshift(...page.entries.map((item) => item.entry.text));
      const next = page.more ? page.entries[0]?.anchor : null;
      if (!next) break;
      const older = new TranscriptHistory(next, session, null);
      page = await older.next(read);
      while (page.status === "reading") page = await older.next(read);
    }
    // The same rows the whole-window reader finds. 3,000 records in one window exceed the
    // document's 2,048-record budget, so the oldest are dropped there too.
    expect(texts.slice(0, 2)).toEqual(["Bash · t1", "Tool result"]);
    expect(texts).toContain("Bash · t2");
  });

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

  it("says whether any row can start an older page, as checking each row would", () => {
    const tail = [reply("c1", "r0", "t1"), result("r1", "c1", "t1")];
    const records = decode(tail, 1000);
    const document = new TranscriptDocument("claude", session);
    document.beginWindow(1000);
    document.append(records);
    const snapshot = document.snapshot();
    const each = (doc: TranscriptDocument, entries: typeof snapshot.entries) =>
      entries.some((entry) => !entry.id.startsWith("history:") && doc.anchor(entry.id) !== null);
    expect(document.hasCut()).toBe(false);
    expect(document.hasCut()).toBe(each(document, snapshot.entries));
    const more = decode([...tail, reply("c2", "r1", "t2")], 1000);
    const second = new TranscriptDocument("claude", session);
    second.beginWindow(1000);
    second.append(more);
    const next = second.snapshot();
    expect(second.hasCut()).toBe(true);
    expect(second.hasCut()).toBe(each(second, next.entries));
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
