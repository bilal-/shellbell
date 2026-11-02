import type { SessionChat } from "@shellbell/protocol";
import { prefersConversation } from "../agents/registry";

/** The session's view: what the owner chose, or what its agent opens in. */
export type ChatMode = "chat" | "terminal";

/** Views that sit on top of either mode for a while and never change it. */
export type TemporaryView = "reading" | "search" | "selection" | "mouse";

/** The conversation's state as the phone last heard it; `undefined` before any word. */
export type ChatConversationState = "checking" | "ready" | "disabled" | "unavailable";

/** What the screen shows on top of the always-mounted terminal. */
export type ChatShows =
  | "conversation"
  | "opening"
  | "unavailable-banner"
  /** A new agent with no conversation yet: an empty chat whose first message starts one. */
  | "start"
  | "terminal";

export interface ChatModeInput {
  /** The owner's pick, or `null` while the session follows its agent. */
  readonly chosen: ChatMode | null;
  /** The agent running in the session now, such as `claude`; `undefined` when none runs. */
  readonly agentKind: string | undefined;
  /** The computer has chat on and speaks the conversation protocol. */
  readonly chatOffered: boolean;
  readonly temporaryView: TemporaryView | null;
  readonly conversationState: ChatConversationState | undefined;
  /** The session left the computer; the terminal layer says so. */
  readonly ended: boolean;
  /**
   * The computer's chat status for the session (`SessionInfo.chat`); `undefined` for a session
   * without an agent, or before the computer's first list naming it.
   */
  readonly chat?: SessionChat;
}

export interface ChatModeResult {
  readonly mode: ChatMode;
  readonly shows: ChatShows;
}

/**
 * The mode the session wants before the computer's answer is known: the owner's pick, else Chat
 * for an agent whose history the computer can read. It also decides whether to subscribe.
 */
export function preferredMode(
  chosen: ChatMode | null,
  agentKind: string | undefined,
  chat?: SessionChat,
): ChatMode {
  // Chat is for talking to a running agent. Once it exits there is no one to send to, so the
  // session is a terminal until an agent runs again; a stored pick of Chat waits until then.
  if (!agentRunning(agentKind, chat)) return "terminal";
  if (chosen) return chosen;
  if (chat?.state === "none" && chat.reason === "not-supported") return "terminal";
  return prefersConversation(chat?.agent ?? agentKind) ? "chat" : "terminal";
}

/**
 * Whether an agent runs in the session now: the session names one (`SessionInfo.agent`) and the
 * computer doesn't say it exited. Only then is there a Chat to show.
 */
export function agentRunning(agentKind: string | undefined, chat?: SessionChat): boolean {
  return Boolean(agentKind) && !(chat?.state === "none" && chat.reason === "agent-exited");
}

/**
 * Chat or Terminal, decided only by what the owner chose and what the computer says. No timer
 * takes part: a slow conversation keeps showing its opening placeholder instead of flipping.
 */
export function chatMode(input: ChatModeInput): ChatModeResult {
  // A computer without chat, or one whose owner turned it off, has only the terminal to show.
  if (!input.chatOffered || input.conversationState === "disabled")
    return { mode: "terminal", shows: "terminal" };
  const mode = preferredMode(input.chosen, input.agentKind, input.chat);
  // The terminal layer carries the ended notice; temporary views are terminal-only.
  if (mode === "terminal" || input.ended || input.temporaryView !== null)
    return { mode, shows: "terminal" };
  // The computer's chat status says what there is to show before any conversation message, and
  // which chat any rows belong to: until it does, there is nothing to show or send into.
  if (!input.chat) return { mode, shows: "opening" };
  if (input.chat.state === "none")
    return {
      mode,
      shows: input.chat.reason === "not-started" ? "start" : "unavailable-banner",
    };
  if (input.chat.state === "finding") return { mode, shows: "opening" };
  switch (input.conversationState) {
    case "ready":
      return { mode, shows: "conversation" };
    case "unavailable":
      return { mode, shows: "unavailable-banner" };
    default:
      return { mode, shows: "opening" };
  }
}
