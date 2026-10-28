import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptDocument } from "../src/conversation/transcript-document.js";
import { TranscriptJsonl } from "../src/conversation/transcript-jsonl.js";
import {
  decodeTranscriptRecord,
  type TranscriptRecord,
  transcriptOutline,
} from "../src/conversation/transcript-record.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const FIXTURE = join(import.meta.dirname, "fixtures/transcripts/gemini-0.62.0.jsonl");

function decode(text: string): TranscriptRecord[] {
  const framing = new TranscriptJsonl(0, false, transcriptOutline("gemini"));
  return framing
    .push(Buffer.from(text))
    .lines.map((line) => decodeTranscriptRecord("gemini", line));
}
function rows(text: string, session = SESSION) {
  const document = new TranscriptDocument("gemini", session);
  document.append(decode(text));
  return document.snapshot();
}

describe("Gemini transcripts", () => {
  it("keeps the newest version of each message in its place and applies rewinds", () => {
    const snapshot = rows(readFileSync(FIXTURE, "utf8"));
    expect(snapshot.state).toBe("ready");
    expect(snapshot.branch).toEqual({ kind: "rows" });
    expect(snapshot.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user", "lorem ipsum"],
      ["assistant", "lorem ipsum dolor"],
      ["tool-call", "read_file · lorem ipsum"],
      ["tool-result", "Tool result"],
      ["tool-call", "run_shell_command · lorem ipsum"],
      ["tool-result", "Tool error"],
      ["user", "lorem ipsum dolor"],
      ["assistant", "lorem ipsum dolor sit amet"],
      ["group", "Subagent activity"],
      ["tool-call", "replace · lorem ipsum"],
      ["tool-result", "Tool error"],
    ]);
  });

  it("never shows thoughts, tokens or the model", () => {
    const line = JSON.stringify({
      id: "m1",
      type: "gemini",
      content: "Visible reply",
      thoughts: [{ subject: "PRIVATE_THOUGHT", description: "PRIVATE_THOUGHT" }],
      tokens: { input: 1 },
      model: "PRIVATE_MODEL",
    });
    const header = JSON.stringify({ sessionId: SESSION, projectHash: "x", kind: "main" });
    const text = JSON.stringify(rows(`${header}\n${line}\n`).entries);
    expect(text).toContain("Visible reply");
    expect(text).not.toContain("PRIVATE");
  });

  it("refuses another session's file and subagent transcripts", () => {
    const body = `${JSON.stringify({ id: "m1", type: "gemini", content: "x" })}\n`;
    const header = (fields: object) =>
      `${JSON.stringify({ sessionId: SESSION, projectHash: "x", ...fields })}\n`;
    expect(rows(header({}) + body, "22222222-2222-4222-8222-222222222222").state).toBe("unbound");
    expect(rows(header({ kind: "subagent" }) + body).state).toBe("unsupported");
  });

  it("hides the session context Gemini lists first, as a real 0.62 session starts", () => {
    const header = JSON.stringify({ sessionId: SESSION, projectHash: "x", kind: "main" });
    const context = {
      id: "c1",
      type: "user",
      content: [{ text: "<session_context>\nPRIVATE_CONTEXT\n</session_context>" }],
    };
    const set = JSON.stringify({ $set: { messages: [context], lastUpdated: "t" } });
    const prompt = JSON.stringify({ id: "p1", type: "user", content: [{ text: "Hello" }] });
    const snapshot = rows(`${header}\n${set}\n${prompt}\n`);
    expect(snapshot.entries.map((entry) => [entry.kind, entry.text])).toEqual([["user", "Hello"]]);
    expect(JSON.stringify(snapshot.entries)).not.toContain("PRIVATE_CONTEXT");
    // A failed request: Gemini lists the context alone again, dropping the prompt.
    expect(rows(`${header}\n${set}\n${prompt}\n${set}\n`).entries).toEqual([]);
  });

  it("hides only Gemini's own context tags, never a prompt that happens to be markup", () => {
    const header = JSON.stringify({ sessionId: SESSION, projectHash: "x", kind: "main" });
    const prompt = JSON.stringify({ id: "p1", type: "user", content: "<div>fix this</div>" });
    expect(rows(`${header}\n${prompt}\n`).entries.map((entry) => entry.text)).toEqual([
      "<div>fix this</div>",
    ]);
  });

  it("treats messages listed in a $set like messages on their own lines", () => {
    const header = JSON.stringify({ sessionId: SESSION, projectHash: "x", kind: "main" });
    const list = JSON.stringify({
      $set: {
        messages: [
          { id: "u1", type: "user", content: "first" },
          { id: "m1", type: "gemini", content: "old" },
        ],
      },
    });
    const updated = JSON.stringify({ id: "m1", type: "gemini", content: "new" });
    expect(rows(`${header}\n${list}\n${updated}\n`).entries.map((e) => e.text)).toEqual([
      "first",
      "new",
    ]);
    const second = JSON.stringify({ id: "u2", type: "user", content: "second" });
    const rewind = JSON.stringify({ $rewindTo: "m1" });
    expect(rows(`${header}\n${list}\n${second}\n${rewind}\n`).entries.map((e) => e.text)).toEqual([
      "first",
    ]);
  });

  it("shows an unknown message type as a placeholder, not its contents", () => {
    const header = JSON.stringify({ sessionId: SESSION, projectHash: "x" });
    const odd = JSON.stringify({ id: "m1", type: "future_kind", content: "PRIVATE" });
    const snapshot = rows(`${header}\n${odd}\n`);
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual(["unsupported"]);
    expect(JSON.stringify(snapshot.entries)).not.toContain("PRIVATE");
  });
});
