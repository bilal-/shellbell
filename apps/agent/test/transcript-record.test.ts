import { describe, expect, it } from "vitest";
import type { TranscriptAgent } from "../src/conversation/transcript-file.js";
import { TranscriptJsonl } from "../src/conversation/transcript-jsonl.js";
import {
  CodexTranscriptHeader,
  decodeTranscriptRecord,
  TRANSCRIPT_DETAIL_BYTES,
  TRANSCRIPT_RECORD_BYTES,
  TRANSCRIPT_RECORD_ENTRIES,
  TRANSCRIPT_TEXT_BYTES,
  transcriptSessionId,
  transcriptTail,
  transcriptText,
} from "../src/conversation/transcript-record.js";

const session = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const main = {
  uuid: "entry-1",
  parentUuid: null,
  sessionId: session,
  timestamp: "2026-10-21T10:00:00.000Z",
};
function decode(agent: TranscriptAgent, value: Record<string, unknown>, start = 0) {
  return decodeTranscriptRecord(agent, {
    kind: "record",
    start,
    end: start + Buffer.byteLength(JSON.stringify(value)) + 1,
    value,
  });
}
function claude(role: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) {
  return decode("claude", {
    ...main,
    type: role,
    message: { role, id: "response-1", content },
    ...extra,
  });
}
function codex(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return decode("codex", { type: "response_item", payload, ...extra });
}

describe("internal-context format guards", () => {
  it("represents an empty Claude tool completion without an unsupported placeholder", () => {
    const record = claude("user", [{ type: "tool_result", tool_use_id: "call-empty" }]);
    expect(record.entries[0]).toMatchObject({ kind: "tool-result", detail: "", collapsed: true });
    expect(record.node?.resultsOnly).toBe(true);
  });
  it.each(
    [null, [], { toString: 0, valueOf: 0 }, { type: "reasoning" }].map((value) => ({ value })),
  )("treats non-string type fields as unknown without coercion: %j", ({ value: type }) => {
    for (const record of [
      decode("claude", { type }),
      decode("codex", { type }),
      decode("codex", { type: "event_msg", payload: { type } }),
      decode("codex", { type: "response_item", payload: { type } }),
    ])
      expect(record.entries[0]?.kind).toBe("unsupported");
  });
  it.each(["analysis", "unknown-channel"])(
    "does not expose Claude compaction in channel %s",
    (channel) => {
      const record = claude("assistant", "SECRET", {
        isCompactSummary: true,
        message: { role: "assistant", channel, content: "SECRET" },
      });
      expect(JSON.stringify(record.entries)).not.toContain("SECRET");
      expect(record.node?.mainMessage).toBe(false);
    },
  );
  it("does not expose meta compaction summaries", () => {
    const record = claude("user", "SECRET", { isCompactSummary: true, isMeta: true });
    expect(record.entries).toEqual([]);
    expect(record.node?.mainMessage).toBe(false);
  });
  it.each([
    { role: "unknown" },
    { role: "assistant", phase: "analysis" },
    { role: "assistant", channel: "future-channel" },
  ])("does not bypass Codex role/phase/channel guards for compaction: %j", (fields) => {
    const record = codex(
      { type: "message", ...fields, content: [{ type: "output_text", text: "SECRET" }] },
      {
        metadata: { compaction_output: true },
      },
    );
    expect(record.entries[0]?.kind).toBe("unsupported");
    expect(JSON.stringify(record.entries)).not.toContain("SECRET");
  });
  it("marks recognized legacy rollbacks as invalidating history", () => {
    expect(
      decode("codex", { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
    ).toMatchObject({ kind: "unsupported", invalidates: true });
  });
});

describe("bounded transcript text", () => {
  it.each(["plain", "éééé", "世界世界", "🐈🐈🐈", "a\ud800b\udc00c"])(
    "caps UTF-8 without splitting codepoints: %s",
    (value) => {
      for (let limit = 0; limit < 16; limit++) {
        const result = transcriptText(value, limit);
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(limit);
        expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.text))).toBe(
          result.text,
        );
        expect(result.text).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u);
      }
    },
  );
  it("removes controls while retaining line breaks and tabs", () => {
    expect(transcriptText("a\0\x1b\x7f\u0085\tb\nc", 50)).toEqual({
      text: "a\tb\nc",
      truncated: false,
    });
    const result = transcriptText("\0".repeat(200_000), 10);
    expect(result).toEqual({ text: "", truncated: true });
  });
  it.each([-1, 1.5, Number.NaN, TRANSCRIPT_TEXT_BYTES + 1])(
    "rejects invalid budget %s",
    (limit) => {
      expect(() => transcriptText("private", limit)).toThrow("Invalid transcript text budget");
    },
  );
});

