import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_DOCUMENT_BYTES,
  TRANSCRIPT_DOCUMENT_ENTRIES,
  TRANSCRIPT_DOCUMENT_RECORDS,
  TranscriptDocument,
} from "../src/conversation/transcript-document.js";
import type { TranscriptAgent } from "../src/conversation/transcript-file.js";
import {
  decodeTranscriptRecord,
  TRANSCRIPT_DETAIL_BYTES,
  type TranscriptRecord,
} from "../src/conversation/transcript-record.js";

const session = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
function source(agent: TranscriptAgent = "claude") {
  let offset = 0;
  const document = new TranscriptDocument(agent, session);
  const decode = (value: Record<string, unknown>) => {
    const start = offset;
    offset += Buffer.byteLength(JSON.stringify(value)) + 1;
    return decodeTranscriptRecord(agent, { kind: "record", start, end: offset, value });
  };
  const append = (...values: Record<string, unknown>[]) => {
    const records = values.map(decode);
    document.append(records);
    return records;
  };
  const skip = (reason: "partial-prefix" | "invalid-json") => {
    const start = offset++;
    document.append([
      decodeTranscriptRecord(agent, { kind: "skipped", start, end: offset, reason }),
    ]);
  };
  const texts = () => document.snapshot().entries.map((entry) => entry.text);
  return { document, decode, append, texts, skip };
}
function message(
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  role: "user" | "assistant" = "user",
  extra: Record<string, unknown> = {},
) {
  return {
    type: role,
    uuid,
    parentUuid,
    sessionId: session,
    message: { role, content, ...(role === "assistant" && { id: `response-${uuid}` }) },
    ...extra,
  };
}
function call(id: string, parent: string, tool: string, response = "parallel") {
  return message(id, parent, null, "assistant", {
    message: {
      role: "assistant",
      id: response,
      content: [{ type: "tool_use", id: tool, name: `Run ${tool}`, input: { command: tool } }],
    },
  });
}
function result(id: string, parent: string | null, tool: string, text: string) {
  return message(id, parent, [{ type: "tool_result", tool_use_id: tool, content: text }]);
}
function codex(text: string, extra: Record<string, unknown> = {}) {
  return { type: "event_msg", payload: { type: "user_message", message: text }, ...extra };
}
const header = { type: "session_meta", payload: { id: session } };

