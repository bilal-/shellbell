import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationMessage, encodeCbor } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendRegistry } from "../src/backends/registry.js";
import { ConversationCoordinator } from "../src/conversation/conversation-coordinator.js";
import type { ConversationReference } from "../src/conversation/reference.js";
import { TranscriptLocator } from "../src/conversation/transcript-locator.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const id = (value: string | number) => String(value).padStart(22, "0");
const record = (
  session: string,
  uuid: string,
  parentUuid: string | null,
  role: string,
  text: string,
) =>
  `${JSON.stringify({ type: role, uuid, parentUuid, sessionId: session, message: { role, content: text } })}\n`;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("the chat id a conversation's rows carry", () => {
  it("is the one the rows' own file validation proved, even if the agent switched before it opened", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-chat-id-")));
    temporary.push(dir);
    const projects = join(dir, "projects");
    await mkdir(join(projects, "project"), { recursive: true });
    const path = (session: string) => join(projects, "project", `${session}.jsonl`);
    await writeFile(path(A), record(A, "a1", null, "user", "From A"));
    await writeFile(path(B), record(B, "b1", null, "user", "From B"));
    // tmux or iTerm2: the same process owner across a /resume, from A to B.
    const reference = (session: string): ConversationReference => ({
      agent: "claude",
      kind: "id",
      value: session,
      owner: "same-process",
    });
    let current = A;
    let probes = 0;
    const conversationReference = vi.fn(async () => {
      // The follower's first probe, before it opens its file, sees A; then the agent switches.
      if (++probes === 2) {
        const seen = reference(current);
        current = B;
        return seen;
      }
      return reference(current);
    });
    const roots = { claude: [projects], codex: [join(dir, "codex")] };
    const named: string[] = [];
    let sequence = 0;
    const coordinator = new ConversationCoordinator({
      backend: { on: () => () => {}, conversationReference } as unknown as BackendRegistry,
      enabled: () => true,
      roots,
      locator: new TranscriptLocator({ roots, enabled: () => true }),
      newId: () => id(++sequence),
      chatId: (_sessionId, proved) => {
        named.push(proved.value);
        return `chat-${proved.value.slice(0, 1)}`;
      },
    });
    const frames: ConversationMessage[] = [];
    const lease = coordinator.attach({
      current: () => true,
      send: (message) => {
        frames.push(message);
        return true;
      },
      background: (producer) => ({
        wake: () => {
          for (let i = 0; i < 10 && producer(); i++);
        },
        close: () => {},
      }),
      chatV2: () => true,
    });
    const receive = (message: ConversationMessage) =>
      lease.receive(message, encodeCbor(message).byteLength + 128);
    try {
      receive({ type: "conversation.subscribe", subscriptionId: id("s"), sessionId: "tmux:%1" });
      await vi.waitFor(() =>
        expect(frames.some((m) => m.type === "conversation.status" && m.state === "ready")).toBe(
          true,
        ),
      );
      const batch = frames.find((m) => m.type === "conversation.batch");
      const ready = frames.find(
        (m): m is Extract<ConversationMessage, { type: "conversation.status" }> =>
          m.type === "conversation.status" && m.state === "ready",
      )!;
      // The rows are B's, so the chat they name is B's, never the A of the first probe.
      expect(JSON.stringify(batch)).toContain("From B");
      expect(ready.chat).toBe("chat-2");
      expect(named.every((value) => value === B)).toBe(true);
      if (batch?.type === "conversation.batch")
        receive({
          type: "conversation.applied",
          subscriptionId: id("s"),
          generation: batch.generation,
          batchId: batch.batchId,
          revision: batch.revision,
          oldestId: batch.entries[0]?.id ?? null,
          newestId: batch.entries.at(-1)?.id ?? null,
          retainedCount: batch.entries.length,
        });
      // Back to A: the next validation of B's rows ends their generation.
      current = A;
      await appendFile(path(B), record(B, "b2", "b1", "assistant", "More from B"));
      await vi.waitFor(
        () => expect(frames.some((m) => m.type === "conversation.clear")).toBe(true),
        { timeout: 5000 },
      );
      expect(frames.find((m) => m.type === "conversation.clear")).toMatchObject({
        reason: "changed",
      });
      expect(JSON.stringify(frames)).not.toContain("More from B");
    } finally {
      coordinator.close();
    }
  });
});