describe("Claude record decoding", () => {
  it("keeps graph links private and exposes only presentation fields", () => {
    const record = claude("assistant", [{ type: "text", text: "Hello" }], {
      parentUuid: "parent-1",
      cwd: "/private/project",
      arbitrary: "private metadata",
    });
    expect(record.entries).toEqual([{ id: "0:0", kind: "assistant", text: "Hello" }]);
    expect(record.node).toMatchObject({
      id: "entry-1",
      parent: "parent-1",
      session,
      role: "assistant",
      response: "response-1",
      scope: "main",
      meta: false,
      compact: false,
    });
    expect(JSON.stringify(record.entries)).not.toMatch(/private|parent-1|response-1|11111111/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.entries)).toBe(true);
    expect(Object.isFrozen(record.entries[0])).toBe(true);
    expect(Object.isFrozen(record.node)).toBe(true);
  });
  it("accepts text strings and arrays without merging different source entries", () => {
    expect(claude("user", "Question").entries[0]).toMatchObject({ kind: "user", text: "Question" });
    expect(
      claude("assistant", [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ]).entries.map((entry) => entry.text),
    ).toEqual(["First", "Second"]);
  });
  it("caps tool previews and retains call/result associations outside presentation", () => {
    const call = claude("assistant", [
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: {
          file_path: "example.ts",
          ignored: { private: "do not serialize the whole object" },
        },
      },
    ]);
    expect(call.entries[0]).toEqual({
      id: "0:0",
      kind: "tool-call",
      text: "Read · example.ts",
      collapsed: true,
    });
    expect(call.node?.calls).toEqual([{ id: "tool-1", entry: "0:0" }]);
    const result = claude(
      "user",
      [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          is_error: true,
          content: [{ type: "text", text: "No file" }],
        },
      ],
      { sourceToolAssistantUUID: "entry-call" },
    );
    expect(result.entries[0]).toMatchObject({
      kind: "tool-result",
      text: "Tool error",
      detail: "No file",
      collapsed: true,
    });
    expect(result.node).toMatchObject({
      results: [{ id: "tool-1", entry: "0:0" }],
      resultsOnly: true,
      sourceAssistant: "entry-call",
    });
    expect(JSON.stringify(result.entries)).not.toContain("entry-call");
  });
  it("summarizes a tool call on one line and keeps longer arguments in details", () => {
    const call = (input: unknown) =>
      claude("assistant", [{ type: "tool_use", id: "tool-2", name: "Bash", input }]).entries[0];
    expect(call({ command: "git status", description: "Show status" })).toEqual({
      id: "0:0",
      kind: "tool-call",
      text: "Bash · git status",
      collapsed: true,
    });
    expect(call({ command: "cd app\npnpm test" })).toMatchObject({
      text: "Bash · cd app…",
      detail: "command: cd app\npnpm test",
    });
    const long = "x".repeat(300);
    const entry = call({ command: long });
    expect(entry?.text).toBe(`Bash · ${"x".repeat(120)}…`);
    expect(entry?.detail).toBe(`command: ${long}`);
    expect(entry?.truncated).toBeUndefined();
    expect(call({ command: "y".repeat(9000) })?.truncated).toBe(true);
  });
  it("does not serialize deeply nested or arbitrary tool arguments", () => {
    const input: Record<string, unknown> = { unexpected: { secret: "private nested value" } };
    input.cycle = input;
    // A parsed JSONL record cannot contain a cycle; the argument preview still doesn't recurse.
    const record = decodeTranscriptRecord("claude", {
      start: 0,
      end: 100,
      kind: "record",
      value: {
        ...main,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Tool", input }] },
      },
    });
    expect(record.entries[0]).toMatchObject({
      text: "Tool",
      detail: "Structured arguments omitted.",
    });
    expect(record.entries[0]?.truncated).toBeUndefined();
    expect(JSON.stringify(record.entries)).not.toContain("private nested");
  });
  it("retains distinct subagent grouping evidence without showing its identifiers", () => {
    const record = claude("assistant", "Child answer", {
      isSidechain: true,
      agentId: "child-agent",
      sessionId: other,
    });
    expect(record.node).toMatchObject({ scope: "side:child-agent", session: other });
    expect(JSON.stringify(record.entries)).not.toContain("child-agent");
    expect(claude("assistant", "Team", { teamName: "reviewers" }).node?.scope).toBe(
      "side:reviewers",
    );
  });
  it("retains invisible metadata links for branch traversal", () => {
    const record = claude("user", "INTERNAL CONTEXT", { isMeta: true, parentUuid: "previous" });
    expect(record.entries).toEqual([]);
    expect(record.node).toMatchObject({ parent: "previous", meta: true });
    const progress = decode("claude", {
      ...main,
      type: "progress",
      parentUuid: "previous",
      data: { text: "private progress metadata" },
    });
    expect(progress.entries).toEqual([]);
    expect(progress.node).toMatchObject({ role: "other", parent: "previous" });
  });
  it("omits hidden reasoning, including a legacy analysis channel", () => {
    const record = claude("assistant", [
      { type: "thinking", thinking: "HIDDEN" },
      { type: "redacted_thinking", data: "ENCRYPTED" },
      { type: "text", text: "Visible" },
    ]);
    expect(record.entries.map((entry) => entry.text)).toEqual(["Visible"]);
    const analysis = claude("assistant", [], {
      message: { role: "assistant", channel: "analysis", content: "HIDDEN" },
    });
    expect(analysis.entries).toEqual([]);
    expect(analysis.node?.meta).toBe(true);
  });
  it("groups summaries and does not follow a logical compaction parent", () => {
    const summary = claude("user", "A concise summary", {
      isCompactSummary: true,
      logicalParentUuid: "old-branch",
    });
    expect(summary.kind).toBe("compaction");
    expect(summary.entries[0]).toMatchObject({
      kind: "group",
      text: "Conversation summary",
      detail: "A concise summary",
      collapsed: true,
    });
    expect(summary.node).toMatchObject({ compact: true, parent: null });
    expect(JSON.stringify(summary)).not.toContain("old-branch");
    const boundary = decode("claude", { ...main, type: "system", subtype: "compact_boundary" });
    expect(boundary.kind).toBe("compaction");
    expect(boundary.entries).toEqual([]);
  });
  it.each([
    { type: "ai-title", aiTitle: "SECRET" },
    { type: "agent-name", agentName: "SECRET" },
    { type: "agent-setting", agentSetting: "SECRET" },
    { type: "mode", mode: "SECRET" },
    { type: "permission-mode", permissionMode: "SECRET" },
    { type: "atis-latch", atis: "SECRET" },
    { type: "cost-state", cost: "SECRET" },
    { type: "api-request", params: "SECRET" },
    { type: "api-request-blob", message: { role: "assistant", content: "SECRET" } },
    { type: "api-request-shape", shape: "SECRET" },
  ])("hides Claude Code session bookkeeping: $type", (fields) => {
    const record = decode("claude", { sessionId: main.sessionId, ...fields });
    expect(record.kind).toBe("ignored");
    expect(record.entries).toEqual([]);
  });
  it("shows server-run tools such as web search as tool calls and results", () => {
    const record = claude("assistant", [
      { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "terms" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv-1",
        content: [{ type: "web_search_result" }],
      },
      { type: "tool_search_tool_result", tool_use_id: "srv-2", content: { tools: ["SECRET"] } },
    ]);
    expect(record.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["tool-call", "web_search · terms"],
      ["tool-result", "Tool result"],
      ["tool-result", "Tool result"],
    ]);
    expect(JSON.stringify(record.entries)).not.toContain("SECRET");
  });
  it("marks unknown records and blocks without forwarding arbitrary fields", () => {
    const unknown = decode("claude", { type: "future-message", payload: "SECRET" });
    expect(unknown.kind).toBe("unsupported");
    expect(unknown.entries[0]?.kind).toBe("unsupported");
    const block = claude("assistant", [{ type: "future-block", text: "SECRET" }]);
    expect(JSON.stringify([unknown.entries, block.entries])).not.toContain("SECRET");
  });
  it("refuses malformed message envelopes and labels media without copying it", () => {
    const mismatch = claude("assistant", [], { message: { role: "user", content: "SECRET" } });
    expect(mismatch.kind).toBe("unsupported");
    expect(mismatch.node?.mainMessage).toBe(false);
    expect(JSON.stringify(mismatch.entries)).not.toContain("SECRET");
    const media = claude("user", [
      { type: "image", source: { data: "SECRET" } },
      { type: "document", source: { data: "SECRET" } },
    ]);
    expect(media.entries.every((entry) => entry.text === "Non-text content omitted")).toBe(true);
    expect(JSON.stringify(media.entries)).not.toContain("SECRET");
  });
});

