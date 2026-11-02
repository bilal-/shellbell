import type { SessionChat, SessionChatReason } from "@shellbell/protocol";
import { agentName } from "../input/agentPrompt";

const name = (agent: string | undefined) => agentName(agent) ?? "the agent";
const Name = (agent: string | undefined) => agentName(agent) ?? "The agent";

/** One line for a session whose chat the computer has nothing to show for, by its reason. */
export function chatNoneText(
  reason: SessionChatReason | undefined,
  agent: string | undefined,
): string {
  switch (reason) {
    case "no-history":
      return "No chat history for this session yet.";
    case "not-started":
      return `${Name(agent)} has no conversation yet. Your first message starts one.`;
    case "not-supported":
      return `Chat isn’t available for ${name(agent)} yet.`;
    case "lookup-limit":
      return "Too many sessions to find this chat right now.";
    case "ambiguous":
      return "Chat can’t tell which conversation this is.";
    case "agent-exited":
      return `${Name(agent)} exited.`;
    case undefined:
      return "Chat isn’t available right now.";
  }
}

/** The notice when the session's chat is replaced: another agent, or a new conversation. */
export function chatSwitchNotice(
  before: { agent?: string } | null,
  after: { agent?: string },
): string {
  return before?.agent && after.agent && before.agent !== after.agent
    ? `Now ${Name(after.agent)}`
    : "New conversation";
}

/**
 * Why the composer is held in Chat, as its placeholder, or `null` when it may send. Input from
 * Chat names the conversation on screen, so without a found chat there is nothing to name.
 */
export function chatComposerHold(input: {
  shows: string;
  chat: SessionChat | undefined;
  waiting: boolean;
  dimmed: boolean;
  agent: string | undefined;
}): string | null {
  if (input.shows === "terminal") return null;
  if (input.waiting) return "Answer in the terminal";
  // Placeholders are one line; the card or banner above says the rest.
  if (input.shows === "unavailable-banner") return "Chat unavailable";
  // A new agent's empty chat takes its first message.
  if (input.shows === "start") return null;
  const name = agentName(input.agent);
  const opening = name ? `Opening ${name}’s chat…` : "Opening the chat…";
  if (input.dimmed) return opening;
  if (input.chat?.state !== "found") return opening;
  return null;
}
