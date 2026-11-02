import {
  CONVERSATION_FEATURE,
  type InnerMessageLooseOf,
  type SessionInfo,
} from "@shellbell/protocol";
import { chosenModeKey, useChosenModes } from "../store/chosen-modes";
import { preferredMode } from "./chat-mode";

/** The parts of a listed session that decide whether it opens in a found chat. */
export type PreopenSession = Pick<SessionInfo, "id" | "instance" | "chat"> & {
  agent?: { kind: string };
};

/**
 * Whether tapping this row should start its chat before the screen is up: the computer offers
 * chat, has found this session's conversation, and the session opens in Chat.
 */
export function opensFoundChat(
  fp: string,
  session: PreopenSession,
  hello: InnerMessageLooseOf<"hello"> | undefined,
): boolean {
  if (session.chat?.state !== "found") return false;
  if (hello?.conversationEnabled !== true || !hello.features?.includes(CONVERSATION_FEATURE))
    return false;
  const chosen = session.instance
    ? (useChosenModes.getState().entries[chosenModeKey(fp, session.id, session.instance)] ?? null)
    : null;
  return preferredMode(chosen, session.agent?.kind, session.chat) === "chat";
}