describe("Claude active conversation projection", () => {
  it("discards an old answer when a malformed duplicate replaces its UUID", () => {
    const { append, document, texts } = source();
    append(message("root", null, "Question"), message("answer", "root", "Old answer", "assistant"));
    texts();
    append(
      message("answer", "root", null, "assistant", {
        message: { role: "developer", content: "INTERNAL" },
      }),
    );
    expect(document.snapshot().change).toBe("replace");
    expect(texts()).toEqual(["Question"]);
  });
  it("keeps a framing notice at its source position when a reply is appended", () => {
    const { append, skip, document } = source();
    append(message("root", null, "Question"));
    skip("invalid-json");
    append(message("answer", "root", "Answer", "assistant"));
    const previous = document.snapshot();
    expect(previous.entries.map((entry) => entry.text)).toEqual([
      "Question",
      "A transcript entry could not be read",
      "Answer",
    ]);
    append(message("next", "answer", "Next"));
    const current = document.snapshot();
    expect(current.change).toBe("append");
    expect(current.entries.slice(0, -1)).toEqual(previous.entries);
  });
  it("does not duplicate the unloaded-history notice for a skipped tail prefix", () => {
    const { decode, skip, append, document } = source();
    const skipped = decode(message("old", null, "Not loaded"));
    document.beginWindow(skipped.end);
    skip("partial-prefix");
    append(message("current", "missing", "Recent"));
    expect(document.snapshot().entries.map((entry) => entry.text)).toEqual([
      "Earlier conversation is not loaded.",
      "Recent",
    ]);
  });
  it("requires a current main leaf with the expected session, while retaining inherited ancestors", () => {
    const { append, document, texts } = source();
    expect(document.snapshot().state).toBe("unbound");
    append(message("old", null, "Inherited", "user", { sessionId: other }));
    expect(document.snapshot().state).toBe("unbound");
    append(message("current", "old", "Current", "assistant"));
    expect(texts()).toEqual(["Inherited", "Current"]);
    append(message("different", "current", "Other writer", "user", { sessionId: other }));
    expect(document.snapshot()).toMatchObject({ state: "unbound", entries: [], change: "replace" });
  });

  it("replaces an abandoned branch and ignores later sidechain and metadata leaves", () => {
    const { append, document, texts } = source();
    append(message("root", null, "Question"), message("old", "root", "Abandoned", "assistant"));
    expect(texts()).toEqual(["Question", "Abandoned"]);
    append(message("new", "root", "Current", "assistant"));
    expect(document.snapshot()).toMatchObject({ state: "ready", change: "replace" });
    append(
      message("old-child", "old", "Old child secret", "assistant", { isSidechain: true }),
      { type: "progress", uuid: "progress", parentUuid: "new" },
      message("meta", "progress", "Internal instruction", "user", { isMeta: true }),
    );
    expect(texts()).toEqual(["Question", "Current"]);
  });

  it("uses the last occurrence of a duplicated UUID", () => {
    const { append, document, texts } = source();
    append(message("root", null, "Question"), message("answer", "root", "Draft", "assistant"));
    texts();
    append(message("answer", "root", "Finished", "assistant"));
    expect(document.snapshot().change).toBe("replace");
    expect(texts()).toEqual(["Question", "Finished"]);
  });

  it("keeps unknown records as placeholders without treating them as session proof", () => {
    const { append, document } = source();
    append({
      type: "future",
      uuid: "unknown",
      parentUuid: null,
      sessionId: session,
      secret: "hidden",
    });
    expect(document.snapshot()).toMatchObject({ state: "unbound", entries: [] });
    append(message("current", "unknown", "Visible"));
    const snapshot = document.snapshot();
    expect(snapshot.state).toBe("ready");
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual(["unsupported", "user"]);
    expect(JSON.stringify(snapshot)).not.toContain("hidden");
  });

  it("labels incomplete ancestry instead of inventing a root", () => {
    const { append, document } = source();
    append(message("tail", "missing", "Recent"));
    expect(document.snapshot()).toMatchObject({ state: "ready", history: "unlinked" });
    expect(document.snapshot().entries.map((entry) => entry.text)).toEqual([
      "Some earlier conversation entries could not be linked.",
      "Recent",
    ]);
  });

  it.each([false, true])("rejects cyclic ancestry (with a terminal: %s)", (terminal) => {
    const { append, document } = source();
    append(message("a", "b", "A"), message("b", "a", "B"));
    if (terminal) append(message("c", "b", "C"));
    expect(document.snapshot()).toMatchObject({ state: "unsupported", entries: [] });
  });

  it("starts a new summary root without following its logical parent", () => {
    const { append, document, texts } = source();
    append(message("old", null, "Before compaction"));
    texts();
    append(
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary",
        parentUuid: null,
        logicalParentUuid: "old",
      },
      message("summary", "boundary", "Summary text", "user", { isCompactSummary: true }),
      message("new", "summary", "After compaction", "assistant"),
    );
    const snapshot = document.snapshot();
    expect(snapshot).toMatchObject({ state: "ready", history: "complete", change: "replace" });
    expect(snapshot.entries.map((entry) => entry.text)).toEqual([
      "Conversation summary",
      "After compaction",
    ]);
    expect(snapshot.entries[0]).toMatchObject({
      kind: "group",
      detail: "Summary text",
      collapsed: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("Before compaction");
  });

  it("does not expose internal reasoning on the active chain", () => {
    const { append, texts } = source();
    append(
      message("root", null, "Question"),
      message(
        "thinking",
        "root",
        [{ type: "thinking", thinking: "Private reasoning" }],
        "assistant",
      ),
      message("answer", "thinking", "Answer", "assistant"),
    );
    expect(texts()).toEqual(["Question", "Answer"]);
  });
});

describe("Claude parallel tools", () => {
  it("recovers missing response blocks and completions, keeping a different response out", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      call("b", "a", "two"),
      result("rb", "b", "two", "Second result"),
      result("ra", "a", "one", "First result"),
      call("abandoned", "root", "old", "old-response"),
      result("old-result", "abandoned", "old", "Abandoned output"),
      message("final", "ra", "Done", "assistant"),
    );
    const entries = document.snapshot().entries;
    expect(entries.map((entry) => entry.text)).toEqual([
      "Question",
      "Run one",
      "Run two",
      "Tool result",
      "Tool result",
      "Done",
    ]);
    expect(
      entries.filter((entry) => entry.kind === "tool-result").map((entry) => entry.detail),
    ).toEqual(["Second result", "First result"]);
    expect(JSON.stringify(entries)).not.toContain("Abandoned");
  });

  it("keeps on-chain content in place when a response has later blocks", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      result("ra", "a", "one", "First result"),
      call("b", "ra", "two"),
      call("c", "b", "three"),
      result("rc", "c", "three", "Third result"),
      result("rb", "b", "two", "Second result"),
      message("final", "rb", "Done", "assistant"),
    );
    expect(document.snapshot().entries.map((entry) => entry.detail ?? entry.text)).toEqual([
      "Question",
      "command: one",
      "First result",
      "command: two",
      "command: three",
      "Third result",
      "Second result",
      "Done",
    ]);
  });

  it.each(["source", "unique-call"])("recovers a detached result using %s evidence", (proof) => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      {
        ...result("detached", null, "one", "Recovered"),
        ...(proof === "source" && { sourceToolAssistantUUID: "a" }),
      },
      message("final", "a", "Done", "assistant"),
    );
    expect(document.snapshot().entries.some((entry) => entry.detail === "Recovered")).toBe(true);
  });

  it("rejects contradictory source evidence, ambiguous IDs and mixed off-chain user records", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("old", "root", "one", "old-response"),
      call("a", "root", "one"),
      call("b", "a", "two"),
      { ...result("bad-source", null, "two", "Wrong source"), sourceToolAssistantUUID: "old" },
      result("ambiguous", null, "one", "Ambiguous result"),
      message("mixed", "b", [
        { type: "tool_result", tool_use_id: "two", content: "Mixed result" },
        { type: "text", text: "Abandoned user content" },
      ]),
      message("final", "a", "Done", "assistant"),
    );
    const serialized = JSON.stringify(document.snapshot().entries);
    for (const text of [
      "Wrong source",
      "Ambiguous result",
      "Mixed result",
      "Abandoned user content",
    ])
      expect(serialized).not.toContain(text);
  });

  it("prefers an on-chain result and suppresses duplicate completions", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      result("stray", "a", "one", "Stray copy"),
      result("on-chain", "a", "one", "Chosen result"),
      { ...result("duplicate", "on-chain", "one", "Duplicate copy"), sourceToolAssistantUUID: "a" },
      message("final", "duplicate", "Done", "assistant"),
    );
    expect(
      document
        .snapshot()
        .entries.filter((entry) => entry.kind === "tool-result")
        .map((entry) => entry.detail),
    ).toEqual(["Chosen result"]);
  });

  it("uses completion timestamps for recovered results with file position as a tie-breaker", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      call("b", "a", "two"),
      { ...result("later", "a", "one", "Later"), timestamp: "2026-10-21T10:00:00.9Z" },
      { ...result("earlier", "b", "two", "Earlier"), timestamp: "2026-10-21T10:00:00.100000Z" },
      message("final", "a", "Done", "assistant"),
    );
    expect(
      document
        .snapshot()
        .entries.filter((entry) => entry.kind === "tool-result")
        .map((entry) => entry.detail),
    ).toEqual(["Earlier", "Later"]);
  });

  it("handles multiple tool results in one record independently", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      call("b", "a", "two"),
      message("multi", "a", [
        { type: "tool_result", tool_use_id: "one", content: "One" },
        { type: "tool_result", tool_use_id: "two", content: "Two" },
      ]),
      message("final", "a", "Done", "assistant"),
    );
    expect(
      document
        .snapshot()
        .entries.filter((entry) => entry.kind === "tool-result")
        .map((entry) => entry.detail),
    ).toEqual(["One", "Two"]);
  });

  it("uses a total ordering when recovered results have mixed timestamp availability", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("a", "root", "one"),
      call("b", "a", "two"),
      call("c", "b", "three"),
      result("unknown-time", "a", "one", "Unknown time"),
      { ...result("later", "b", "two", "Later"), timestamp: "2026-10-21T10:00:00.900Z" },
      { ...result("earlier", "c", "three", "Earlier"), timestamp: "2026-10-21T10:00:00.100Z" },
      message("final", "a", "Done", "assistant"),
    );
    expect(
      document
        .snapshot()
        .entries.filter((entry) => entry.kind === "tool-result")
        .map((entry) => entry.detail),
    ).toEqual(["Earlier", "Later", "Unknown time"]);
    expect(document.snapshot().change).toBe("unchanged");
  });
});

