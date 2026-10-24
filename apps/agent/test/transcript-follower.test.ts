import * as fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PAIRINGS } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPageAnchor } from "../src/conversation/transcript-document.js";
import { TranscriptDocument } from "../src/conversation/transcript-document.js";
import {
  type TranscriptAgent,
  TranscriptFile,
  type TranscriptIdentity,
} from "../src/conversation/transcript-file.js";
import {
  TRANSCRIPT_FOLLOW_MS,
  TRANSCRIPT_REACH_BYTES,
  TRANSCRIPT_WINDOW_BYTES,
  type TranscriptFollower,
  TranscriptFollowers,
  type TranscriptPoll,
} from "../src/conversation/transcript-follower.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});
const session = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const temporary: string[] = [];
const followers: TranscriptFollower[] = [];
const pools: TranscriptFollowers[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.realpath).mockReset();
  for (const pool of pools.splice(0)) pool.close();
  await Promise.all(followers.splice(0).map((follower) => follower.drained));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function message(uuid: string, parentUuid: string | null, text: string, role = "user") {
  return { type: role, uuid, parentUuid, sessionId: session, message: { role, content: text } };
}
const header = { type: "session_meta", payload: { id: session } };
function encode(...records: object[]) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}
async function fixture(
  text = encode(message("root", null, "Question")),
  agent: TranscriptAgent = "claude",
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-follower-")));
  temporary.push(dir);
  const claude = join(dir, "claude"),
    codex = join(dir, "codex");
  await Promise.all([mkdir(claude), mkdir(codex)]);
  const path = join(agent === "claude" ? claude : codex, `${session}.jsonl`);
  await writeFile(path, text);
  const reference: TranscriptIdentity = { agent, path, session, owner: "pane-generation-1" };
  let current: TranscriptIdentity | null = reference;
  let enabled = true;
  const identity = vi.fn(async (_signal: AbortSignal) => current);
  const controller = new AbortController();
  const options = {
    roots: { claude: [claude], codex: [codex] },
    identity,
    enabled: () => enabled,
    signal: controller.signal,
  };
  const pool = new TranscriptFollowers();
  pools.push(pool);
  const create = () => {
    const follower = pool.create(options);
    if (follower) followers.push(follower);
    return follower;
  };
  return {
    dir,
    path,
    reference,
    options,
    identity,
    controller,
    pool,
    create,
    get enabled() {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    get current() {
      return current;
    },
    set current(value: TranscriptIdentity | null) {
      current = value;
    },
  };
}
async function snapshot(follower: TranscriptFollower) {
  for (let i = 0; i < 500; i++) {
    const result = await follower.poll();
    if (result.status === "snapshot") return result;
    expect(result.status).toBe("catching-up");
  }
  throw new Error("Synthetic transcript did not reach a snapshot within bounded polls");
}

async function older(follower: TranscriptFollower, anchor: Readonly<TranscriptPageAnchor>) {
  for (let i = 0; i < 100; i++) {
    const result = await follower.older!(anchor);
    if (result.status !== "reading") return result;
  }
  throw new Error("Synthetic older window did not finish within bounded steps");
}

describe("proven transcript file following", () => {
  it("requires parsing new appends before using an older-page capability", async () => {
    const f = await fixture(encode(message("root", null, "Root"), message("last", "root", "Last")));
    const follower = f.create()!;
    const live = await snapshot(follower);
    const anchor = follower.anchor!(live.snapshot.revision, live.snapshot.entries.at(-1)!.id)!;
    await appendFile(f.path, encode(message("current", "last", "Current")));
    expect(await follower.older!(anchor)).toEqual({ status: "refresh" });
    await snapshot(follower);
    expect(await older(follower, anchor)).toMatchObject({
      status: "page",
      entries: [{ entry: { text: "Root" } }],
    });
  });

  it("keeps an explicit unlinked boundary while removing the synthetic notice from older rows", async () => {
    const f = await fixture(
      encode(
        message("root", null, "Root"),
        {
          ...message("side", "missing", "Unlinked side", "assistant"),
          isSidechain: true,
          agentId: "worker",
        },
        message("last", "root", "Last"),
      ),
    );
    const follower = f.create()!;
    const live = await snapshot(follower);
    expect(live.snapshot.entries[0]?.id).toBe("unlinked-side");
    const anchor = follower.anchor!(live.snapshot.revision, live.snapshot.entries.at(-1)!.id)!;
    const page = await older(follower, anchor);
    expect(page).toMatchObject({
      status: "page",
      history: "unlinked",
      more: false,
      entries: [{ entry: { text: "Root" } }],
    });
    if (page.status === "page")
      expect(page.entries.map((item) => item.entry.text)).toEqual(["Root"]);
  });

  it("reports a branch gap beyond the bounded older window without joining an unrelated leaf", async () => {
    const f = await fixture(
      encode(
        message("root", null, "Root"),
        message("unrelated", "root", "Wrong branch"),
        ...Array.from({ length: 4000 }, () => ({ type: "progress", padding: "x".repeat(128) })),
        message("current", "root", "Current"),
      ),
    );
    const follower = f.create()!;
    const live = await snapshot(follower);
    const entry = live.snapshot.entries.find((value) => value.text === "Current")!;
    const anchor = follower.anchor!(live.snapshot.revision, entry.id)!;
    expect(await older(follower, anchor)).toEqual({ status: "unavailable" });
    expect(await follower.confirm(live.snapshot.revision)).toMatchObject({ status: "confirmed" });
  });

  it("cancels a pending physical page on opt-out and drains the owned work", async () => {
    const f = await fixture(encode(message("root", null, "Root"), message("last", "root", "Last")));
    const follower = f.create()!;
    const live = await snapshot(follower);
    const anchor = follower.anchor!(live.snapshot.revision, live.snapshot.entries[1]!.id)!;
    const proof = deferred<TranscriptIdentity | null>();
    f.identity.mockImplementationOnce(() => proof.promise);
    const calls = f.identity.mock.calls.length;
    const pending = follower.older!(anchor);
    await vi.waitFor(() => expect(f.identity.mock.calls.length).toBeGreaterThan(calls));
    f.enabled = false;
    follower.close();
    expect(await pending).toEqual({ status: "stopped", reason: "cancelled" });
    proof.resolve(f.reference);
    await follower.drained;
    expect(f.pool.active).toBe(0);
    expect(await follower.older!(anchor)).toEqual({ status: "stopped", reason: "cancelled" });
  });

  it.each(["claude", "codex"] as const)(
    "pages %s before the retained window using the same descriptor",
    async (agent) => {
      const texts = Array.from({ length: 300 }, (_, i) => `${i}: ${"x".repeat(1200)}`);
      const values = texts.map((text, i) =>
        agent === "claude"
          ? message(`row-${i}`, i ? `row-${i - 1}` : null, text)
          : { type: "event_msg", payload: { type: "user_message", message: text } },
      );
      const f = await fixture(encode(...(agent === "codex" ? [header] : []), ...values), agent);
      const follower = f.create()!;
      const live = await snapshot(follower);
      let entries = live.snapshot.entries.filter((entry) => !entry.id.startsWith("history:"));
      expect(entries.length).toBeLessThan(texts.length);
      let anchor = follower.anchor!(live.snapshot.revision, entries[0]!.id)!;
      let complete = false;
      const opens = vi.mocked(fs.open).mock.calls.length;
      for (let i = 0; i < 30; i++) {
        const result = await older(follower, anchor);
        expect(result.status).toBe("page");
        if (result.status !== "page") throw new Error(result.status);
        expect(result.entries.length).toBeLessThanOrEqual(64);
        entries = [...result.entries.map((item) => item.entry), ...entries];
        if (result.history === "complete") {
          complete = true;
          break;
        }
        expect(result.entries[0]?.anchor).toBeTruthy();
        anchor = result.entries[0]!.anchor!;
      }
      expect(complete).toBe(true);
      expect(entries.map((entry) => entry.text)).toEqual(texts);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
      expect(vi.mocked(fs.open).mock.calls.length).toBe(opens);
      expect(await follower.confirm(live.snapshot.revision)).toEqual({
        status: "confirmed",
        caughtUp: true,
      });
    },
  );

  it("rejects copied anchors and capabilities issued by another follower", async () => {
    const f = await fixture(encode(message("root", null, "Root"), message("last", "root", "Last")));
    const one = f.create()!,
      two = f.create()!;
    const first = await snapshot(one);
    await snapshot(two);
    const anchor = one.anchor!(first.snapshot.revision, first.snapshot.entries[1]!.id)!;
    expect(await one.older!({ ...anchor })).toEqual({ status: "unavailable" });
    expect(await two.older!(anchor)).toEqual({ status: "unavailable" });
    expect(await older(one, anchor)).toMatchObject({
      status: "page",
      entries: [{ entry: { text: "Root" } }],
    });
  });

  it("rejects an old revision while newer records are still being processed", async () => {
    const f = await fixture();
    const follower = f.create()!;
    const before = await snapshot(follower);
    await appendFile(
      f.path,
      encode({ type: "progress" }).repeat(1000) +
        encode(message("answer", "root", "Answer", "assistant")),
    );
    expect(await follower.poll()).toMatchObject({ status: "catching-up" });
    expect(await follower.confirm(before.snapshot.revision)).toEqual({ status: "changed" });
    const after = await snapshot(follower);
    expect(after.snapshot.entries.at(-1)?.text).toBe("Answer");
    expect(await follower.confirm(after.snapshot.revision)).toEqual({
      status: "confirmed",
      caughtUp: true,
    });
  });
  it("publishes captured prefixes while a writer appends during every native proof", async () => {
    const f = await fixture();
    let written = 0;
    f.identity.mockImplementation(async () => {
      const previous = written ? `answer-${written}` : "root";
      written++;
      await appendFile(
        f.path,
        encode(message(`answer-${written}`, previous, `Answer ${written}`, "assistant")),
      );
      return f.reference;
    });
    const follower = f.create()!;
    let seen = 0;
    for (let i = 0; i < 5; i++) {
      const result = await snapshot(follower);
      const latest = Number(result.snapshot.entries.at(-1)!.text.split(" ").at(-1));
      expect(latest).toBeGreaterThan(seen);
      expect(latest).toBeLessThan(written);
      expect(result.caughtUp).toBe(false);
      expect(await follower.confirm(result.snapshot.revision)).toEqual({
        status: "confirmed",
        caughtUp: false,
      });
      seen = latest;
    }
  });
  it("projects a Claude conversation, follows append and replaces an abandoned branch", async () => {
    const f = await fixture(
      encode(message("root", null, "Question"), message("answer", "root", "Answer", "assistant")),
    );
    const follower = f.create()!;
    const first = await snapshot(follower);
    expect(first.snapshot).toMatchObject({
      state: "ready",
      history: "complete",
      change: "replace",
    });
    expect(first.snapshot.entries.map((entry) => entry.text)).toEqual(["Question", "Answer"]);
    expect(await follower.confirm(first.snapshot.revision)).toEqual({
      status: "confirmed",
      caughtUp: true,
    });
    await appendFile(f.path, encode(message("next", "answer", "Next")));
    expect(await follower.confirm(first.snapshot.revision)).toEqual({
      status: "confirmed",
      caughtUp: false,
    });
    const next = await snapshot(follower);
    expect(next.snapshot.change).toBe("append");
    expect(next.snapshot.entries.at(-1)!.text).toBe("Next");
    await appendFile(f.path, encode(message("replacement", "root", "New answer", "assistant")));
    const replacement = await snapshot(follower);
    expect(replacement.snapshot.change).toBe("replace");
    expect(replacement.snapshot.entries.map((entry) => entry.text)).toEqual([
      "Question",
      "New answer",
    ]);
    expect(await follower.confirm(first.snapshot.revision)).toEqual({ status: "changed" });
  });

  it("waits for a partial final JSONL record and never publishes half-written content", async () => {
    const f = await fixture();
    const follower = f.create()!;
    const first = await snapshot(follower);
    const next = encode(message("answer", "root", "Complete answer", "assistant"));
    await appendFile(f.path, next.slice(0, -2));
    const partial = await snapshot(follower);
    expect(partial.snapshot.entries).toEqual(first.snapshot.entries);
    expect(partial.snapshot.change).toBe("unchanged");
    await appendFile(f.path, next.slice(-2));
    expect((await snapshot(follower)).snapshot.entries.at(-1)?.text).toBe("Complete answer");
  });

  it("keeps a mismatched Claude tail unbound until a matching current writer appears", async () => {
    const f = await fixture(
      encode({ ...message("inherited", null, "Inherited"), sessionId: other }),
    );
    const follower = f.create()!;
    expect((await snapshot(follower)).snapshot).toMatchObject({ state: "unbound", entries: [] });
    await appendFile(f.path, encode(message("current", "inherited", "Current")));
    expect((await snapshot(follower)).snapshot.entries.map((entry) => entry.text)).toEqual([
      "Inherited",
      "Current",
    ]);
  });

  it("projects only allowlisted Codex display records after canonical header proof", async () => {
    const f = await fixture(
      encode(
        header,
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "PRIVATE CONTEXT" }],
          },
        },
        { type: "event_msg", payload: { type: "user_message", message: "Question" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Answer" }],
          },
        },
      ),
      "codex",
    );
    const result = await snapshot(f.create()!);
    expect(result.snapshot).toMatchObject({
      state: "ready",
      history: "complete",
      change: "replace",
    });
    expect(result.snapshot.entries.map((entry) => entry.text)).toEqual(["Question", "Answer"]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|11111111|\.jsonl|pane-generation/);
  });

  it.each([
    [{ type: "session_meta", payload: { id: other } }, "unbound"],
    [
      {
        type: "session_meta",
        payload: { id: session, history_mode: "paginated", history_base: { ordinal: 1 } },
      },
      "unsupported",
    ],
    [
      { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
      "unsupported",
    ],
  ] as const)("rejects an unproven canonical Codex header: %j", async (value, reason) => {
    const f = await fixture(encode(value, header), "codex");
    const follower = f.create()!;
    expect(await follower.poll()).toEqual({ status: "stopped", reason });
    await follower.drained;
    expect(f.pool.active).toBe(0);
  });

  it("waits for a newly created Codex file's incomplete header", async () => {
    const text = encode(header);
    const f = await fixture(text.slice(0, -2), "codex");
    const follower = f.create()!;
    expect(await follower.poll()).toMatchObject({ status: "catching-up" });
    await appendFile(f.path, text.slice(-2));
    expect((await snapshot(follower)).snapshot.state).toBe("ready");
  });

  it("stops on a rollback rather than deliver a previously accepted Codex projection", async () => {
    const f = await fixture(
      encode(header, {
        type: "event_msg",
        payload: { type: "user_message", message: "Old question" },
      }),
      "codex",
    );
    const follower = f.create()!;
    const previous = await snapshot(follower);
    await appendFile(
      f.path,
      encode({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
    );
    expect(await follower.poll()).toEqual({ status: "stopped", reason: "unsupported" });
    expect(await follower.confirm(previous.snapshot.revision)).toEqual({
      status: "stopped",
      reason: "unsupported",
    });
  });

  it.each(["identity", "owner", "unbound", "truncate", "replace"])(
    "ends a generation on %s changes",
    async (change) => {
      const f = await fixture();
      const follower = f.create()!;
      const previous = await snapshot(follower);
      if (change === "identity") f.current = { ...f.reference, session: other };
      if (change === "owner") f.current = { ...f.reference, owner: "new-pane-generation" };
      if (change === "unbound") f.current = null;
      if (change === "truncate") await writeFile(f.path, "");
      if (change === "replace") {
        await rename(f.path, `${f.path}.old`);
        await writeFile(f.path, encode(message("replacement", null, "PRIVATE")));
      }
      const expected = { status: "stopped", reason: change === "unbound" ? "unbound" : "changed" };
      expect(await follower.confirm(previous.snapshot.revision)).toEqual(expected);
      f.current = f.reference;
      expect(await follower.poll()).toEqual(expected);
      await follower.drained;
      expect(f.pool.active).toBe(0);
    },
  );
});

describe("bounded newest windows and following work", () => {
  it("catches up through a fixed initial extent despite continuing appends between reads", async () => {
    const padding = encode({ type: "progress", padding: "x".repeat(1000) }).repeat(200);
    const f = await fixture(padding + encode(message("root", null, "Question")));
    const follower = f.create()!;
    let writes = 0;
    f.identity.mockImplementation(async () => {
      writes++;
      await appendFile(f.path, encode({ type: "progress", padding: "new".repeat(1000) }));
      return f.reference;
    });
    const result = await snapshot(follower);
    expect(result.snapshot.entries.at(-1)?.text).toBe("Question");
    expect(result.caughtUp).toBe(false);
    expect(result.discontinuity).toBe(0);
    expect(writes).toBeGreaterThan(5);
  });

  it.each(["claude", "codex"] as const)(
    "signals a %s discontinuity when reusing retained raw bytes",
    async (agent) => {
      const first = agent === "codex" ? encode(header) : "";
      const padding = encode({ type: agent === "codex" ? "turn_context" : "progress" }).repeat(
        3000,
      );
      const latest =
        agent === "codex"
          ? { type: "event_msg", payload: { type: "user_message", message: "Newest" } }
          : message("latest", null, "Newest");
      const f = await fixture(first + padding, agent);
      const follower = f.create()!;
      expect(await follower.poll()).toMatchObject({ status: "catching-up", discontinuity: 0 });
      await appendFile(
        f.path,
        encode({
          type: agent === "codex" ? "turn_context" : "progress",
          padding: "x".repeat(1000),
        }).repeat(4400) + encode(latest),
      );
      expect(await follower.poll()).toEqual({ status: "catching-up", discontinuity: 1 });
      const result = await snapshot(follower);
      expect(result.snapshot.state).toBe("ready");
      expect(result.snapshot.entries.at(-1)?.text).toBe("Newest");
      expect(result.discontinuity).toBe(1);
    },
  );
  it.each(["claude", "codex"] as const)(
    "starts with a bounded newest %s window and labels unloaded history",
    async (agent) => {
      const padding = encode({
        type: agent === "claude" ? "progress" : "turn_context",
        padding: "x".repeat(1000),
      }).repeat(600);
      const last =
        agent === "claude"
          ? message("newest", null, "Newest")
          : { type: "event_msg", payload: { type: "user_message", message: "Newest" } };
      const text = (agent === "codex" ? encode(header) : "") + padding + encode(last);
      const f = await fixture(text, agent);
      const reads = vi.spyOn(TranscriptFile.prototype, "read");
      const result = await snapshot(f.create()!);
      expect(result.snapshot.history).toBe("unloaded");
      expect(result.snapshot.entries.at(-1)?.text).toBe("Newest");
      const offsets = reads.mock.calls.map(([offset]) => offset);
      if (agent === "codex") expect(offsets.shift()).toBe(0);
      expect(offsets[0]).toBe(Buffer.byteLength(text) - TRANSCRIPT_WINDOW_BYTES);
      expect(Math.min(...offsets)).toBeGreaterThan(0);
      expect(result.discontinuity).toBe(0);
    },
  );

  it("reads further back when an oversized image leaves the newest window without a message", async () => {
    const image = {
      ...message("image", "root", ""),
      message: {
        role: "user",
        content: [{ type: "tool_result", content: [{ type: "image", data: "x".repeat(600_000) }] }],
      },
    };
    const f = await fixture(
      encode(message("root", null, "Question"), image, { type: "last-prompt", padding: "y" }),
    );
    const result = await snapshot(f.create()!);
    expect(result.snapshot.state).toBe("ready");
    expect(result.snapshot.entries.map((entry) => entry.text)).toContain("Question");
    expect(result.discontinuity).toBe(0);
  });

  it("pages back through screenshots that fill whole windows", async () => {
    // Each turn: thinking, text, a screenshot read whose result is one huge line, then a reply
    // split over more records. A 256 KiB window ends up holding only the end of a reply.
    const records: object[] = [message("root", null, "Question")];
    let parent = "root";
    for (let i = 0; i < 8; i++) {
      const reply = (uuid: string, content: object[], response = `r${i}`) => {
        records.push({
          type: "assistant",
          uuid,
          parentUuid: parent,
          sessionId: session,
          message: { role: "assistant", id: response, content },
        });
        parent = uuid;
      };
      reply(`think-${i}`, [{ type: "thinking", thinking: "" }]);
      reply(`text-${i}`, [{ type: "text", text: `Looking ${i}` }]);
      reply(`call-${i}`, [
        { type: "tool_use", id: `shot-${i}`, name: "Read", input: { file_path: `s${i}.png` } },
      ]);
      records.push({
        type: "user",
        uuid: `result-${i}`,
        parentUuid: parent,
        sessionId: session,
        sourceToolAssistantUUID: `call-${i}`,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `shot-${i}`,
              content: [{ type: "image", source: { type: "base64", data: "A".repeat(400_000) } }],
            },
          ],
        },
      });
      parent = `result-${i}`;
      records.push({
        type: "attachment",
        uuid: `queued-${i}`,
        parentUuid: parent,
        sessionId: session,
        attachment: { type: "queued_command" },
      });
      parent = `queued-${i}`;
      reply(`after-think-${i}`, [{ type: "thinking", thinking: "" }], `s${i}`);
      reply(`after-${i}`, [{ type: "text", text: `Saw ${i}` }], `s${i}`);
    }
    const f = await fixture(encode(...records));
    const follower = f.create()!;
    const live = await snapshot(follower);
    const rows = live.snapshot.entries.filter((entry) => !entry.id.startsWith("history:"));
    let anchor = follower.anchor!(live.snapshot.revision, rows[0]!.id);
    expect(anchor).not.toBeNull();
    const texts = rows.map((entry) => entry.text);
    for (let pages = 0; anchor && pages < 50; pages++) {
      const page = await older(follower, anchor);
      if (page.status !== "page") throw new Error(`Older page failed: ${page.status}`);
      texts.unshift(...page.entries.map((item) => item.entry.text));
      if (!page.more) break;
      anchor = page.entries[0]!.anchor;
    }
    expect(texts[0]).toBe("Question");
    expect(texts.filter((text) => text.startsWith("Saw"))).toEqual(
      Array.from({ length: 8 }, (_, i) => `Saw ${i}`),
    );
  });

  it("pages back to the prompt when the newest window holds only tool steps", async () => {
    const records: object[] = [message("root", null, "Question")];
    let parent = "root";
    for (let i = 0; i < 300; i++) {
      const call = `call-${i}`;
      records.push(
        {
          type: "assistant",
          uuid: call,
          parentUuid: parent,
          sessionId: session,
          message: {
            role: "assistant",
            id: `response-${i}`,
            content: [
              // A reply with text and a call puts two rows in one record, so pages can't
              // simply alternate calls and results.
              ...(i % 5 ? [] : [{ type: "text", text: `Checking ${i}` }]),
              { type: "tool_use", id: `tool-${i}`, name: "Bash", input: { command: `step ${i}` } },
            ],
          },
        },
        {
          type: "user",
          uuid: `result-${i}`,
          parentUuid: call,
          sessionId: session,
          message: {
            role: "user",
            content: [
              // Mixed sizes move page edges onto results as well as calls.
              { type: "tool_result", tool_use_id: `tool-${i}`, content: "x".repeat((i % 7) * 900) },
            ],
          },
        },
      );
      parent = `result-${i}`;
    }
    const f = await fixture(encode(...records));
    expect((await fs.stat(f.path)).size).toBeGreaterThan(2 * TRANSCRIPT_WINDOW_BYTES);
    const follower = f.create()!;
    const live = await snapshot(follower);
    const [notice, first] = live.snapshot.entries;
    expect(notice).toMatchObject({ kind: "status", text: "Earlier conversation is not loaded." });
    expect(first?.text).toMatch(/^(Bash · step|Checking) \d+$/);
    let anchor = follower.anchor!(live.snapshot.revision, first!.id);
    expect(anchor).not.toBeNull();
    const texts = live.snapshot.entries.slice(1).map((entry) => entry.text);
    for (let pages = 0; anchor && pages < 100; pages++) {
      const page = await older(follower, anchor);
      if (page.status !== "page") throw new Error(`Older page failed: ${page.status}`);
      texts.unshift(...page.entries.map((item) => item.entry.text));
      if (!page.more) break;
      anchor = page.entries[0]!.anchor;
      expect(anchor).not.toBeNull();
    }
    expect(texts[0]).toBe("Question");
    expect(texts.filter((text) => text.startsWith("Bash"))).toEqual(
      Array.from({ length: 300 }, (_, i) => `Bash · step ${i}`),
    );
    expect(texts.filter((text) => text === "Tool result")).toHaveLength(300);
    expect(texts.filter((text) => text.startsWith("Checking"))).toHaveLength(60);
  });

  it("stays bounded when no message exists within the widest reach", async () => {
    const f = await fixture(
      encode(message("root", null, "Question")) +
        encode({ type: "progress", padding: "x".repeat(100_000) }).repeat(
          Math.ceil(TRANSCRIPT_REACH_BYTES / 100_000) + 1,
        ),
    );
    const reads = vi.spyOn(TranscriptFile.prototype, "read");
    const result = await snapshot(f.create()!);
    expect(result.snapshot.state).toBe("unbound");
    const size = (await fs.stat(f.path)).size;
    expect(Math.min(...reads.mock.calls.map(([offset]) => offset))).toBe(
      size - TRANSCRIPT_REACH_BYTES,
    );
  });

  it("reads through a burst bigger than its window instead of skipping it", async () => {
    const f = await fixture();
    const follower = f.create()!;
    await snapshot(follower);
    // One large tool output and a reply, written at once: far more than one 64 KiB read.
    await appendFile(
      f.path,
      encode({ type: "progress", padding: "x".repeat(1000) }).repeat(600) +
        encode(message("newest", "root", "Newest")),
    );
    const result = await snapshot(follower);
    expect(result.discontinuity).toBe(0);
    expect(result.snapshot.entries.map((entry) => entry.text)).toEqual(["Question", "Newest"]);
  });

  it("reports a discontinuity before jumping past backlog and replacing the projection", async () => {
    const f = await fixture();
    const follower = f.create()!;
    await snapshot(follower);
    await appendFile(
      f.path,
      encode({ type: "progress", padding: "x".repeat(1000) }).repeat(4400) +
        encode(message("newest", "root", "Newest")),
    );
    expect(await follower.poll()).toEqual({ status: "catching-up", discontinuity: 1 });
    const result = await snapshot(follower);
    expect(result).toMatchObject({
      discontinuity: 1,
      snapshot: { change: "replace", history: "unloaded" },
    });
    expect(result.snapshot.entries.at(-1)?.text).toBe("Newest");
    expect((await snapshot(follower)).discontinuity).toBe(1);
  });

  it("bounds work per poll and wipes retained read bytes on close", async () => {
    const f = await fixture(
      encode({ type: "progress" }).repeat(3000) + encode(message("root", null, "Newest")),
    );
    const original = TranscriptFile.prototype.read;
    const buffers: Uint8Array[] = [];
    const reads = vi.spyOn(TranscriptFile.prototype, "read").mockImplementation(async function (
      this: TranscriptFile,
      ...args
    ) {
      const result = await original.apply(this, args);
      if (result.status === "data") buffers.push(result.bytes);
      return result;
    });
    const follower = f.create()!;
    expect(await follower.poll()).toMatchObject({ status: "catching-up" });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(buffers[0]?.some((byte) => byte !== 0)).toBe(true);
    const calls = f.identity.mock.calls.length;
    expect(await follower.poll()).toMatchObject({ status: "catching-up" });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.identity.mock.calls.length).toBeGreaterThan(calls);
    follower.close();
    expect(buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    await follower.drained;
    expect(f.pool.active).toBe(0);
  });

  it("rejects an oversized unfinished Codex header without scanning the whole file", async () => {
    const f = await fixture("x".repeat(2 * TRANSCRIPT_WINDOW_BYTES), "codex");
    const reads = vi.spyOn(TranscriptFile.prototype, "read");
    const follower = f.create()!;
    let result: TranscriptPoll = await follower.poll();
    for (let i = 0; i < 3 && result.status === "catching-up"; i++) result = await follower.poll();
    expect(result).toEqual({ status: "stopped", reason: "unsupported" });
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("consent, cancellation and bounded resource admission", () => {
  it("supports prototype-defined identity and consent methods with their original receiver", async () => {
    const f = await fixture();
    class Configuration {
      roots = f.options.roots;
      allowed = true;
      reference = f.reference;
      enabled() {
        return this.allowed;
      }
      async identity(_signal: AbortSignal) {
        return this.reference;
      }
    }
    const configuration = new Configuration();
    const follower = f.pool.create(configuration)!;
    followers.push(follower);
    expect((await snapshot(follower)).snapshot.state).toBe("ready");
    configuration.allowed = false;
    expect(await follower.poll()).toEqual({ status: "stopped", reason: "disabled" });
  });

  it("keeps a timed-out confirmation admitted until its actual verification settles", async () => {
    const f = await fixture();
    const follower = f.create()!;
    const previous = await snapshot(follower);
    const entered = deferred(),
      release = deferred();
    const original = TranscriptFile.prototype.verify;
    vi.spyOn(TranscriptFile.prototype, "verify").mockImplementationOnce(async function (
      this: TranscriptFile,
    ) {
      entered.resolve();
      await release.promise;
      return original.call(this);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = follower.confirm(previous.snapshot.revision);
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_FOLLOW_MS);
      expect(await pending).toEqual({ status: "stopped", reason: "timeout" });
      expect(f.pool.busy).toBe(true);
      expect(f.pool.active).toBe(1);
    } finally {
      release.resolve();
    }
    await follower.drained;
    expect(f.pool.active).toBe(0);
  });
  it("owns a bounded root list without invoking a caller-supplied iterator", async () => {
    const f = await fixture();
    f.options.roots.claude[Symbol.iterator] = () => {
      throw new Error("PRIVATE iterator");
    };
    const follower = f.create()!;
    f.options.roots.claude[0] = "/unrelated-root";
    expect((await snapshot(follower)).snapshot.state).toBe("ready");
    f.options.roots.codex = Array(9).fill(f.dir);
    expect(f.create()).toBeNull();
    expect(f.pool.active).toBe(1);
  });
  it("reserves capacity before reading caller-owned configuration getters", async () => {
    const f = await fixture();
    const roots = [...f.options.roots.claude];
    let entered = false;
    Object.defineProperty(f.options.roots, "claude", {
      get: () => {
        if (!entered) {
          entered = true;
          for (let i = 0; i < MAX_PAIRINGS; i++) f.create();
        }
        return roots;
      },
    });
    expect(f.create()).not.toBeNull();
    expect(f.pool.active).toBe(MAX_PAIRINGS);
    expect(f.create()).toBeNull();
    f.pool.close();
    expect(f.pool.active).toBe(0);
  });

  it("does not admit a source if configuration access closes the pool or throws", async () => {
    const f = await fixture();
    const roots = [...f.options.roots.claude];
    Object.defineProperty(f.options.roots, "claude", {
      get: () => {
        f.pool.close();
        return roots;
      },
    });
    expect(f.create()).toBeNull();
    expect(f.pool.active).toBe(0);
    const other = await fixture();
    Object.defineProperty(other.options.roots, "claude", {
      get: () => {
        throw new Error("PRIVATE config path");
      },
    });
    expect(other.create()).toBeNull();
    expect(other.pool.active).toBe(0);
  });
  it.each(["disabled", "aborted"])("does no file work for an initially %s view", async (why) => {
    const f = await fixture();
    if (why === "disabled") f.enabled = false;
    else f.controller.abort();
    const follower = f.create()!;
    expect(await follower.poll()).toEqual({
      status: "stopped",
      reason: why === "disabled" ? "disabled" : "cancelled",
    });
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.pool.active).toBe(0);
    await follower.drained;
  });

  it("rechecks consent after producing a projection and never revives after re-enable", async () => {
    const f = await fixture();
    const original = TranscriptDocument.prototype.snapshot;
    vi.spyOn(TranscriptDocument.prototype, "snapshot").mockImplementation(function (
      this: TranscriptDocument,
    ) {
      const result = original.call(this);
      f.enabled = false;
      return result;
    });
    const follower = f.create()!;
    expect(await follower.poll()).toEqual({ status: "stopped", reason: "disabled" });
    f.enabled = true;
    expect(await follower.poll()).toEqual({ status: "stopped", reason: "disabled" });
  });

  it("serializes readers sharing a pool without invalidating a busy reader", async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    const original = TranscriptFile.prototype.read;
    vi.spyOn(TranscriptFile.prototype, "read").mockImplementationOnce(async function (
      this: TranscriptFile,
      ...args
    ) {
      entered.resolve();
      await release.promise;
      return original.apply(this, args);
    });
    const first = f.create()!,
      second = f.create()!;
    const pending = first.poll();
    await entered.promise;
    try {
      expect(await first.poll()).toEqual({ status: "busy" });
      expect(await second.poll()).toEqual({ status: "busy" });
      expect(f.pool.busy).toBe(true);
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe("snapshot");
    expect((await snapshot(second)).snapshot.state).toBe("ready");
  });

  it("retains admission for a cancelled stalled read until its actual operation settles", async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    vi.spyOn(TranscriptFile.prototype, "read").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { status: "stopped", reason: "cancelled" };
    });
    const first = f.create()!;
    const pending = first.poll();
    await entered.promise;
    let drained = false;
    void first.drained.then(() => {
      drained = true;
    });
    try {
      first.close();
      expect(await pending).toEqual({ status: "stopped", reason: "cancelled" });
      for (let i = 1; i < MAX_PAIRINGS; i++) expect(f.create()).not.toBeNull();
      expect(f.create()).toBeNull();
      expect(f.pool.active).toBe(MAX_PAIRINGS);
      expect(f.pool.busy).toBe(true);
      expect(drained).toBe(false);
    } finally {
      release.resolve();
    }
    await first.drained;
    expect(f.pool.active).toBe(MAX_PAIRINGS - 1);
    expect(f.pool.busy).toBe(false);
    expect(f.create()).not.toBeNull();
  });

  it.each(["cancel", "timeout"])(
    "holds a pending open across %s and closes a late descriptor",
    async (why) => {
      const f = await fixture();
      const opened = await TranscriptFile.open(f.options);
      expect(opened.status).toBe("open");
      if (opened.status !== "open") return;
      const entered = deferred(),
        release = deferred();
      vi.spyOn(TranscriptFile, "open").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return opened;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const follower = f.create()!;
      const pending = follower.poll();
      await entered.promise;
      try {
        if (why === "cancel") f.controller.abort();
        else await vi.advanceTimersByTimeAsync(TRANSCRIPT_FOLLOW_MS);
        expect(await pending).toEqual({
          status: "stopped",
          reason: why === "cancel" ? "cancelled" : "timeout",
        });
        expect(f.pool.busy).toBe(true);
        expect(f.pool.active).toBe(1);
      } finally {
        release.resolve();
      }
      await follower.drained;
      await opened.file.closed;
      expect(opened.file.stopped).toBe("cancelled");
      expect(f.pool.active).toBe(0);
      expect(f.pool.busy).toBe(false);
    },
  );

  it("keeps a closing descriptor admitted even after the read operation finished", async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    const { open: original } = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        entered.resolve();
        await release.promise;
        await close();
      };
      return handle;
    });
    const follower = f.create()!;
    await snapshot(follower);
    follower.close();
    await entered.promise;
    try {
      expect(f.pool.active).toBe(1);
      expect(f.pool.busy).toBe(false);
      expect(await follower.poll()).toEqual({ status: "stopped", reason: "cancelled" });
    } finally {
      release.resolve();
    }
    await follower.drained;
    expect(f.pool.active).toBe(0);
  });

  it.each([false, true])(
    "holds a failed descriptor close until actual closure (opening failure: %s)",
    async (openingFailure) => {
      const f = await fixture();
      const attempted = deferred();
      let close!: () => Promise<void>;
      const { open: original } = await vi.importActual<typeof fs>("node:fs/promises");
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await original(...args);
        close = handle.close.bind(handle);
        if (openingFailure) {
          const stat = handle.stat.bind(handle);
          handle.stat = (async () => {
            const value = await stat();
            value.isFile = () => false;
            return value;
          }) as typeof handle.stat;
        }
        handle.close = async () => {
          attempted.resolve();
          throw new Error("PRIVATE close failure");
        };
        return handle;
      });
      const follower = f.create()!;
      let pending: Promise<TranscriptPoll>;
      if (openingFailure) pending = follower.poll();
      else {
        await snapshot(follower);
        follower.close();
        pending = follower.poll();
      }
      await attempted.promise;
      try {
        expect(f.pool.active).toBe(1);
        if (openingFailure) follower.close();
        expect(await pending).toEqual({ status: "stopped", reason: "cancelled" });
        expect(f.pool.active).toBe(1);
      } finally {
        await close();
      }
      await follower.drained;
      expect(f.pool.active).toBe(0);
      expect(f.pool.busy).toBe(false);
    },
  );

  it("retains file cleanup while a cancelled native-file verification is still pending", async () => {
    const f = await fixture();
    const follower = f.create()!;
    const previous = await snapshot(follower);
    const entered = deferred(),
      release = deferred();
    const { realpath: original } = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.realpath).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const pending = follower.confirm(previous.snapshot.revision);
    await entered.promise;
    try {
      follower.close();
      expect(await pending).toEqual({ status: "stopped", reason: "cancelled" });
      expect(f.pool.active).toBe(1);
      expect(f.pool.busy).toBe(true);
    } finally {
      release.resolve();
    }
    await follower.drained;
    expect(f.pool.active).toBe(0);
  });

  it("closes all views and refuses future admission after pool shutdown", async () => {
    const f = await fixture();
    const first = f.create()!,
      second = f.create()!;
    await snapshot(first);
    f.pool.close();
    expect(f.create()).toBeNull();
    expect(await first.poll()).toEqual({ status: "stopped", reason: "cancelled" });
    expect(await second.poll()).toEqual({ status: "stopped", reason: "cancelled" });
    await Promise.all([first.drained, second.drained]);
    expect(f.pool.active).toBe(0);
  });

  it("sanitizes callback errors and rejects invalid confirmation revisions", async () => {
    const f = await fixture();
    const follower = f.create()!;
    expect(await follower.confirm(-1)).toEqual({ status: "changed" });
    expect(await follower.confirm(NaN)).toEqual({ status: "changed" });
    f.identity.mockRejectedValue(new Error("PRIVATE transcript location"));
    expect(await follower.poll()).toEqual({ status: "stopped", reason: "unbound" });
  });
});
