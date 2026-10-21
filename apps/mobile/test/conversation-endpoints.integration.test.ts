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
import { MobileConversation } from "../src/net/mobile-conversation";

const id = (n: number | string) => String(n).padStart(22, "0");
function fixture(count = 100) {
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
    follow: () => ({
      poll: async () => ({
        status: "snapshot",
        snapshot: projection(),
        discontinuity: state.discontinuity,
        caughtUp: true,
      }),
      confirm: async () => ({ status: "confirmed", caughtUp: true }),
      close() {},
      drained: Promise.resolve(),
    }),
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
