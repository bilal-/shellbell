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
  | "exited"
  /** A new agent with no conversation yet: an empty chat whose first message starts one. */
  | "start"
  | "terminal";

/** The computer's `SessionInfo.chat`, as far as the mode goes. */
export interface ChatStatus {
  readonly state: "finding" | "found" | "none";
  readonly agent?: string;
  readonly reason?: string;
}

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
  /**
   * The computer's chat status for the session; `undefined` from a computer that doesn't send
   * it, or for a session without an agent.
   */
  readonly chat?: ChatStatus;
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
  chat?: ChatStatus,
): ChatMode {
  if (chosen) return chosen;
  // A chat outlives its agent: after Claude quits, the session still opens in Claude's chat.
  if (chat?.state === "none" && chat.reason === "not-supported") return "terminal";
  return prefersConversation(chat?.agent ?? agentKind) ? "chat" : "terminal";
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
  // The computer's chat status says what there is to show before any conversation message.
  if (input.chat?.state === "none")
    return {
      mode,
      shows:
        input.chat.reason === "agent-exited"
          ? "exited"
          : input.chat.reason === "not-started"
            ? "start"
            : "unavailable-banner",
    };
  if (input.chat?.state === "finding") return { mode, shows: "opening" };
  switch (input.conversationState) {
    case "ready":
      return { mode, shows: "conversation" };
    case "unavailable":
      return { mode, shows: "unavailable-banner" };
    default:
      return { mode, shows: "opening" };
  }
}
