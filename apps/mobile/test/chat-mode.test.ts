import { describe, expect, it } from "vitest";
import {
  type ChatConversationState,
  type ChatMode,
  type ChatModeInput,
  chatMode,
  preferredMode,
  type TemporaryView,
} from "../src/conversation/chat-mode";

const base: ChatModeInput = {
  chosen: null,
  agentKind: "claude",
  chatOffered: true,
  temporaryView: null,
  conversationState: "ready",
  ended: false,
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
          })),
        ),
      ),
    ),
  ),
);

describe("automatic mode", () => {
  it("opens Chat for an agent whose history the computer reads, when chat is offered", () => {
    expect(rule({ agentKind: "claude" })).toEqual({ mode: "chat", shows: "conversation" });
    expect(rule({ agentKind: "codex" })).toEqual({ mode: "chat", shows: "conversation" });
  });

  it("opens Terminal for a plain shell or an agent the computer can't read yet", () => {
    for (const agentKind of ["qwen", "some-new-agent", undefined])
      expect(rule({ agentKind })).toEqual({ mode: "terminal", shows: "terminal" });
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
    expect(rule({ chosen: "chat", agentKind: undefined })).toEqual({
      mode: "chat",
      shows: "conversation",
    });
    expect(rule({ chosen: "chat", agentKind: "qwen" }).mode).toBe("chat");
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
      // A chosen mode wins whenever chat is available at all.
      if (input.chosen && input.chatOffered && input.conversationState !== "disabled")
        expect(result.mode, label).toBe(input.chosen);
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