describe("grouped subagent activity", () => {
  it("keeps separate unnamed sidechain roots grouped at their active ancestor", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      message("child-a", "root", "Child A", "assistant", { isSidechain: true }),
      message("child-b", "root", "Child B", "assistant", { isSidechain: true }),
      message("answer", "root", "Answer", "assistant"),
    );
    const before = document.snapshot();
    expect(before.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "group",
      "group",
      "assistant",
    ]);
    expect(before.entries[1]!.detail).toBe("assistant: Child A");
    expect(before.entries[2]!.detail).toBe("assistant: Child B");
    append(message("next", "answer", "Next question"));
    const next = document.snapshot();
    expect(next.change).toBe("append");
    expect(next.entries.slice(0, -1)).toEqual(before.entries);
  });
  it("includes only sidechains linked to the selected branch, including recovered parallel calls", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      call("old", "root", "old", "abandoned"),
      call("a", "root", "one"),
      call("b", "a", "two"),
      message("child-one", "b", "Child text", "assistant", {
        isSidechain: true,
        agentId: "worker",
      }),
      {
        ...result("child-result", "child-one", "one", "Child result"),
        isSidechain: true,
        agentId: "worker",
      },
      message("old-child", "old", "Abandoned child", "assistant", {
        isSidechain: true,
        agentId: "other-worker",
      }),
      message("unknown-child", "missing", "Unproven secret", "assistant", { isSidechain: true }),
      message("final", "a", "Done", "assistant"),
    );
    const entries = document.snapshot().entries;
    const groups = entries.filter((entry) => entry.kind === "group");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ text: "Subagent conversation", collapsed: true });
    expect(groups[0]!.detail).toContain("Child text");
    expect(groups[0]!.detail).toContain("Child result");
    expect(entries.some((entry) => entry.kind === "tool-result")).toBe(false);
    expect(entries.some((entry) => entry.kind === "unsupported")).toBe(true);
    const serialized = JSON.stringify(entries);
    for (const text of ["Abandoned child", "Unproven secret", "worker", "other-worker"])
      expect(serialized).not.toContain(text);
  });

  it("does not expose unlinked cyclic subagent payloads", () => {
    const { append, document } = source();
    append(
      message("root", null, "Question"),
      message("a", "b", "Secret A", "assistant", { isSidechain: true }),
      message("b", "a", "Secret B", "assistant", { isSidechain: true }),
    );
    const entries = document.snapshot().entries;
    expect(entries.map((entry) => entry.kind)).toEqual(["unsupported", "user"]);
    expect(JSON.stringify(entries)).not.toContain("Secret");
  });

  it.each([false, true])(
    "marks an exactly filled group truncated if another record follows: %s",
    (extra) => {
      const { append, document } = source();
      append(
        message("root", null, "Question"),
        message(
          "child",
          "root",
          "x".repeat(TRANSCRIPT_DETAIL_BYTES - "assistant: ".length),
          "assistant",
          { isSidechain: true },
        ),
      );
      if (extra)
        append(
          message("child-more", "child", "More child text", "assistant", { isSidechain: true }),
        );
      const group = document.snapshot().entries[1]!;
      expect(group).toMatchObject({ kind: "group", collapsed: true });
      expect(Buffer.byteLength(group.detail!)).toBe(TRANSCRIPT_DETAIL_BYTES);
      expect(group.truncated).toBe(extra ? true : undefined);
    },
  );
});

