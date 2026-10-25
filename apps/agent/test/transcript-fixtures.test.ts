import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_ARGUMENT_KEYS,
  FIXTURE_TOOLS,
  fixtureKeyAllowed,
  fixtureStringAllowed,
  isFillerBytes,
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

/** Every length-delimited leaf of a protobuf message, descending into what parses as one. */
function protobufLeaves(bytes: Uint8Array, depth = 0): Uint8Array[] {
  const fields = protobufFields(bytes, depth);
  if (!fields || depth > 6) return [bytes];
  return fields.flatMap((field) =>
    field.wire === 2 ? (field.value.length > 1 ? protobufLeaves(field.value, depth + 1) : []) : [],
  );
}
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
    const visit = (value: unknown, key: string) => {
      if (Array.isArray(value)) for (const item of value) visit(item, key);
      else if (value && typeof value === "object")
        for (const [name, item] of Object.entries(value)) {
          if (!fixtureKeyAllowed(name)) problems.push(`key ${name}`);
          visit(item, name);
        }
      else if (typeof value === "string" && !fixtureStringAllowed(value, key))
        problems.push(`${key}: ${value.slice(0, 40)}`);
    };
    for (const { name } of fixtures.filter((item) => item.name.endsWith(".jsonl")))
      for (const line of readFileSync(join(DIR, name), "utf8").split("\n").filter(Boolean))
        visit(JSON.parse(line), "");
    // Antigravity: every text leaf the decoder reads must be filler or a listed name.
    const db = new DatabaseSync(join(DIR, "agy-1.4.7.db"), { readOnly: true });
    const rows = db.prepare("SELECT step_payload AS payload FROM steps").all() as {
      payload: Uint8Array | null;
    }[];
    db.close();
    const decoder = new TextDecoder();
    for (const { payload } of rows)
      for (const text of protobufLeaves(payload ?? new Uint8Array()))
        if (
          !isFillerBytes(decoder.decode(text)) &&
          !FIXTURE_TOOLS.has(decoder.decode(text)) &&
          !FIXTURE_ARGUMENT_KEYS.has(decoder.decode(text))
        )
          problems.push(`agy: ${decoder.decode(text).slice(0, 40)}`);
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
    // Text that happens to parse as protobuf is still replaced.
    const step = Buffer.concat([
      Buffer.from([0x9a, 0x01, 0x08, 0x0a, 0x06]),
      Buffer.from("PAPAPA"),
    ]);
    expect(Buffer.from(scrubProtobuf(step, protobufFields)).includes("PAPAPA")).toBe(false);
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
