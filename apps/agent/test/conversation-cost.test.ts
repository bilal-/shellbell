import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationBatch, type ConversationMessage, encodeCbor } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendRegistry } from "../src/backends/registry.js";
import { ConversationCoordinator } from "../src/conversation/conversation-coordinator.js";
import type { ConversationReference } from "../src/conversation/reference.js";
import { TranscriptLocator } from "../src/conversation/transcript-locator.js";

/**
 * Baseline cost of one open Claude chat through the real pipeline: coordinator, conversation
 * stream, follower, transcript file and locator, against a temporary transcript. Only the
 * native pane lookup is fake. Time is fake; file reads are real, and the clock only moves
 * once every read in flight has finished, so the counts don't depend on disk speed.
 *
 * The expectations describe today's behaviour (chat-mode design step 1). Later work that
 * removes idle proofs and fixed delays should tighten them, not loosen them.
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

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
    const started = performance.now();
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (Reflect.get(coordinator, "working") === null) break;
      if (performance.now() - started > 5000) throw new Error("Conversation work did not settle");
    }
    acknowledge();
  };
  /** Moves fake time timer by timer, letting real file work finish before each jump. */
  const run = async (ms: number, until?: () => boolean) => {
    const end = Date.now() + ms;
    for (;;) {
      await settle();
      if (until?.() || Date.now() >= end) return;
      await vi.advanceTimersToNextTimerAsync();
    }
  };

  return { path, coordinator, conversationReference, locate, frames, receive, run };
}

describe("conversation cost baseline", () => {
  it("records today's idle proofs, append latency and proofs per delivery", async () => {
    // Real setImmediate stays available to wait for file work between fake-time jumps.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(1_000_000);
    const f = await fixture();
    try {
      f.receive({
        type: "conversation.subscribe",
        subscriptionId: id("sub"),
        sessionId: "herdr:pane",
      });
      const batches = () =>
        f.frames.filter(
          (frame): frame is { at: number; message: ConversationBatch } =>
            frame.message.type === "conversation.batch",
        );
      await f.run(10_000, () => batches().length > 0);
      expect(JSON.stringify(batches()[0]!.message.entries)).toContain("Answer");
      // Let the chat reach its steady idle state before counting.
      await f.run(5_000);

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

      // (b) and (c): append one complete assistant record.
      f.conversationReference.mockClear();
      f.locate.mockClear();
      const sentBefore = batches().length;
      await appendFile(f.path, record("reply", "answer", "Fresh reply", "assistant"));
      const appendedAt = Date.now();
      const delivered = () =>
        batches()
          .slice(sentBefore)
          .find((frame) => JSON.stringify(frame.message.entries).includes("Fresh reply"));
      await f.run(10_000, () => delivered() !== undefined);
      const delivery = delivered();
      expect(delivery).toBeDefined();
      const latencyMs = delivery!.at - appendedAt;
      const perDelivery = {
        references: f.conversationReference.mock.calls.length,
        scans: f.locate.mock.calls.length,
      };

      const line =
        `CONVERSATION-COST idle_window_ms=${idleMs} idle_reference_calls=${idle.references}` +
        ` idle_locator_scans=${idle.scans} idle_frames=${idle.frames}` +
        ` append_to_send_ms=${latencyMs} delivery_reference_calls=${perDelivery.references}` +
        ` delivery_locator_scans=${perDelivery.scans}`;
      console.log(line);
      const out = process.env.SHELLBELL_CONVERSATION_COST_OUT;
      if (out) await writeFile(out, `${line}\n`);

      // TODAY (to tighten): an idle chat re-proves ownership about three times a second, each
      // proof being two native lookups around one full locator scan, and sends a status
      // message every couple of seconds. Design target: no proofs while idle.
      expect(idle.frames).toBeGreaterThan(0);
      expect(idle.scans).toBeGreaterThanOrEqual(100);
      expect(idle.references).toBe(idle.scans * 2);
      // TODAY (to tighten): fixed 200 ms steps put an append several hundred ms behind.
      expect(latencyMs).toBeGreaterThan(0);
      expect(latencyMs).toBeLessThanOrEqual(2000);
      // TODAY (to tighten): several proofs per delivered append. Design target: one.
      expect(perDelivery.scans).toBeGreaterThan(1);
      expect(perDelivery.references).toBe(perDelivery.scans * 2);
    } finally {
      f.coordinator.close();
    }
  });
});
