import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  jsonFixtureProblems,
  protobufFixtureProblems,
  protobufFixtureStable,
  scrubJson,
  scrubProtobuf,
} from "../scripts/fixture-scrub.js";
import { protobufFields } from "../src/conversation/antigravity.js";
import { TranscriptDocument } from "../src/conversation/transcript-document.js";
import {
  TRANSCRIPT_FORMATS,
  transcriptFormatNotice,
  transcriptFormatStatus,
} from "../src/conversation/transcript-formats.js";
import { TranscriptJsonl } from "../src/conversation/transcript-jsonl.js";
import {
  decodeTranscriptRecord,
  type TranscriptRecord,
  transcriptOutline,
} from "../src/conversation/transcript-record.js";

const DIR = join(import.meta.dirname, "fixtures/transcripts");
const SESSION = "11111111-1111-4111-8111-111111111111";

/** `claude-2.1.309.jsonl`: one anonymised transcript per agent version an adapter supports. */
const fixtures = readdirSync(DIR)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => {
    const [, agent, version] = /^(claude|codex)-(.+)\.jsonl$/.exec(name)!;
    return { name, agent: agent as "claude" | "codex", version: version! };
  });

function decode(agent: "claude" | "codex", bytes: Buffer): TranscriptRecord[] {
  const framing = new TranscriptJsonl(0, false, transcriptOutline(agent));
  const records: TranscriptRecord[] = [];
  for (let at = 0; at < bytes.length; ) {
    const framed = framing.push(bytes.subarray(at, at + 65536));
    at += framed.consumed;
    records.push(...framed.lines.map((line) => decodeTranscriptRecord(agent, line)));
  }
  return records;
}

