import { prefersConversation } from "../agents/registry";

/** The session's view: what the owner chose, or what its agent opens in. */
export type ChatMode = "chat" | "terminal";

/** Views that sit on top of either mode for a while and never change it. */
export type TemporaryView = "reading" | "search" | "selection" | "mouse";

/** The conversation's state as the phone last heard it; `undefined` before any word. */
export type ChatConversationState = "checking" | "ready" | "disabled" | "unavailable";

/** What the screen shows on top of the always-mounted terminal. */
export type ChatShows = "conversation" | "opening" | "unavailable-banner" | "terminal";

export interface ChatModeInput {
  /** The owner's pick, or `null` while the session follows its agent. */
  readonly chosen: ChatMode | null;
  /** The agent the session last named, such as `claude`. */
  readonly agentKind: string | undefined;
  /** The computer has chat on and speaks the conversation protocol. */
  readonly chatOffered: boolean;
  readonly temporaryView: TemporaryView | null;
  readonly conversationState: ChatConversationState | undefined;
  /** The session left the computer; the terminal layer says so. */
  readonly ended: boolean;
}

export interface ChatModeResult {
  readonly mode: ChatMode;
  readonly shows: ChatShows;
}

/**
 * The mode the session wants before the computer's answer is known: the owner's pick, else Chat
 * for an agent whose history the computer can read. It also decides whether to subscribe.
 */
export function preferredMode(chosen: ChatMode | null, agentKind: string | undefined): ChatMode {
  return chosen ?? (prefersConversation(agentKind) ? "chat" : "terminal");
}

/**
 * Chat or Terminal, decided only by what the owner chose and what the computer says. No timer
 * takes part: a slow conversation keeps showing its opening placeholder instead of flipping.
 */
export function chatMode(input: ChatModeInput): ChatModeResult {
  // A computer without chat, or one whose owner turned it off, has only the terminal to show.
  if (!input.chatOffered || input.conversationState === "disabled")
    return { mode: "terminal", shows: "terminal" };
  const mode = preferredMode(input.chosen, input.agentKind);
  // The terminal layer carries the ended notice; temporary views are terminal-only.
  if (mode === "terminal" || input.ended || input.temporaryView !== null)
    return { mode, shows: "terminal" };
  switch (input.conversationState) {
    case "ready":
      return { mode, shows: "conversation" };
    case "unavailable":
      return { mode, shows: "unavailable-banner" };
    default:
      return { mode, shows: "opening" };
  }
}
