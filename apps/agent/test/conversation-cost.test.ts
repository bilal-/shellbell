import * as fs from "node:fs";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { type ConversationBatch, type ConversationMessage, encodeCbor } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendRegistry } from "../src/backends/registry.js";
import { ConversationCoordinator } from "../src/conversation/conversation-coordinator.js";
import type { ConversationReference } from "../src/conversation/reference.js";
import { TranscriptLocator } from "../src/conversation/transcript-locator.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

/**
 * Cost of one open Claude chat through the real pipeline: coordinator, conversation stream,
 * follower, transcript file and locator, against a temporary transcript. Only the native pane
 * lookup is fake. Time is fake; file reads are real, and the clock only moves once every read
 * in flight has finished, so the counts don't depend on disk speed.
 *
 * Recorded before the chat-mode work (design step 1), over 60 s idle and one append: 378 native
 * lookups and 189 locator scans while idle, 27 idle status frames, 400 ms from append to send
 * and three full validations per delivered append. The expectations hold today's numbers;
 * later work should tighten them, never loosen them.
 */

const session = "11111111-1111-4111-8111-111111111111";
const id = (value: string | number) => String(value).padStart(22, "0");
const record = (uuid: string, parentUuid: string | null, text: string, role = "user") =>
  `${JSON.stringify({
    type: role,
    uuid,
    parentUuid,
    sessionId: session,
    message: { role, content: text },
  })}\n`;
/** Wall time, which the fake clock doesn't move. */
const realNow = () => Number(process.hrtime.bigint() / 1_000_000n);

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  // Back to the real watch, so a test that broke it leaves the next one with a watcher.
  vi.mocked(fs.watch).mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-cost-")));
  temporary.push(dir);
  const projects = join(dir, "projects");
  const codex = join(dir, "codex");
  await mkdir(join(projects, "project"), { recursive: true });
  await mkdir(codex);
  const path = join(projects, "project", `${session}.jsonl`);
  await writeFile(
    path,
    record("question", null, "Question") + record("answer", "question", "Answer", "assistant"),
  );

  const reference: ConversationReference = {
    agent: "claude",
    kind: "id",
    value: session,
    owner: "pane-generation-1",
  };
  const conversationReference = vi.fn(async () => ({ ...reference }));
  const roots = { claude: [projects], codex: [codex] };
  const real = new TranscriptLocator({ roots, enabled: () => true });
  const locate = vi.fn((...args: Parameters<TranscriptLocator["locate"]>) => real.locate(...args));
  let sequence = 0;
  const coordinator = new ConversationCoordinator({
    backend: {
      on: () => () => {},
      conversationReference,
    } as unknown as BackendRegistry,
    enabled: () => true,
    roots,
    locator: { locate },
    now: () => Date.now(),
    newId: () => id(++sequence),
  });

  const frames: { at: number; message: ConversationMessage }[] = [];
  const lease = coordinator.attach({
    current: () => true,
    send: (message) => {
      frames.push({ at: Date.now(), message });
      return true;
    },
    background: (producer) => ({
      wake: () => {
        for (let i = 0; i < 10 && producer(); i++);
      },
      close: () => {},
    }),
  });
  const receive = (message: ConversationMessage) =>
    lease.receive(message, encodeCbor(message).byteLength + 128);

  // Plays the phone: applies every batch at once, keeping all rows.
  let retained: string[] = [];
  let acknowledged = 0;
  const acknowledge = () => {
    const batches = frames
      .map((frame) => frame.message)
      .filter((m): m is ConversationBatch => m.type === "conversation.batch");
    for (const batch of batches.slice(acknowledged)) {
      if (batch.operation === "reset") retained = batch.entries.map((e) => e.id);
      else if (batch.operation === "prepend")
        retained = [...batch.entries.map((e) => e.id), ...retained];
      else
        retained = [
          ...retained.slice(0, batch.anchor === null ? 0 : retained.indexOf(batch.anchor!) + 1),
          ...batch.entries.map((e) => e.id),
          ...(batch.after ? retained.slice(retained.indexOf(batch.after)) : []),
        ];
      receive({
        type: "conversation.applied",
        subscriptionId: id("sub"),
        generation: batch.generation,
        batchId: batch.batchId,
        revision: batch.revision,
        oldestId: retained[0] ?? null,
        newestId: retained.at(-1) ?? null,
        retainedCount: retained.length,
      });
    }
    acknowledged = batches.length;
  };

  /** Waits in real time for the coordinator's current file work to finish. */
  const settle = async () => {
    const started = realNow();
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (Reflect.get(coordinator, "working") === null) break;
      if (realNow() - started > 5000) throw new Error("Conversation work did not settle");
    }
    acknowledge();
  };
  /**
   * Moves fake time timer by timer, letting real file work finish before each jump. With
   * `wakeMs`, first gives a file change event up to that long in real time to arrive and be
   * handled, as it would long before any timer on a real computer.
   */
  const run = async (ms: number, until?: () => boolean, wakeMs = 0) => {
    const end = Date.now() + ms;
    const waitUntil = realNow() + wakeMs;
    while (wakeMs && !until?.() && realNow() < waitUntil) {
      // Runs work that became due now, such as on a change event, without moving the clock.
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      await realDelay(5);
    }
    for (;;) {
      await settle();
      if (until?.() || Date.now() >= end) return;
      await vi.advanceTimersToNextTimerAsync();
    }
  };
  const batches = () =>
    frames.filter(
      (frame): frame is { at: number; message: ConversationBatch } =>
        frame.message.type === "conversation.batch",
    );
  const open = async () => {
    receive({ type: "conversation.subscribe", subscriptionId: id("sub"), sessionId: "herdr:pane" });
    await run(10_000, () => batches().length > 0);
    expect(JSON.stringify(batches()[0]!.message.entries)).toContain("Answer");
    // Let the chat reach its steady idle state before counting.
    await run(5_000);
  };
  /** Appends one complete assistant record and waits for the batch that carries it. */
  const append = async (text: string, wakeMs: number) => {
    conversationReference.mockClear();
    locate.mockClear();
    const sentBefore = batches().length;
    await appendFile(path, record(text.replace(/\W/g, "-"), "answer", text, "assistant"));
    const appendedAt = Date.now();
    const delivered = () =>
      batches()
        .slice(sentBefore)
        .find((frame) => JSON.stringify(frame.message.entries).includes(text));
    await run(10_000, () => delivered() !== undefined, wakeMs);
    const delivery = delivered();
    expect(delivery).toBeDefined();
    return {
      latencyMs: delivery!.at - appendedAt,
      references: conversationReference.mock.calls.length,
      scans: locate.mock.calls.length,
    };
  };

  return { path, coordinator, conversationReference, locate, frames, run, open, append, batches };
}

