import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_LIMITS,
  type ConversationMessage,
  ConversationMessageSchema,
  decodeCbor,
  encodeCbor,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { AgentConversationStream } from "../../agent/src/conversation/agent-conversation-stream.js";
import type { ConversationSnapshot } from "../../agent/src/conversation/transcript-document.js";
import {
  type TranscriptFollower,
  TranscriptFollowers,
} from "../../agent/src/conversation/transcript-follower.js";
import { MobileConversation } from "../src/net/mobile-conversation";

const id = (n: number | string) => String(n).padStart(22, "0");
function fixture(count = 100, follower?: TranscriptFollower) {
  let sequence = 0;
  const state = {
    now: 1,
    enabled: true,
    count,
    revision: 1,
    discontinuity: 0,
    dropApplied: false,
    refuseClear: false,
    changed: -1,
  };
  const queues: Array<() => void> = [];
  const sent: ConversationMessage[] = [];
  const projection = (): ConversationSnapshot => ({
    state: "ready",
    history: "complete",
    change: "replace",
    revision: state.revision,
    entries: Array.from({ length: state.count }, (_, i) => ({
      id: `local-${i}`,
      kind: "assistant",
      text: i === state.changed ? "Updated group" : `Message ${i}`,
    })),
    branch: {
      kind: "claude",
      nodes: Array.from({ length: state.count }, (_, i) => ({ id: `native-${i}`, start: i * 100 })),
    },
  });
  const copy = (message: ConversationMessage) =>
    ConversationMessageSchema.parse(decodeCbor(encodeCbor(message)));
  const phone = new MobileConversation({
    subscriptionId: id("sub"),
    sessionId: "herdr:pane",
    now: () => state.now,
    newRequestId: () => id(++sequence),
    send: (message) => {
      if (message.type === "conversation.cleared" && state.refuseClear) return false;
      if (message.type === "conversation.applied" && state.dropApplied) return true;
      queues.push(() => source.receive(copy(message), encodeCbor(message).byteLength + 128));
      return true;
    },
  });
  const source = new AgentConversationStream({
    subscriptionId: id("sub"),
    sessionId: "herdr:pane",
    now: () => state.now,
    newId: () => id(++sequence),
    enabled: () => state.enabled,
    follow: () =>
      follower ?? {
        poll: async () => ({
          status: "snapshot",
          snapshot: projection(),
          discontinuity: state.discontinuity,
          caughtUp: true,
        }),
        confirm: async () => ({ status: "confirmed", caughtUp: true }),
        close() {},
        drained: Promise.resolve(),
      },
    send: (message) => {
      sent.push(message);
      queues.push(() => phone.receive(copy(message), encodeCbor(message).byteLength + 128));
      return true;
    },
    wake() {},
  });
  const flush = () => {
    for (let i = 0; i < 100; i++) {
      const next = queues.shift();
      if (!next) return;
      next();
    }
    throw new Error("unbounded message loop");
  };
  const step = async (ms = 1000) => {
    state.now += ms;
    source.tick();
    phone.tick();
    flush();
    await source.work();
    for (let i = 0; i < 10 && source.offer(); i++);
    flush();
  };
  phone.start();
  flush();
  return {
    state,
    phone,
    source,
    sent,
    step,
    close: () => {
      source.close();
      phone.close();
      flush();
    },
  };
}

