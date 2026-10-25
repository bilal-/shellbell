import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { herdrTranscriptReference } from "../src/backends/herdr/conversation.js";
import {
  ANTIGRAVITY_STEP,
  type AntigravityStep,
  antigravityEntries,
  protobufFields,
} from "../src/conversation/antigravity.js";
import { AntigravityReader } from "../src/conversation/antigravity-reader.js";
import type { TranscriptIdentity } from "../src/conversation/transcript-file.js";

const FIXTURE = join(import.meta.dirname, "fixtures/transcripts/agy-1.4.7.db");
const ID = "ac41fdcd-1d9a-4a5c-9a5f-4d8aad79650d";

/** A protobuf message from [field, value] pairs: strings, numbers or nested messages. */
type Value = string | number | readonly (readonly [number, Value])[];
function message(fields: readonly (readonly [number, Value])[]): Uint8Array {
  const out: Uint8Array[] = [];
  const varint = (value: number) => {
    const bytes: number[] = [];
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value) byte |= 0x80;
      bytes.push(byte);
    } while (value);
    out.push(Uint8Array.from(bytes));
  };
  for (const [number, value] of fields) {
    if (typeof value === "number") {
      varint(number * 8);
      varint(value);
      continue;
    }
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : message(value);
    varint(number * 8 + 2);
    varint(bytes.length);
    out.push(bytes);
  }
  return Buffer.concat(out);
}
const step = (idx: number, type: number, payload: Uint8Array, status = 3): AntigravityStep => ({
  idx,
  type,
  status,
  payload,
});
const argument = (key: string, value: string) =>
  [
    1,
    [
      [1, key],
      [2, value],
    ],
  ] as const;

function steps(path: string): AntigravityStep[] {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare("SELECT idx, step_type AS type, status, step_payload AS payload FROM steps")
    .all() as unknown as AntigravityStep[];
  db.close();
  return rows;
}