describe("record resource bounds and framing", () => {
  it.each(["claude", "codex"] as const)(
    "bounds entries and serialized bytes for %s before handing data to a projector",
    (agent) => {
      const content = Array.from({ length: 60 }, () => ({
        type: agent === "claude" ? "text" : "output_text",
        text: '\\"\n'.repeat(180),
      }));
      const record =
        agent === "claude"
          ? claude("assistant", content)
          : codex({ type: "message", role: "assistant", content });
      expect(record.entries.length).toBeLessThanOrEqual(TRANSCRIPT_RECORD_ENTRIES);
      expect(Buffer.byteLength(JSON.stringify(record.entries))).toBeLessThanOrEqual(
        TRANSCRIPT_RECORD_BYTES,
      );
      expect(record.entries.at(-1)).toMatchObject({ kind: "status", truncated: true });
      expect(
        record.entries.every((entry) => Buffer.byteLength(entry.text) <= TRANSCRIPT_TEXT_BYTES),
      ).toBe(true);
    },
  );
  it("caps an individually large message and tool result, with visible truncation", () => {
    const text = "x".repeat(40_000);
    const message = claude("assistant", text);
    expect(message.entries[0]).toMatchObject({ kind: "assistant", truncated: true });
    expect(Buffer.byteLength(message.entries[0]!.text)).toBe(TRANSCRIPT_TEXT_BYTES);
    const result = codex({ type: "function_call_output", output: text });
    expect(result.entries[0]).toMatchObject({ kind: "tool-result", truncated: true });
    expect(Buffer.byteLength(result.entries[0]!.detail!)).toBe(1024);
  });
  it("keeps the end of a failed tool result and the start of a successful one", () => {
    const output = (end: string) => `${"line\n".repeat(4000)}${end}`;
    const failed = claude("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: true,
        content: output("FAILED: 2 tests"),
      },
    ]).entries[0]!;
    expect(failed).toMatchObject({ text: "Tool error", truncated: true });
    expect(failed.detail!.endsWith("FAILED: 2 tests")).toBe(true);
    expect(Buffer.byteLength(failed.detail!)).toBe(TRANSCRIPT_DETAIL_BYTES);
    const passed = claude("user", [
      { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: output("ok") }] },
    ]).entries[0]!;
    expect(passed.detail!.startsWith("line\nline")).toBe(true);
    expect(Buffer.byteLength(passed.detail!)).toBe(1024);
    const short = claude("user", [
      { type: "tool_result", tool_use_id: "t3", is_error: true, content: "No file" },
    ]).entries[0]!;
    expect(short).toMatchObject({ detail: "No file" });
    expect(short.truncated).toBeUndefined();
  });
  it("keeps whole characters and drops controls at the cut end of a tail", () => {
    expect(transcriptTail("ab\u0007🐈c", 5)).toEqual({ text: "🐈c", truncated: true });
    expect(transcriptTail("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(transcriptTail("\udc00x", 4)).toEqual({ text: "�x", truncated: false });
  });
  it("keeps array results within one aggregate budget including separators and Unicode", () => {
    const record = codex({
      type: "function_call_output",
      output: Array.from({ length: 50 }, () => ({ type: "input_text", text: "🐈".repeat(200) })),
    });
    expect(Buffer.byteLength(record.entries[0]!.detail!)).toBeLessThanOrEqual(
      TRANSCRIPT_DETAIL_BYTES,
    );
    expect(record.entries[0]?.truncated).toBe(true);
  });
  it("does not interpret an input beyond the framing byte limit", () => {
    const record = claude("assistant", "PRIVATE ".repeat(20_000));
    expect(record.kind).toBe("skipped");
    expect(record.entries[0]?.truncated).toBe(true);
    expect(JSON.stringify(record.entries)).not.toContain("PRIVATE");
  });
  it("reports a bounded notice for each framing failure without including the failed bytes", () => {
    for (const reason of [
      "partial-prefix",
      "line-too-large",
      "invalid-utf8",
      "invalid-json",
    ] as const) {
      const record = decodeTranscriptRecord("claude", {
        kind: "skipped",
        start: 4,
        end: 200_000,
        reason,
      });
      expect(record).toMatchObject({ start: 4, end: 200_000, kind: "skipped" });
      expect(record.entries).toHaveLength(1);
      expect(record.entries[0]?.truncated).toBe(true);
    }
  });
  it("waits for a complete JSONL line before a record is available", () => {
    const decoder = new TranscriptJsonl();
    const value = { ...main, type: "user", message: { role: "user", content: "Question" } };
    const bytes = Buffer.from(JSON.stringify(value));
    expect(decoder.push(bytes).lines).toEqual([]);
    const lines = decoder.push(Buffer.from("\n")).lines;
    expect(lines).toHaveLength(1);
    expect(decodeTranscriptRecord("claude", lines[0]!).entries[0]?.text).toBe("Question");
    decoder.close();
  });
  it("rejects unsupported agents and invalid byte ranges", () => {
    const line = { kind: "record" as const, start: 0, end: 1, value: {} };
    expect(() => decodeTranscriptRecord("unknown" as TranscriptAgent, line)).toThrow(
      "Unsupported transcript agent",
    );
    for (const [start, end] of [
      [-1, 1],
      [1, 1],
      [2, 1],
      [0, Number.NaN],
      [0, 1.5],
    ]) {
      expect(() => decodeTranscriptRecord("claude", { ...line, start: start!, end: end! })).toThrow(
        "Invalid transcript record range",
      );
    }
  });
  it("does not accept control suffixes in private graph and session identities", () => {
    expect(transcriptSessionId(`${session}\n`)).toBeNull();
    const record = claude("assistant", "Answer", { uuid: "entry\n" });
    expect(record.node).toBeUndefined();
    expect(record.kind).toBe("unsupported");
    expect(
      claude("assistant", "Answer", { timestamp: "2026-10-21T10:00:00Z\n" }).node?.timestamp,
    ).toBeNull();
  });
});

