import { describe, expect, it } from "vitest";
import {
  type ChatConversationState,
  type ChatMode,
  type ChatModeInput,
  chatMode,
  preferredMode,
  type TemporaryView,
} from "../src/conversation/chat-mode";

/** The computer found the running agent's chat, as a session list says for every agent. */
const found = (agent: string | undefined) =>
  agent ? { state: "found" as const, id: "chat-1", agent } : undefined;
const base: ChatModeInput = {
  chosen: null,
  agentKind: "claude",
  chatOffered: true,
  temporaryView: null,
  conversationState: "ready",
  ended: false,
  chat: found("claude"),
};
const rule = (overrides: Partial<ChatModeInput>) => chatMode({ ...base, ...overrides });

const CHOSEN: (ChatMode | null)[] = [null, "chat", "terminal"];
const AGENTS: (string | undefined)[] = ["claude", "codex", "qwen", "some-new-agent", undefined];
const TEMPORARY: (TemporaryView | null)[] = [null, "reading", "search", "selection", "mouse"];
const STATES: (ChatConversationState | undefined)[] = [
  undefined,
  "checking",
  "ready",
  "disabled",
  "unavailable",
];
const every: ChatModeInput[] = CHOSEN.flatMap((chosen) =>
  AGENTS.flatMap((agentKind) =>
    [true, false].flatMap((chatOffered) =>
      TEMPORARY.flatMap((temporaryView) =>
        STATES.flatMap((conversationState) =>
          [true, false].map((ended) => ({
            chosen,
            agentKind,
            chatOffered,
            temporaryView,
            conversationState,
            ended,
            chat: found(agentKind),
          })),
        ),
      ),
    ),
  ),
);

describe("automatic mode", () => {
  it("opens Chat for an agent whose history the computer reads, when chat is offered", () => {
    expect(rule({ agentKind: "claude" })).toEqual({ mode: "chat", shows: "conversation" });
    expect(rule({ agentKind: "codex", chat: found("codex") })).toEqual({
      mode: "chat",
      shows: "conversation",
    });
  });

  it("opens Terminal for a plain shell or an agent the computer can't read yet", () => {
    for (const agentKind of ["qwen", "some-new-agent", undefined])
      expect(rule({ agentKind, chat: found(agentKind) })).toEqual({
        mode: "terminal",
        shows: "terminal",
      });
  });

  it("opens Terminal whenever the computer doesn't offer chat", () => {
    expect(rule({ chatOffered: false })).toEqual({ mode: "terminal", shows: "terminal" });
  });
});