describe("agent transcript formats", () => {
  it("has a fixture for each end of every tested version range", () => {
    for (const [agent, format] of Object.entries(TRANSCRIPT_FORMATS)) {
      const versions = fixtures.filter((item) => item.agent === agent).map((item) => item.version);
      expect(versions, agent).toContain(format.from);
      expect(versions, agent).toContain(format.through);
    }
  });

  it.each(fixtures)("reads $name without unsupported rows", ({ agent, version, name }) => {
    expect(transcriptFormatStatus(agent, version)).toBe("tested");
    const records = decode(agent, readFileSync(join(DIR, name)));
    const unsupported = records.filter((record) =>
      record.entries.some((entry) => entry.kind === "unsupported"),
    );
    expect(unsupported.map((record) => record.start)).toEqual([]);
    const document = new TranscriptDocument(agent, SESSION);
    for (let i = 0; i < records.length; i += 64) document.append(records.slice(i, i + 64));
    const snapshot = document.snapshot();
    expect(snapshot.state).toBe("ready");
    expect(snapshot.entries.some((entry) => entry.kind === "assistant")).toBe(true);
    expect(snapshot.entries.some((entry) => entry.id === "format")).toBe(false);
  });

  it("holds nothing from the transcripts they were made from", () => {
    const problems: string[] = [];
    for (const { name } of fixtures.filter((item) => item.name.endsWith(".jsonl")))
      for (const line of readFileSync(join(DIR, name), "utf8").split("\n").filter(Boolean)) {
        const value = JSON.parse(line);
        // Parsing keeps only the last of duplicate keys; the raw line must hold nothing else.
        if (JSON.stringify(value) !== line) problems.push(`${name}: not canonical JSON`);
        problems.push(...jsonFixtureProblems(value));
      }
    const db = new DatabaseSync(join(DIR, "agy-1.4.7.db"), { readOnly: true });
    // One table of numbers and payloads, and no free pages that could hold old data.
    const tables = db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[];
    if (tables.map((table) => table.name).join() !== "steps") problems.push("agy: extra tables");
    const free = db.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
    if (free.freelist_count !== 0) problems.push("agy: free pages");
    const rows = db
      .prepare(
        "SELECT typeof(idx) AS a, typeof(step_type) AS b, typeof(status) AS c, step_payload AS payload FROM steps",
      )
      .all() as { a: string; b: string; c: string; payload: Uint8Array | null }[];
    db.close();
    for (const { a, b, c, payload } of rows) {
      if ([a, b, c].some((type) => type !== "integer")) problems.push("agy: non-integer column");
      if (!payload) continue;
      problems.push(...protobufFixtureProblems(payload, protobufFields));
      if (!protobufFixtureStable(payload, protobufFields)) problems.push("agy: unlisted bytes");
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("replaces private values the anonymiser has no rule for", () => {
    const record = scrubJson({
      type: "assistant",
      uuid: "alice_ab12",
      originator: "secret-client",
      customerSecret: "x",
      version: "2.1.310",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "internal_client_lookup", input: {} },
          { type: "tool_use", id: "toolu_2", name: "mcp__acme__search", input: {} },
          { type: "secret-project", text: "huntertwo" },
        ],
      },
      payload: { status: "secret-project" },
    });
    const text = JSON.stringify(record);
    for (const secret of [
      "alice",
      "secret-client",
      "customerSecret",
      "internal_client",
      "acme",
      "secret-project",
      "huntertwo",
    ])
      expect(text, secret).not.toContain(secret);
    expect(text).toContain('"version":"2.1.310"');
    expect(text).toContain('"type":"tool_use"');
    // Values that collide with the decoders' words inside tool input are still content.
    const scrubbed = scrubJson({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: {
              type: "message",
              role: "user",
              name: "Bash",
              phase: "toolu_aaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
        ],
      },
    }) as { message: { content: { name: string; input: Record<string, string> }[] } };
    const block = scrubbed.message.content[0]!;
    expect(block.name).toBe("Bash");
    for (const value of Object.values(block.input))
      expect(["message", "user", "Bash"]).not.toContain(value);
    expect(JSON.stringify(block.input)).not.toContain("toolu_a");
    // Content that reuses metadata names, and numbers in content, are replaced.
    const result = scrubJson({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: { version: "123456" } }],
      },
      toolUseResult: { pin: 123456 },
    });
    expect(JSON.stringify(result)).not.toContain("123456");
    // Message content is content unless it is a list of recognised blocks, and the check agrees.
    const shaped = {
      type: "progress",
      message: { content: { version: "123456", text: 987654321 } },
    };
    expect(jsonFixtureProblems(shaped)).not.toEqual([]);
    const cleaned = JSON.stringify(scrubJson(shaped));
    expect(cleaned).not.toContain("123456");
    expect(cleaned).not.toContain("987654321");
    // A recognised block keeps its envelope only; known names inside its text are still content.
    const nested = {
      type: "progress",
      message: { content: [{ type: "text", text: { version: "123456", text: 987654321 } }] },
    };
    expect(jsonFixtureProblems(nested)).not.toEqual([]);
    const nestedClean = JSON.stringify(scrubJson(nested));
    expect(nestedClean).not.toContain("123456");
    expect(nestedClean).not.toContain("987654321");
    expect(nestedClean).toContain('"type":"text"');
    // A fixed-width field hides bytes the field reader skips; the stability check sees them.
    const hidden = Buffer.concat([Buffer.from([0x09]), Buffer.from("SECRET!!")]);
    expect(protobufFixtureStable(hidden, protobufFields)).toBe(false);
    // Text that happens to parse as protobuf is dropped, wherever it is.
    for (const hex of ["9a0106504150415041", "9a01081206504150415041"]) {
      const scrubbed = Buffer.from(scrubProtobuf(Buffer.from(hex, "hex"), protobufFields));
      expect(scrubbed.includes("PAPAPA"), hex).toBe(false);
      expect(protobufFixtureProblems(scrubbed, protobufFields)).toEqual([]);
      // And the leak check sees it in an unscrubbed step.
      expect(protobufFixtureProblems(Buffer.from(hex, "hex"), protobufFields)).not.toEqual([]);
    }
  });

  it("doesn't version-check agents without a declared range", () => {
    expect(transcriptFormatStatus("agy", "99.0.0")).toBe("tested");
    expect(transcriptFormatNotice("agy", "99.0.0")).toBeNull();
  });

  it("says so, once and quietly, for a newer agent version than tested", () => {
    const next = `${Number(TRANSCRIPT_FORMATS.claude.through.split(".")[0]) + 1}.0.0`;
    expect(transcriptFormatStatus("claude", next)).toBe("newer");
    expect(transcriptFormatNotice("claude", next)).toMatch(/^Claude Code \d+\.0\.0 is newer/);
    const record = decodeTranscriptRecord("claude", {
      kind: "record",
      start: 0,
      end: 200,
      value: {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: SESSION,
        version: next,
        message: { role: "user", content: "Hello" },
      },
    });
    expect(record.version).toBe(next);
    const document = new TranscriptDocument("claude", SESSION);
    document.append([record]);
    const entries = document.snapshot().entries;
    expect(entries.at(-1)).toMatchObject({ id: "format", kind: "status" });
    expect(entries.filter((entry) => entry.id === "format")).toHaveLength(1);
  });
});