describe("Codex canonical file header", () => {
  it.each([
    { history_mode: "paginated", history_base: { path: "/private/other.jsonl", ordinal: 3 } },
    { history_mode: "future" },
    { history_mode: null },
    { history_base: { path: "/private/other.jsonl", ordinal: 12 } },
    { subagent_history_start_ordinal: 0 },
    { subagent_history_start_ordinal: 42 },
  ])("rejects unsupported inherited/paginated history without exposing metadata: %j", (fields) => {
    const record = decode("codex", { type: "session_meta", payload: { id: session, ...fields } });
    const proof = new CodexTranscriptHeader(session);
    proof.observe(record);
    expect(proof.status).toBe("unsupported");
    expect(record.supported).toBe(false);
    expect(JSON.stringify(record)).not.toContain("/private/");
  });
  it("accepts a self-contained paginated header from current Codex", () => {
    const proof = new CodexTranscriptHeader(session);
    proof.observe(
      decode("codex", {
        type: "session_meta",
        payload: { id: session, history_mode: "paginated", history_base: null },
      }),
    );
    expect(proof.status).toBe("verified");
  });
  it("shows typed prompts from paginated files but not harness context", () => {
    const prompt = (metadata: Record<string, unknown>, text = "Fix the build") =>
      decode("codex", {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        metadata,
      });
    const typed = {
      retained_source: { id: { role: "user", message_id: "m1" }, complete: true },
      client_authored: false,
      user_input_order: 3,
    };
    expect(prompt(typed).entries).toEqual([
      expect.objectContaining({ kind: "user", text: "Fix the build" }),
    ]);
    expect(prompt({}, "# AGENTS.md instructions").entries).toEqual([]);
    expect(prompt({ ...typed, user_input_order: undefined }).entries).toEqual([]);
    expect(prompt({ ...typed, client_authored: true }).entries).toEqual([]);
    expect(prompt({ ...typed, retained_source: { id: { role: "assistant" } } }).entries).toEqual(
      [],
    );
  });
  it("accepts an explicit self-contained legacy header", () => {
    const proof = new CodexTranscriptHeader(session);
    proof.observe(
      decode("codex", {
        type: "session_meta",
        payload: {
          id: session,
          history_mode: "legacy",
          history_base: null,
          subagent_history_start_ordinal: null,
        },
      }),
    );
    expect(proof.status).toBe("verified");
  });
  const header = (id: unknown, start = 0) =>
    decode(
      "codex",
      {
        type: "session_meta",
        payload: {
          id,
          session_id: other,
          cwd: "/private/project",
          creator_user_id: "PRIVATE ACCOUNT",
        },
      },
      start,
    );
  it("verifies the native thread ID, not a root session_id, and exposes no source metadata", () => {
    const proof = new CodexTranscriptHeader(session);
    expect(proof.status).toBe("pending");
    const record = header(session);
    proof.observe(record);
    expect(proof.status).toBe("verified");
    expect(record.entries).toEqual([]);
    expect(JSON.stringify(record)).not.toMatch(/private|ACCOUNT|22222222/);
  });
  it("ignores inherited fork metadata after the canonical first header", () => {
    const proof = new CodexTranscriptHeader(session);
    proof.observe(header(session));
    proof.observe(header(other, 200));
    expect(proof.status).toBe("verified");
  });
  it("never lets later matching metadata repair an initial mismatch", () => {
    const proof = new CodexTranscriptHeader(session);
    proof.observe(header(other));
    proof.observe(header(session, 200));
    expect(proof.status).toBe("mismatch");
  });
  it("refuses tail-only metadata, malformed identities or an unsupported initial record", () => {
    for (const record of [
      header(session, 200),
      header("not-a-uuid"),
      decode("codex", { type: "unknown", private: "PRIVATE" }),
    ]) {
      const proof = new CodexTranscriptHeader(session);
      proof.observe(record);
      proof.observe(header(session));
      expect(proof.status).toBe("unsupported");
    }
  });
  it("does not revive after its generation is closed", () => {
    const proof = new CodexTranscriptHeader(session);
    proof.observe(header(session));
    proof.close();
    proof.observe(header(session));
    expect(proof.status).toBe("closed");
    expect(() => new CodexTranscriptHeader("private invalid ID")).toThrow(
      "Invalid transcript session identity",
    );
  });
});

