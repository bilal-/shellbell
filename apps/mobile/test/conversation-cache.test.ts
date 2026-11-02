import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_KEEP_MS, ConversationCache } from "../src/net/conversation-cache";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));

const kept = (text = "Hello") => ({
  snapshot: {
    state: "ready" as const,
    entries: [{ id: "1".padStart(22, "0"), kind: "assistant" as const, text }],
    history: "unloaded" as const,
    historyStatus: "idle" as const,
    canRequestOlder: false,
    caughtUp: true,
    notice: null,
    reason: null,
  },
  chat: "c1",
  agent: "claude",
});

afterEach(() => vi.useRealTimers());

describe("kept conversations", () => {
  it("keep a left session's rows for two minutes, in memory only", () => {
    vi.useFakeTimers();
    const cache = new ConversationCache();
    cache.keep("f1", "tmux:a", kept());
    expect(cache.peek("f1", "tmux:a")?.chat).toBe("c1");
    vi.advanceTimersByTime(CONVERSATION_KEEP_MS - 1);
    expect(cache.peek("f1", "tmux:a")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(cache.peek("f1", "tmux:a")).toBeNull();
  });

  it("restarts the two minutes when a session is left again", () => {
    vi.useFakeTimers();
    const cache = new ConversationCache();
    cache.keep("f1", "tmux:a", kept("old"));
    vi.advanceTimersByTime(CONVERSATION_KEEP_MS - 10);
    cache.keep("f1", "tmux:a", kept("new"));
    vi.advanceTimersByTime(CONVERSATION_KEEP_MS - 10);
    expect(cache.peek("f1", "tmux:a")?.snapshot.entries[0]?.text).toBe("new");
  });

  it("never keeps an empty conversation", () => {
    const cache = new ConversationCache();
    cache.keep("f1", "tmux:a", { ...kept(), snapshot: { ...kept().snapshot, entries: [] } });
    expect(cache.size).toBe(0);
  });

  it("forgets by session, computer, complete list and all at once", () => {
    const cache = new ConversationCache();
    cache.keep("f1", "tmux:a", kept());
    cache.keep("f1", "tmux:b", kept());
    cache.keep("f2", "tmux:a", kept());
    cache.keepListed("f1", ["tmux:b"]);
    expect(cache.peek("f1", "tmux:a")).toBeNull();
    expect(cache.peek("f1", "tmux:b")).not.toBeNull();
    cache.forgetSession("f1", "tmux:b");
    expect(cache.peek("f1", "tmux:b")).toBeNull();
    cache.keep("f1", "tmux:c", kept());
    cache.forgetComputer("f1");
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("opening a found chat from the list", () => {
  it("starts early only for a found chat that opens in Chat", async () => {
    const { CONVERSATION_FEATURE } = await import("@shellbell/protocol");
    const { opensFoundChat } = await import("../src/conversation/preopen");
    const { useChosenModes } = await import("../src/store/chosen-modes");
    const on = { conversationEnabled: true, features: [CONVERSATION_FEATURE] } as never;
    const session = {
      id: "tmux:a",
      instance: "i1",
      agent: { kind: "claude" },
      chat: { state: "found" as const, id: "c1", agent: "claude" },
    };
    useChosenModes.setState({ entries: {}, hydrated: true });
    expect(opensFoundChat("f1", session, on)).toBe(true);
    expect(opensFoundChat("f1", { ...session, chat: { state: "finding" } }, on)).toBe(false);
    expect(
      opensFoundChat("f1", session, { ...(on as object), conversationEnabled: false } as never),
    ).toBe(false);
    expect(opensFoundChat("f1", session, undefined)).toBe(false);
    // The owner picked Terminal for this session: nothing to start.
    useChosenModes.getState().choose("f1", "tmux:a", "i1", "terminal");
    expect(opensFoundChat("f1", session, on)).toBe(false);
  });
});