describe("conversation cost", () => {
  it("proves nothing while idle and delivers an append at once with one validation", async () => {
    // Real setImmediate stays available to wait for file work between fake-time jumps.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(1_000_000);
    const f = await fixture();
    try {
      await f.open();

      // (a) Idle: one open, caught-up chat, no file changes, for 60 s.
      f.conversationReference.mockClear();
      f.locate.mockClear();
      const idleFrom = f.frames.length;
      const idleStart = Date.now();
      await f.run(60_000);
      const idleMs = Date.now() - idleStart;
      const idle = {
        references: f.conversationReference.mock.calls.length,
        scans: f.locate.mock.calls.length,
        frames: f.frames.length - idleFrom,
      };

      // (b) and (c): append one complete assistant record; the file change event wakes it.
      const delivery = await f.append("Fresh reply", 2000);

      const line =
        `CONVERSATION-COST idle_window_ms=${idleMs} idle_reference_calls=${idle.references}` +
        ` idle_locator_scans=${idle.scans} idle_frames=${idle.frames}` +
        ` append_to_send_ms=${delivery.latencyMs} delivery_reference_calls=${delivery.references}` +
        ` delivery_locator_scans=${delivery.scans}`;
      console.log(line);
      const out = process.env.SHELLBELL_CONVERSATION_COST_OUT;
      if (out) await writeFile(out, `${line}\n`);

      // An idle chat makes no native lookups, no scans and sends nothing.
      expect(idle).toEqual({ references: 0, scans: 0, frames: 0 });
      // No fixed delay between the change event and the send.
      expect(delivery.latencyMs).toBeLessThanOrEqual(50);
      // One full validation: two native lookups around one scan.
      expect(delivery.scans).toBeLessThanOrEqual(1);
      expect(delivery.references).toBeLessThanOrEqual(2);
      // Closing the chat closes every change watcher it opened.
      const watchers = vi
        .mocked(fs.watch)
        .mock.results.flatMap((result) => (result.type === "return" ? [result.value] : []));
      expect(watchers.length).toBeGreaterThan(0);
      const closes = watchers.map((watcher) => vi.spyOn(watcher, "close"));
      f.coordinator.close();
      for (const close of closes) expect(close).toHaveBeenCalled();
    } finally {
      f.coordinator.close();
    }
  });

  it("still sees an append within the one-second check when no change event arrives", async () => {
    vi.mocked(fs.watch).mockImplementation(() => {
      throw new Error("no watch");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(1_000_000);
    const f = await fixture();
    try {
      await f.open();
      const delivery = await f.append("Polled reply", 0);
      console.log(`CONVERSATION-COST fallback_append_to_send_ms=${delivery.latencyMs}`);
      expect(delivery.latencyMs).toBeLessThanOrEqual(1200);
      expect(delivery.scans).toBeLessThanOrEqual(1);
    } finally {
      f.coordinator.close();
    }
  });

  it("ends the generation when the transcript file is replaced", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(1_000_000);
    const f = await fixture();
    try {
      await f.open();
      // With its change watcher, as a chat normally has: an earlier test's broken one is gone.
      expect(vi.mocked(fs.watch).mock.results.some((result) => result.type === "return")).toBe(
        true,
      );
      const before = f.frames.length;
      await rename(f.path, `${f.path}.old`);
      await writeFile(f.path, record("question", null, "Replaced"));
      await f.run(2_000, () =>
        f.frames.slice(before).some((frame) => frame.message.type === "conversation.clear"),
      );
      const after = f.frames.slice(before).map((frame) => frame.message);
      expect(after.find((message) => message.type === "conversation.clear")).toMatchObject({
        reason: "changed",
      });
      expect(JSON.stringify(after)).not.toContain("Replaced");
    } finally {
      f.coordinator.close();
    }
  });
});