describe("Codex canonical file projection", () => {
  it("requires the first canonical header and ignores inherited later metadata", () => {
    const { append, document, texts } = source("codex");
    expect(document.snapshot().state).toBe("unbound");
    append({ ...header, payload: { id: session, session_id: other } }, codex("Current"));
    append({ ...header, payload: { id: other } }, codex("Continued"));
    expect(document.snapshot().state).toBe("ready");
    expect(texts()).toEqual(["Current", "Continued"]);
  });

  it("cannot repair a mismatched first header using a later matching header or window", () => {
    const { append, document } = source("codex");
    append({ ...header, payload: { id: other } }, codex("Wrong transcript"));
    expect(document.snapshot()).toMatchObject({ state: "unbound", entries: [] });
    document.beginWindow(document.cursor);
    append(header, codex("Still wrong"));
    expect(document.snapshot()).toMatchObject({ state: "unbound", entries: [] });
  });

  it("supports a bounded tail only after header validation at offset zero", () => {
    const { append, document, texts } = source("codex");
    append(header);
    const tail = document.cursor;
    document.beginWindow(tail);
    append(codex("Recent"));
    expect(document.snapshot()).toMatchObject({
      state: "ready",
      history: "unloaded",
      change: "replace",
    });
    expect(texts()).toEqual(["Earlier conversation is not loaded.", "Recent"]);
    const unverified = source("codex");
    unverified.document.beginWindow(tail);
    const record = unverified.decode(header);
    unverified.document.append([{ ...record, start: tail, end: tail + record.end }]);
    expect(unverified.document.snapshot()).toMatchObject({ state: "unsupported", entries: [] });
  });

  it("does not revive a legacy rollback by discarding the window", () => {
    const { append, document } = source("codex");
    append(header, codex("Before rollback"));
    expect(document.snapshot().state).toBe("ready");
    append({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } });
    expect(document.snapshot()).toMatchObject({
      state: "unsupported",
      entries: [],
      change: "replace",
    });
    document.beginWindow(document.cursor);
    append(codex("Later"));
    expect(document.snapshot()).toMatchObject({ state: "unsupported", entries: [] });
  });

  it("groups inter-agent activity and compaction without forwarding payloads or duplicate replacements", () => {
    const { append, document } = source("codex");
    append(
      header,
      codex("Main"),
      { type: "inter_agent_communication", payload: { content: "Child private metadata" } },
      { type: "turn_context", payload: { internal: "Private context" } },
      {
        type: "compacted",
        payload: { message: "Summary", replacement_history: [codex("Duplicate")] },
      },
      codex("After"),
    );
    const entries = document.snapshot().entries;
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "group", "group", "user"]);
    expect(entries[1]!.text).toBe("Subagent activity");
    expect(entries[2]).toMatchObject({
      text: "Conversation summary",
      detail: "Summary",
      collapsed: true,
    });
    expect(JSON.stringify(entries)).not.toMatch(/Private context|Duplicate|Child private metadata/);
  });
});

