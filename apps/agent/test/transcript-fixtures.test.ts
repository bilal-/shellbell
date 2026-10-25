import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    // Fields whose short enum-like values are kept; every other string must be filler, an ID
    // stand-in or a fixed timestamp. Keys must be format words, not IDs or paths.
    const kept = new Set([
      "type",
      "subtype",
      "role",
      "channel",
      "phase",
      "history_mode",
      "kind",
      "version",
      "cli_version",
      "status",
      "stop_reason",
      "originator",
      "name",
    ]);
    const filler = /^(?:lorem ipsum dolor sit amet ?)*[a-z ]*$|^x$/;
    const id =
      /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}|(?:toolu|call|msg|req|resp|srvtoolu|fc|rs|ws)_[0-9a-f]{24}|[0-9a-f]{24})$/;
    const problems: string[] = [];
    const visit = (value: unknown, key: string) => {
      if (Array.isArray(value)) for (const item of value) visit(item, key);
      else if (value && typeof value === "object")
        for (const [name, item] of Object.entries(value)) {
          if (!/^[a-z][A-Za-z_]{0,40}$|^key\d+$/.test(name)) problems.push(`key ${name}`);
          visit(item, name);
        }
      else if (typeof value === "string") {
        const ok =
          filler.test(value) ||
          id.test(value) ||
          value === SESSION ||
          value === "2026-01-01T00:00:00.000Z" ||
          value === "mcp__server__tool" ||
          (kept.has(key) && /^[a-z][a-z0-9_.-]{0,40}$/i.test(value));
        if (!ok) problems.push(`${key}: ${value.slice(0, 40)}`);
      }
    };
    for (const { name } of fixtures.filter((item) => item.name.endsWith(".jsonl")))
      for (const line of readFileSync(join(DIR, name), "utf8").split("\n").filter(Boolean))
        visit(JSON.parse(line), "");
    expect(problems.slice(0, 10)).toEqual([]);
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
