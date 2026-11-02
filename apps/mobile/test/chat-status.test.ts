import { describe, expect, it } from "vitest";
import { chatComposerHold, chatNoneText, chatSwitchNotice } from "../src/conversation/chat-status";

const found = { state: "found" as const, id: "c1", agent: "claude" };
const hold = (overrides: Partial<Parameters<typeof chatComposerHold>[0]>) =>
  chatComposerHold({
    shows: "conversation",
    chat: found,
    waiting: false,
    dimmed: false,
    agent: "claude",
    ...overrides,
  });

describe("chat status", () => {
  it("holds the composer whenever Chat has no found chat to send into", () => {
    expect(hold({})).toBeNull();
    expect(hold({ shows: "terminal", chat: undefined, waiting: true })).toBeNull();
    expect(hold({ waiting: true })).toBe("Answer in the terminal");
    expect(hold({ shows: "unavailable-banner" })).toBe("Chat unavailable");
    expect(hold({ dimmed: true })).toBe("Opening Claude’s chat…");
    expect(hold({ shows: "opening", chat: { state: "finding", agent: "claude" } })).toBe(
      "Opening Claude’s chat…",
    );
    // A computer that sends no chat status keeps today's composer.
    expect(hold({ chat: undefined })).toBeNull();
  });

  it("names a replaced chat", () => {
    expect(chatSwitchNotice({ agent: "claude" }, { agent: "codex" })).toBe("Now Codex");
    expect(chatSwitchNotice({ agent: "claude" }, { agent: "claude" })).toBe("New conversation");
    expect(chatSwitchNotice(null, {})).toBe("New conversation");
  });

  it("says each reason in plain words", () => {
    expect(chatNoneText("no-history", "claude")).toBe("No chat history for this session yet.");
    expect(chatNoneText("unsupported-version", "codex")).toBe(
      "Chat can’t read this version of Codex.",
    );
    expect(chatNoneText("not-supported", "qwen")).toBe("Chat isn’t available for Qwen yet.");
    expect(chatNoneText("lookup-limit", "claude")).toBe(
      "Too many sessions to find this chat right now.",
    );
    expect(chatNoneText("ambiguous", "claude")).toBe("Chat can’t tell which conversation this is.");
    expect(chatNoneText(undefined, "claude")).toBe("Chat isn’t available right now.");
  });
});