describe("Codex record decoding", () => {
  it("omits known legacy internal/duplicate events while keeping canonical content", () => {
    for (const type of [
      "thread_settings_applied",
      "thread_goal_updated",
      "context_compacted",
      "patch_apply_end",
      "mcp_tool_call_end",
      "web_search_end",
      "image_generation_end",
      "item_completed",
    ])
      expect(
        decode("codex", {
          type: "event_msg",
          payload: { type, message: "INTERNAL", item: { text: "DUPLICATE" } },
        }).entries,
      ).toEqual([]);
    // Built-in steps with no result record in the transcript are one-line work, not calls:
    // the phone pairs results with calls in order, so a call that is never answered would
    // take the next tool's result.
    for (const [type, kind] of [
      ["local_shell_call", "group"],
      ["tool_search_call", "tool-call"],
      ["web_search_call", "group"],
      ["image_generation_call", "group"],
    ] as const) {
      const record = codex({ type, content: "PRIVATE", internal: { path: "/private" } });
      expect(record.entries[0]).toMatchObject({ kind, collapsed: true });
      expect(JSON.stringify(record)).not.toMatch(/PRIVATE|private/);
    }
    expect(codex({ type: "tool_search_output", content: "PRIVATE" }).entries[0]).toMatchObject({
      kind: "tool-result",
      text: "Tool search result",
      collapsed: true,
    });
    const records = [
      codex({ type: "agent_message", author: "PRIVATE", content: "PRIVATE" }),
      decode("codex", {
        type: "event_msg",
        payload: { type: "sub_agent_activity", agent_id: "PRIVATE" },
      }),
    ];
    for (const record of records) {
      expect(record.entries[0]).toMatchObject({
        kind: "group",
        text: "Subagent activity",
        collapsed: true,
      });
      expect(JSON.stringify(record)).not.toContain("PRIVATE");
    }
  });
  it.each(["environment_context", "future-context", null])(
    "does not display user events with an unrecognized explicit kind: %s",
    (kind) => {
      expect(
        decode("codex", {
          type: "event_msg",
          payload: { type: "user_message", kind, message: "INTERNAL" },
        }).entries,
      ).toEqual([]);
      expect(
        decode("codex", {
          type: "event_msg",
          payload: { type: "user_message", kind: "plain", message: "Question" },
        }).entries[0]?.text,
      ).toBe("Question");
    },
  );
  it.each([
    "user_instructions",
    "environment_context",
    "environments_instructions",
    "apps_instructions",
    "skills_instructions",
    "plugins_instructions",
    "tools",
    "collaboration_mode",
    "multi_agent_mode",
    "realtime_conversation",
    "context_window",
    "context_window_guidance",
  ])("omits harness user-role context in %s blocks", (tag) => {
    const record = codex({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<${tag}>PRIVATE CONTEXT</${tag}>`,
        },
      ],
    });
    expect(record.entries).toEqual([]);
  });
  it("uses the legacy display-input event once without duplicating its model-context response item", () => {
    const duplicate = codex({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Actual question" }],
    });
    const event = decode("codex", {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Actual question",
        images: ["PRIVATE IMAGE"],
        local_images: ["/private/image"],
      },
    });
    expect(duplicate.entries).toEqual([]);
    expect(event.entries).toEqual([{ id: "0:0", kind: "user", text: "Actual question" }]);
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|private/);
    expect(
      decode("codex", { type: "event_msg", payload: { type: "user_message", message: {} } })
        .entries[0]?.kind,
    ).toBe("unsupported");
  });
  it.each([{ inherited_user_message: true }, { delivered_assistant_message: "confirmed" }])(
    "omits inherited/delivered harness text: %j",
    (metadata) => {
      const record = codex(
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "INTERNAL" }],
        },
        { metadata },
      );
      expect(record.entries).toEqual([]);
    },
  );
  it("keeps stable partial answers visible", () => {
    const record = codex({
      type: "message",
      role: "assistant",
      phase: "partial_answer",
      content: [{ type: "output_text", text: "Partial answer" }],
    });
    expect(record.entries[0]).toMatchObject({ kind: "assistant", text: "Partial answer" });
  });
  it("previews only known fields from JSON function arguments", () => {
    const record = codex({
      type: "function_call",
      name: "exec",
      arguments: JSON.stringify({ cmd: "pwd", workdir: "/PRIVATE", internal: "SECRET" }),
    });
    expect(record.entries[0]).toMatchObject({ text: "exec · pwd" });
    expect(record.entries[0]?.truncated).toBeUndefined();
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE|SECRET|workdir/);
    for (const args of ['{"secret":"PRIVATE"}', '{"broken":', '"PRIVATE"', '["PRIVATE"]'])
      expect(codex({ type: "function_call", arguments: args }).entries[0]).toMatchObject({
        text: "Tool",
        detail: "Structured arguments omitted.",
      });
  });
  it.each(["configuration_update", "compaction", "context_compaction"])(
    "omits internal response item %s",
    (type) => {
      expect(codex({ type, content: "INTERNAL" }).entries).toEqual([]);
    },
  );
  it("reads only known message content fields and keeps source metadata private", () => {
    const record = codex(
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Answer", annotations: ["SECRET"] }],
        encrypted_content: "SECRET",
      },
      { metadata: { private: "SECRET" } },
    );
    expect(record.entries).toEqual([{ id: "0:0", kind: "assistant", text: "Answer" }]);
    expect(JSON.stringify(record)).not.toContain("SECRET");
  });
  it.each(["function_call", "custom_tool_call"])(
    "normalizes %s arguments as collapsed text",
    (type) => {
      const record = codex({ type, name: "exec", arguments: '{"cmd":"pwd"}', input: "pwd" });
      expect(record.entries[0]).toMatchObject({
        kind: "tool-call",
        text: "exec · pwd",
        collapsed: true,
      });
      expect(record.entries[0]?.detail).toBeUndefined();
    },
  );
  it.each(["function_call_output", "custom_tool_call_output"])(
    "reads string and text-array %s results",
    (type) => {
      expect(codex({ type, output: "result" }).entries[0]).toMatchObject({
        kind: "tool-result",
        detail: "result",
        collapsed: true,
      });
      const record = codex({
        type,
        output: [
          { type: "input_text", text: "first" },
          { type: "input_image", image_url: "SECRET" },
          { type: "input_text", text: "last" },
        ],
      });
      expect(record.entries[0]?.detail).toBe("first\n[Non-text content omitted]\nlast");
      expect(JSON.stringify(record)).not.toContain("SECRET");
    },
  );
  it.each([
    { type: "reasoning", summary: [{ text: "SECRET" }], encrypted_content: "SECRET" },
    { type: "additional_tools", tools: ["SECRET"] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "SECRET" }] },
    { type: "message", role: "system", content: [{ type: "input_text", text: "SECRET" }] },
    {
      type: "message",
      role: "assistant",
      channel: "analysis",
      content: [{ type: "output_text", text: "SECRET" }],
    },
  ])("omits model-internal record $type", (payload) => {
    expect(codex(payload).entries).toEqual([]);
  });
  it("does not duplicate message events or reveal reasoning event payloads", () => {
    for (const type of [
      "agent_message",
      "agent_reasoning",
      "agent_reasoning_raw_content",
      "token_count",
    ]) {
      expect(
        decode("codex", { type: "event_msg", payload: { type, message: "SECRET" } }).entries,
      ).toEqual([]);
    }
    expect(
      decode("codex", { type: "event_msg", payload: { type: "task_started", hidden: "SECRET" } })
        .entries[0],
    ).toMatchObject({ kind: "status", text: "Working" });
    const error = decode("codex", {
      type: "event_msg",
      payload: { type: "error", message: "PRIVATE ERROR" },
    });
    expect(error.entries[0]?.text).toBe("Agent reported an error");
    expect(JSON.stringify(error)).not.toContain("PRIVATE ERROR");
  });
  it("groups compaction without flattening duplicated replacement history", () => {
    const record = decode("codex", {
      type: "compacted",
      payload: {
        message: "Summary",
        replacement_history: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "DUPLICATE" }] },
        ],
      },
    });
    expect(record.kind).toBe("compaction");
    expect(record.entries).toEqual([
      {
        id: "0:0",
        kind: "group",
        text: "Conversation summary",
        detail: "Summary",
        collapsed: true,
      },
    ]);
    expect(JSON.stringify(record)).not.toContain("DUPLICATE");
    const generated = codex(
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Summary" }] },
      { metadata: { compaction_output: true } },
    );
    expect(generated.kind).toBe("compaction");
    expect(generated.entries[0]?.collapsed).toBe(true);
  });
  it("groups inter-agent activity without interpreting unreviewed payloads", () => {
    const event = decode("codex", {
      type: "inter_agent_communication",
      payload: { unknown: "SECRET" },
    });
    expect(event.entries[0]).toMatchObject({
      kind: "group",
      text: "Subagent activity",
      collapsed: true,
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });
  it("uses explicit placeholders for unfamiliar phases, content, event and record kinds", () => {
    for (const record of [
      codex({
        type: "message",
        role: "assistant",
        phase: "future-phase",
        content: [{ type: "output_text", text: "SECRET" }],
      }),
      codex({
        type: "message",
        role: "assistant",
        content: [{ type: "future-content", text: "SECRET" }],
      }),
      decode("codex", { type: "event_msg", payload: { type: "future-event", text: "SECRET" } }),
      decode("codex", { type: "future-record", payload: { text: "SECRET" } }),
    ]) {
      expect(record.entries[0]?.kind).toBe("unsupported");
      expect(JSON.stringify(record.entries)).not.toContain("SECRET");
    }
  });
});

describe("Claude text written on the owner's behalf", () => {
  const shown = (content: unknown) =>
    claude("user", content).entries.map((entry) => [entry.kind, entry.text]);
  it("shows a background task notice as one line", () => {
    const notice =
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Wait for CI" completed (exit code 0)</summary>\n</task-notification>';
    expect(shown(notice)).toEqual([
      ["status", 'Background command "Wait for CI" completed (exit code 0)'],
    ]);
    expect(shown([{ type: "text", text: notice }])).toEqual([
      ["status", 'Background command "Wait for CI" completed (exit code 0)'],
    ]);
    expect(shown("<task-notification><status>killed</status></task-notification>")).toEqual([
      ["status", "A background task finished"],
    ]);
  });
  it("shows slash and shell commands as the owner typed them", () => {
    expect(
      shown(
        "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
      ),
    ).toEqual([["user", "/model opus"]]);
    expect(shown("<command-message>compact</command-message>")).toEqual([["user", "/compact"]]);
    expect(shown("<bash-input>git status</bash-input>")).toEqual([["user", "! git status"]]);
  });
  it("keeps the first line of command output and drops caveats and reminders", () => {
    expect(
      shown("<local-command-stdout>\n\nSet model to opus\nmore</local-command-stdout>"),
    ).toEqual([["status", "Set model to opus"]]);
    expect(shown("<bash-stdout></bash-stdout><bash-stderr>fatal: no repo</bash-stderr>")).toEqual([
      ["status", "fatal: no repo"],
    ]);
    expect(shown("<local-command-caveat>Caveat: generated</local-command-caveat>")).toEqual([]);
    expect(shown("<system-reminder>internal</system-reminder>")).toEqual([]);
  });
  it("leaves ordinary messages and the agent's own text alone", () => {
    expect(shown("Fix <b>this</b>")).toEqual([["user", "Fix <b>this</b>"]]);
    expect(
      claude("assistant", "<task-notification>x</task-notification>").entries[0],
    ).toMatchObject({ kind: "assistant" });
  });
});