describe("Conversation source and phone contract", () => {
  it.each(["claude", "codex"] as const)(
    "pages physical %s history and preserves it through live output",
    async (agent) => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "shellbell-conversation-history-")),
      );
      const root = join(directory, agent);
      await mkdir(root);
      const session = "11111111-1111-4111-8111-111111111111";
      const path = join(root, `${session}.jsonl`);
      const texts = Array.from({ length: 300 }, (_, i) => `${i}: ${"x".repeat(1200)}`);
      const record = (text: string, i: number) =>
        agent === "claude"
          ? {
              type: "user",
              uuid: `node-${i}`,
              parentUuid: i ? `node-${i - 1}` : null,
              sessionId: session,
              message: { role: "user", content: text },
            }
          : { type: "event_msg", payload: { type: "user_message", message: text } };
      await writeFile(
        path,
        [
          ...(agent === "codex" ? [{ type: "session_meta", payload: { id: session } }] : []),
          ...texts.map(record),
        ]
          .map((value) => `${JSON.stringify(value)}\n`)
          .join(""),
      );
      const pool = new TranscriptFollowers();
      const follower = pool.create({
        enabled: () => true,
        roots: { claude: agent === "claude" ? [root] : [], codex: agent === "codex" ? [root] : [] },
        identity: async () => ({ agent, path, session, owner: "isolated-history-test" }),
      })!;
      const f = fixture(0, follower);
      try {
        for (let i = 0; i < 30 && !f.phone.snapshot.entries.length; i++) await f.step(200);
        expect(f.phone.snapshot.entries.length).toBeGreaterThan(0);
        expect(f.phone.snapshot.entries.length).toBeLessThan(texts.length);
        for (let page = 0; page < 40 && f.phone.snapshot.history !== "complete"; page++) {
          expect(f.phone.requestOlder()).toBe(true);
          for (let step = 0; step < 30 && f.phone.snapshot.historyStatus === "loading"; step++)
            await f.step(200);
          expect(f.phone.snapshot.historyStatus).toBe("idle");
        }
        expect(f.phone.snapshot.history).toBe("complete");
        expect(f.phone.snapshot.entries.map((entry) => entry.text)).toEqual(texts);
        await appendFile(path, `${JSON.stringify(record("New live message", 300))}\n`);
        for (let i = 0; i < 30 && f.phone.snapshot.entries.length < 301; i++) await f.step(200);
        expect(f.phone.snapshot.entries.map((entry) => entry.text)).toEqual([
          ...texts,
          "New live message",
        ]);
        expect(JSON.stringify(f.sent)).not.toMatch(
          /node-|entryHash|recordHash|nodeId|11111111|isolated-history-test|jsonl/,
        );
        expect(f.sent.some((message) => message.type === "conversation.clear")).toBe(false);
        if (agent === "claude") {
          const current = await follower.poll();
          if (current.status !== "snapshot" || current.snapshot.branch?.kind !== "claude")
            throw new Error("Expected a settled Claude projection");
          const first = current.snapshot.branch.nodes[0]!;
          const prior = Number(first.id.slice("node-".length)) - 1;
          expect(prior).toBeGreaterThan(0);
          // This ancestor is on the phone but no longer in the live document's branch window.
          await appendFile(path, `${JSON.stringify(record("Rewritten older ancestor", prior))}\n`);
          for (
            let i = 0;
            i < 30 && !f.sent.some((message) => message.type === "conversation.clear");
            i++
          )
            await f.step(200);
          const clear = f.sent.find((message) => message.type === "conversation.clear");
          expect(clear).toBeTruthy();
          expect(["changed", "skipped"]).toContain(clear?.reason);
        }
      } finally {
        f.close();
        pool.close();
        await follower.drained;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps the latest reply visible while an older group changes", async () => {
    const f = fixture();
    try {
      await f.step();
      await f.step();
      const newest = f.phone.snapshot.entries.at(-1);
      f.state.changed = 40;
      f.state.revision++;
      await f.step();
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(64);
      expect(f.phone.snapshot.entries[4]?.text).toBe("Updated group");
      expect(f.phone.snapshot.entries.at(-1)).toBe(newest);
      expect(f.sent.some((message) => message.type === "conversation.clear")).toBe(false);
    } finally {
      f.close();
    }
  });
  it("loads older messages and keeps them while a new reply arrives", async () => {
    const f = fixture();
    try {
      await f.step();
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(64);
      expect(f.phone.snapshot.entries[0]?.text).toBe("Message 36");
      expect(f.phone.requestOlder()).toBe(true);
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(100);
      f.state.count++;
      f.state.revision++;
      await f.step();
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(101);
      expect(f.phone.snapshot.entries[0]?.text).toBe("Message 0");
      expect(f.phone.snapshot.entries.at(-1)?.text).toBe("Message 100");
      expect(JSON.stringify(f.sent)).not.toMatch(/native-|local-/);
    } finally {
      f.close();
    }
  });

  it("recovers a lost applied ACK without duplicate rows", async () => {
    const f = fixture(3);
    try {
      f.state.dropApplied = true;
      await f.step();
      await f.step();
      f.state.dropApplied = false;
      await f.step(CONVERSATION_LIMITS.progressMs);
      expect(f.phone.snapshot.entries).toHaveLength(3);
      expect(f.sent.filter((m) => m.type === "conversation.batch")).toHaveLength(2);
      f.state.count++;
      f.state.revision++;
      await f.step();
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(4);
    } finally {
      f.close();
    }
  });

  it("waits for the phone to clear before recovering a skipped source window", async () => {
    const f = fixture(3);
    try {
      await f.step();
      await f.step();
      f.state.refuseClear = true;
      f.state.discontinuity++;
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(0);
      expect(f.phone.snapshot.notice).toBe("skipped");
      const batches = f.sent.filter((m) => m.type === "conversation.batch").length;
      await f.step();
      expect(f.sent.filter((m) => m.type === "conversation.batch")).toHaveLength(batches);
      f.state.refuseClear = false;
      await f.step(CONVERSATION_LIMITS.progressMs);
      await f.step();
      await f.step();
      expect(f.phone.snapshot.entries).toHaveLength(3);
      expect(f.phone.snapshot.notice).toBe("skipped");
    } finally {
      f.close();
    }
  });
});