describe("projection lifetime and bounds", () => {
  it("labels Claude ancestry lost to eviction and replaces the retained presentation", () => {
    const { append, document } = source();
    for (let i = 0; i < 40; i++)
      append(message(`message-${i}`, i ? `message-${i - 1}` : null, `${i}: ${"x".repeat(16000)}`));
    const before = document.snapshot();
    expect(before).toMatchObject({ state: "ready", history: "truncated" });
    append(message("message-40", "message-39", `40: ${"x".repeat(16000)}`));
    const after = document.snapshot();
    expect(after).toMatchObject({ state: "ready", history: "truncated", change: "replace" });
    expect(after.entries.at(-1)!.text).toMatch(/^40:/);
  });
  it("distinguishes appends, unchanged snapshots and replacements without exposing graph metadata", () => {
    const { append, document } = source();
    append(message("root", null, "Question"));
    expect(document.snapshot().change).toBe("replace");
    expect(document.snapshot().change).toBe("unchanged");
    append(message("answer", "root", "Answer", "assistant"));
    const snapshot = document.snapshot();
    expect(snapshot.change).toBe("append");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    for (const entry of snapshot.entries) expect(Object.isFrozen(entry)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/parent|response-answer|sessionId|11111111|uuid/);
    document.beginWindow(0);
    // A window reset must clear even if the resulting presentation has the same prefix.
    const first = decodeTranscriptRecord("claude", {
      kind: "record",
      start: 0,
      end: 1,
      value: message("root", null, "Question"),
    });
    document.append([first]);
    expect(document.snapshot().change).toBe("replace");
  });

  it("caps retained decoded bytes, retains recent content and labels eviction", () => {
    const { append, document } = source("codex");
    append(header);
    for (let i = 0; i < 40; i++) append(codex(`${i}: ${"x".repeat(16000)}`));
    expect(document.retainedBytes).toBeLessThanOrEqual(TRANSCRIPT_DOCUMENT_BYTES);
    expect(document.retainedRecords).toBeLessThan(40);
    const snapshot = document.snapshot();
    expect(snapshot).toMatchObject({ state: "ready", history: "truncated" });
    expect(snapshot.entries[0]!.text).toBe("Earlier conversation omitted to save memory.");
    expect(snapshot.entries.at(-1)!.text).toMatch(/^39:/);
    expect(Buffer.byteLength(JSON.stringify(snapshot.entries))).toBeLessThanOrEqual(
      TRANSCRIPT_DOCUMENT_BYTES,
    );
  });

  it("bounds metadata-only records independently from their byte size", () => {
    const { append, document } = source("codex");
    append(header);
    for (let i = 0; i < TRANSCRIPT_DOCUMENT_RECORDS + 10; i++) append({ type: "turn_context" });
    expect(document.retainedRecords).toBe(TRANSCRIPT_DOCUMENT_RECORDS);
    expect(document.snapshot()).toMatchObject({ state: "ready", history: "truncated" });
  });

  it("caps visible entries while keeping the newest rows", () => {
    const { append, document } = source("codex");
    append(header);
    for (let i = 0; i < 70; i++)
      append({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: Array.from({ length: 31 }, (_, j) => ({
            type: "output_text",
            text: `${i}:${j}`,
          })),
        },
      });
    const snapshot = document.snapshot();
    expect(snapshot.entries).toHaveLength(TRANSCRIPT_DOCUMENT_ENTRIES);
    expect(snapshot.history).toBe("truncated");
    expect(snapshot.entries.at(-1)!.text).toBe("69:30");
  });

  it("validates a whole batch before mutating state", () => {
    const { append, decode, document } = source("codex");
    append(header);
    const cursor = document.cursor;
    const first = decode(codex("One"));
    const second = decode(codex("Two"));
    expect(() => document.append([first, { ...second, start: first.start }])).toThrow(RangeError);
    expect(document.cursor).toBe(cursor);
    expect(document.retainedRecords).toBe(1);
    expect(() => document.append(Array(65).fill(first))).toThrow(RangeError);
    document.append([first, second]);
    expect(document.snapshot().entries.map((entry) => entry.text)).toEqual(["One", "Two"]);
  });

  it("clears memory on close and cannot reopen or append", () => {
    const { append, document } = source();
    append(message("root", null, "Visible"));
    document.snapshot();
    document.close();
    expect(document.retainedBytes).toBe(0);
    expect(document.retainedRecords).toBe(0);
    expect(document.snapshot()).toMatchObject({ state: "closed", entries: [] });
    expect(() => document.beginWindow(0)).toThrow(RangeError);
    expect(() => document.append([])).toThrow(RangeError);
  });

  it.each([-1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid window offsets: %s",
    (offset) => {
      expect(() => new TranscriptDocument("claude", session).beginWindow(offset)).toThrow(
        RangeError,
      );
    },
  );

  it("rejects invalid identities and invalid record offsets", () => {
    expect(() => new TranscriptDocument("claude", "invalid")).toThrow(TypeError);
    expect(() => new TranscriptDocument("other" as TranscriptAgent, session)).toThrow(TypeError);
    const document = new TranscriptDocument("claude", session);
    for (const [start, end] of [
      [-1, 1],
      [0, 0],
      [1, 0],
      [0, Infinity],
      [NaN, 1],
    ])
      expect(() =>
        document.append([{ start, end, kind: "ignored", entries: [] } as TranscriptRecord]),
      ).toThrow(RangeError);
  });
});