describe("chosen mode", () => {
  it("overrides the agent's default both ways", () => {
    expect(rule({ chosen: "terminal", agentKind: "claude" })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
    expect(rule({ chosen: "chat", agentKind: "qwen" })).toEqual({
      mode: "chat",
      shows: "conversation",
    });
  });

  it("can't show Chat on a computer that doesn't offer it", () => {
    expect(rule({ chosen: "chat", chatOffered: false })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
  });
});

describe("what Chat mode shows", () => {
  it("shows the opening placeholder until the computer answers, with no timer", () => {
    expect(rule({ conversationState: undefined })).toEqual({ mode: "chat", shows: "opening" });
    expect(rule({ conversationState: "checking" })).toEqual({ mode: "chat", shows: "opening" });
  });

  it("shows the conversation once it is ready", () => {
    expect(rule({ conversationState: "ready" })).toEqual({ mode: "chat", shows: "conversation" });
  });

  it("stays in Chat with a banner when the conversation is unavailable", () => {
    expect(rule({ conversationState: "unavailable" })).toEqual({
      mode: "chat",
      shows: "unavailable-banner",
    });
    expect(rule({ chosen: "chat", conversationState: "unavailable" }).mode).toBe("chat");
  });

  it("switches to Terminal only when the owner turned chat off", () => {
    expect(rule({ conversationState: "disabled" })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
    expect(rule({ chosen: "chat", conversationState: "disabled" })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
  });
});

describe("temporary views", () => {
  it.each(["reading", "search", "selection", "mouse"] as const)(
    "%s shows the terminal without changing the mode",
    (temporaryView) => {
      expect(rule({ temporaryView })).toEqual({ mode: "chat", shows: "terminal" });
      expect(rule({ temporaryView, chosen: "chat", conversationState: "checking" })).toEqual({
        mode: "chat",
        shows: "terminal",
      });
      expect(rule({ temporaryView, chosen: "terminal" })).toEqual({
        mode: "terminal",
        shows: "terminal",
      });
    },
  );
});

describe("ended sessions", () => {
  it("show the terminal layer's notice and keep the mode", () => {
    expect(rule({ ended: true })).toEqual({ mode: "chat", shows: "terminal" });
    expect(rule({ ended: true, chosen: "terminal" })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
  });
});

describe("every combination", () => {
  it(`holds the rule's invariants across all ${every.length} inputs`, () => {
    for (const input of every) {
      const result = chatMode(input);
      const label = JSON.stringify(input);
      // Terminal mode shows the terminal.
      if (result.mode === "terminal") expect(result.shows, label).toBe("terminal");
      // Chat can't be shown without the computer offering it, or after the owner turned it off.
      if (!input.chatOffered || input.conversationState === "disabled")
        expect(result, label).toEqual({ mode: "terminal", shows: "terminal" });
      else expect(result.mode, label).toBe(preferredMode(input.chosen, input.agentKind));
      // Temporary views and ended sessions never show Chat, and never change the mode.
      if (input.temporaryView !== null || input.ended) {
        expect(result.shows, label).toBe("terminal");
        expect(result.mode, label).toBe(
          chatMode({ ...input, temporaryView: null, ended: false }).mode,
        );
      }
      // A chosen mode wins whenever chat is available and an agent runs to talk to.
      if (
        input.chosen &&
        input.chatOffered &&
        input.conversationState !== "disabled" &&
        input.agentKind
      )
        expect(result.mode, label).toBe(input.chosen);
      // With no agent running, there is only the terminal, whatever was chosen.
      if (!input.agentKind) expect(result, label).toEqual({ mode: "terminal", shows: "terminal" });
      // Chat with nothing on top shows exactly what the conversation state says.
      if (result.mode === "chat" && input.temporaryView === null && !input.ended)
        expect(result.shows, label).toBe(
          input.conversationState === "ready"
            ? "conversation"
            : input.conversationState === "unavailable"
              ? "unavailable-banner"
              : "opening",
        );
    }
  });
});

describe("the computer's chat status", () => {
  it("opens, never shows a conversation, until the session list says which chat it is", () => {
    const noStatus = { ...base, chat: undefined };
    expect(chatMode(noStatus)).toEqual({ mode: "chat", shows: "opening" });
    expect(chatMode({ ...noStatus, conversationState: "unavailable" }).shows).toBe("opening");
  });

  it("follows the design table in Chat mode", () => {
    expect(rule({ chat: { state: "finding", agent: "claude" } }).shows).toBe("opening");
    // Found, before the first page; then the conversation once it arrives.
    expect(
      rule({ chat: { state: "found", agent: "claude" }, conversationState: "checking" }).shows,
    ).toBe("opening");
    expect(rule({ chat: { state: "found", agent: "claude" } }).shows).toBe("conversation");
    expect(rule({ chat: { state: "none", agent: "claude", reason: "agent-exited" } })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
    for (const reason of ["no-history", "lookup-limit", "ambiguous"] as const)
      expect(rule({ chat: { state: "none", agent: "claude", reason } })).toEqual({
        mode: "chat",
        shows: "unavailable-banner",
      });
  });

  it("returns to Terminal when the agent exits, and to Chat when one runs again", () => {
    const exited = { state: "none" as const, agent: "claude", reason: "agent-exited" as const };
    // The agent exited, or the session no longer names one: Terminal, chosen Chat or not.
    expect(rule({ agentKind: undefined, chat: exited })).toEqual({
      mode: "terminal",
      shows: "terminal",
    });
    expect(rule({ agentKind: "claude", chat: exited }).mode).toBe("terminal");
    expect(rule({ chosen: "chat", agentKind: undefined }).mode).toBe("terminal");
    // An agent starts again: Chat, automatic or chosen, unless the owner chose Terminal.
    const starting = { state: "none" as const, agent: "codex", reason: "not-started" as const };
    expect(rule({ agentKind: "codex", chat: starting })).toEqual({ mode: "chat", shows: "start" });
    expect(rule({ chosen: "chat", agentKind: "codex", chat: starting }).mode).toBe("chat");
    expect(rule({ chosen: "terminal", agentKind: "codex", chat: starting }).mode).toBe("terminal");
    expect(rule({ agentKind: "codex", chat: { state: "finding", agent: "codex" } }).mode).toBe(
      "chat",
    );
    // An agent the computer can't read opens in Terminal.
    expect(
      rule({ agentKind: "qwen", chat: { state: "none", agent: "qwen", reason: "not-supported" } })
        .mode,
    ).toBe("terminal");
    expect(
      rule({
        chosen: "chat",
        agentKind: "qwen",
        chat: { state: "none", agent: "qwen", reason: "not-supported" },
      }),
    ).toEqual({ mode: "chat", shows: "unavailable-banner" });
  });

  it("still gives way to temporary views, an ended session and chat turned off", () => {
    const found = { state: "found" as const, agent: "claude" };
    expect(rule({ chat: found, temporaryView: "reading" })).toEqual({
      mode: "chat",
      shows: "terminal",
    });
    expect(rule({ chat: found, ended: true }).shows).toBe("terminal");
    expect(rule({ chat: found, conversationState: "disabled" }).mode).toBe("terminal");
    expect(rule({ chat: found, chatOffered: false }).mode).toBe("terminal");
  });
});

describe("a new agent with no conversation yet", () => {
  it("opens in Chat, ready for its first message", () => {
    const notStarted = { state: "none" as const, agent: "claude", reason: "not-started" as const };
    expect(rule({ chat: notStarted, conversationState: "unavailable" })).toEqual({
      mode: "chat",
      shows: "start",
    });
    expect(rule({ agentKind: undefined, chat: notStarted }).mode).toBe("terminal");
    expect(rule({ chat: notStarted, temporaryView: "reading" }).shows).toBe("terminal");
  });
});