describe("Antigravity steps", () => {
  it("reads messages, replies, tool runs and failures, never reasoning", () => {
    const entries = antigravityEntries([
      step(0, ANTIGRAVITY_STEP.user, message([[19, [[2, "Fix the build"]]]])),
      step(
        1,
        ANTIGRAVITY_STEP.reply,
        message([
          [
            20,
            [
              [1, "Running the tests."],
              [3, "PRIVATE reasoning"],
              [
                7,
                [
                  [1, "call_1"],
                  [2, "run_command"],
                  [3, "{}"],
                ],
              ],
              [
                7,
                [
                  [1, "call_2"],
                  [2, "view_file"],
                  [3, "{}"],
                ],
              ],
            ],
          ],
        ]),
      ),
      step(
        2,
        ANTIGRAVITY_STEP.tool,
        message([[140, [argument("CommandLine", "make test"), [2, [[1, "ok"]]]]]]),
      ),
      step(
        3,
        ANTIGRAVITY_STEP.tool,
        message([
          [31, [[2, "user denied permission"]]],
          [140, [argument("toolSummary", "View AGENTS.md")]],
        ]),
        7,
      ),
      step(4, ANTIGRAVITY_STEP.error, message([[24, [[3, [[2, "API error: quota\nmore"]]]]]])),
      step(5, ANTIGRAVITY_STEP.context, message([[103, [[1, "injected"]]]])),
      step(6, ANTIGRAVITY_STEP.user, message([[19, [[2, "Next"]]]])),
      step(7, ANTIGRAVITY_STEP.tool, message([[140, [argument("Path", "a.ts")]]]), 1),
      step(8, 999, message([[1, "x"]])),
      { idx: 9, type: ANTIGRAVITY_STEP.user, status: 3, payload: null },
    ]);
    expect(entries.map((entry) => [entry.kind, entry.text, entry.detail])).toEqual([
      ["user", "Fix the build", undefined],
      ["assistant", "Running the tests.", undefined],
      ["tool-call", "Run command · make test", undefined],
      ["tool-result", "Tool result", "ok"],
      ["tool-call", "View file · View AGENTS.md", undefined],
      ["tool-result", "Tool error", "user denied permission"],
      ["status", "API error: quota…", undefined],
      ["user", "Next", undefined],
      ["tool-call", "Tool · a.ts", undefined],
      ["unsupported", "(Something this version can't show)", undefined],
      ["status", "A step was too large to show here", undefined],
    ]);
    expect(JSON.stringify(entries)).not.toContain("PRIVATE");
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  it("caps a tool call's text like any other row", () => {
    const entries = antigravityEntries([
      step(
        0,
        ANTIGRAVITY_STEP.reply,
        message([
          [
            20,
            [
              [
                7,
                [
                  [1, "c"],
                  [2, "x".repeat(20_000)],
                  [3, "{}"],
                ],
              ],
            ],
          ],
        ]),
      ),
      step(1, ANTIGRAVITY_STEP.tool, message([[140, [argument("Path", "a")]]])),
    ]);
    const call = entries.find((entry) => entry.kind === "tool-call")!;
    expect(call.text.length).toBeLessThanOrEqual(16 * 1024);
    expect(call.truncated).toBe(true);
  });

  it("refuses malformed protobuf instead of reading part of it", () => {
    expect(protobufFields(Uint8Array.of(0x0a, 0x05, 0x61))).toBeNull();
    expect(protobufFields(Uint8Array.of(0x00))).toBeNull();
    expect(protobufFields(Uint8Array.of(0x0b))).toBeNull();
    // A negative int64 is a ten-byte varint; its value is never used, so the message reads.
    const negative = Uint8Array.of(0x08, ...Array(9).fill(0xff), 0x01);
    expect(protobufFields(negative)).toHaveLength(1);
    // A length of 2^49 would read as 0 if its high bits were dropped, framing garbage.
    const huge = Uint8Array.of(0x0a, ...Array(7).fill(0x80), 0x01);
    expect(protobufFields(huge)).toBeNull();
    expect(
      protobufFields(
        message([
          [1, "a"],
          [2, 5],
        ]),
      ),
    ).toHaveLength(2);
  });

  it("reads the anonymised 1.4.7 fixture without unsupported rows", () => {
    const entries = antigravityEntries(steps(FIXTURE));
    expect(entries.filter((entry) => entry.kind === "unsupported")).toEqual([]);
    expect(entries.some((entry) => entry.kind === "user")).toBe(true);
    expect(entries.some((entry) => entry.kind === "tool-call")).toBe(true);
  });

  it("accepts Herdr's Antigravity session reference and nothing looser", () => {
    expect(
      herdrTranscriptReference({
        agent: "agy",
        kind: "id",
        source: "herdr:antigravity_cli",
        value: ID,
      }),
    ).toEqual({ agent: "agy", kind: "id", value: ID });
    expect(
      herdrTranscriptReference({ agent: "agy", kind: "id", source: "herdr:agy", value: ID }),
    ).toBeNull();
    expect(
      herdrTranscriptReference({
        agent: "agy",
        kind: "path",
        source: "herdr:antigravity_cli",
        value: "/tmp/x.db",
      }),
    ).toBeNull();
  });
});

describe("Antigravity reader", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-agy-")));
    dirs.push(root);
    const path = join(root, `${ID}.db`);
    copyFileSync(FIXTURE, path);
    const identity: TranscriptIdentity = { agent: "agy", path, session: ID, owner: "pane-1" };
    let current: TranscriptIdentity | null = identity;
    const proofs = { count: 0 };
    const reader = new AntigravityReader(
      {
        enabled: () => true,
        identity: async () => {
          proofs.count++;
          return current;
        },
        roots: { claude: [], codex: [], agy: [root] },
      },
      identity,
    );
    return {
      reader,
      path,
      proofs,
      setIdentity: (next: TranscriptIdentity | null) => (current = next),
    };
  }

  it("proves its binding once per read once the database is open", async () => {
    const f = setup();
    const signal = new AbortController().signal;
    await f.reader.read(signal);
    const opened = f.proofs.count;
    for (let i = 0; i < 3; i++) await f.reader.read(signal);
    expect(f.proofs.count - opened).toBe(3);
    const writer = new DatabaseSync(f.path);
    writer
      .prepare("INSERT INTO steps VALUES (?, ?, ?, ?)")
      .run(10_001, ANTIGRAVITY_STEP.user, 3, message([[19, [[2, "More"]]]]));
    writer.close();
    const before = f.proofs.count;
    await f.reader.read(signal);
    expect(f.proofs.count - before).toBe(1);
    f.reader.close();
  });

  it("re-reads a step edited in place even when its size doesn't change", async () => {
    const f = setup();
    const signal = new AbortController().signal;
    const writer = new DatabaseSync(f.path);
    writer
      .prepare("INSERT INTO steps VALUES (?, ?, ?, ?)")
      .run(10_002, ANTIGRAVITY_STEP.user, 3, message([[19, [[2, "first"]]]]));
    await f.reader.read(signal);
    // Same length and the same last 80 characters: only the full content shows the edit.
    const tail = "t".repeat(80);
    writer
      .prepare("UPDATE steps SET step_payload = ? WHERE idx = ?")
      .run(message([[19, [[2, `first${tail}`]]]]), 10_002);
    await f.reader.read(signal);
    writer
      .prepare("UPDATE steps SET step_payload = ? WHERE idx = ?")
      .run(message([[19, [[2, `fixed${tail}`]]]]), 10_002);
    writer.close();
    const next = await f.reader.read(signal);
    if (next.status !== "snapshot") throw new Error(next.status);
    expect(next.snapshot.entries.at(-1)?.text).toBe(`fixed${tail}`);
    expect(next.snapshot.change).toBe("replace");
    f.reader.close();
  });

  it("keeps a conversation within its total size and says older steps aren't loaded", async () => {
    const f = setup();
    const writer = new DatabaseSync(f.path);
    writer.exec("DELETE FROM steps");
    const insert = writer.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
    const big = "y".repeat(900_000);
    for (let i = 0; i < 20; i++)
      insert.run(i, ANTIGRAVITY_STEP.user, 3, message([[19, [[2, `${i}${big}`]]]]));
    writer.close();
    const result = await f.reader.read(new AbortController().signal);
    if (result.status !== "snapshot") throw new Error(result.status);
    expect(result.snapshot.history).toBe("unloaded");
    expect(result.snapshot.entries[0]).toMatchObject({ id: "history:unloaded" });
    const users = result.snapshot.entries.filter((entry) => entry.kind === "user");
    expect(users.length).toBeLessThan(20);
    expect(users.at(-1)?.text.startsWith("19")).toBe(true);
    f.reader.close();
  });

  it("re-reads only after the database changes, and stops when the pane changes", async () => {
    const f = setup();
    const signal = new AbortController().signal;
    const first = await f.reader.read(signal);
    if (first.status !== "snapshot") throw new Error(first.status);
    expect(first.snapshot).toMatchObject({
      state: "ready",
      history: "complete",
      change: "replace",
    });
    const idle = await f.reader.read(signal);
    expect(idle).toMatchObject({ snapshot: { change: "unchanged", revision: 1 } });
    expect(await f.reader.changed(signal)).toBe(false);
    const writer = new DatabaseSync(f.path);
    writer
      .prepare("INSERT INTO steps VALUES (?, ?, ?, ?)")
      .run(10_000, ANTIGRAVITY_STEP.user, 3, message([[19, [[2, "Hello again"]]]]));
    writer.close();
    expect(await f.reader.changed(signal)).toBe(true);
    const next = await f.reader.read(signal);
    expect(next).toMatchObject({ snapshot: { change: "replace", revision: 2 } });
    if (next.status === "snapshot") expect(next.snapshot.entries.at(-1)?.text).toBe("Hello again");
    f.setIdentity({ agent: "agy", path: f.path, session: ID, owner: "pane-2" });
    expect(await f.reader.read(signal)).toEqual({ status: "stopped", reason: "changed" });
    f.reader.close();
  });

  it("refuses a database outside the Antigravity root", async () => {
    const f = setup();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-other-")));
    dirs.push(outside);
    const reader = new AntigravityReader(
      {
        enabled: () => true,
        identity: async () => ({ agent: "agy", path: f.path, session: ID, owner: "pane-1" }),
        roots: { claude: [], codex: [], agy: [outside] },
      },
      { agent: "agy", path: f.path, session: ID, owner: "pane-1" },
    );
    expect(await reader.read(new AbortController().signal)).toEqual({
      status: "stopped",
      reason: "unsafe",
    });
  });
});
