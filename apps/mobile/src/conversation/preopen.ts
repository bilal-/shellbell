import {
  CONVERSATION_FEATURE,
  type InnerMessageLooseOf,
  type SessionInfo,
} from "@shellbell/protocol";
import { chosenModeKey, useChosenModes } from "../store/chosen-modes";
import { type ChatMode, preferredMode } from "./chat-mode";

/** The parts of a listed session that decide whether it opens in a found chat. */
export type PreopenSession = Pick<SessionInfo, "id" | "instance" | "chat"> & {
  agent?: { kind: string };
};

/** Whether the computer offers chat: it speaks the conversation protocol and the owner turned it on. */
export function offersChat(hello: InnerMessageLooseOf<"hello"> | undefined): boolean {
  return (
    hello?.conversationEnabled === true && hello.features?.includes(CONVERSATION_FEATURE) === true
  );
}

/** Whether tapping this row opens it in Chat: what the owner chose, else what its agent opens in. */
export function opensInChat(
  fp: string,
  session: PreopenSession,
  hello: InnerMessageLooseOf<"hello"> | undefined,
  /** The owner's saved picks; a screen that shows the answer passes the ones it subscribes to. */
  picks: Readonly<Record<string, ChatMode>> = useChosenModes.getState().entries,
): boolean {
  if (!offersChat(hello)) return false;
  const chosen = session.instance
    ? (picks[chosenModeKey(fp, session.id, session.instance)] ?? null)
    : null;
  return preferredMode(chosen, session.agent?.kind, session.chat) === "chat";
}

/**
 * Whether tapping this row should start its chat before the screen is up: it opens in Chat and
 * the computer has found the session's conversation.
 */
export function opensFoundChat(
  fp: string,
  session: PreopenSession,
  hello: InnerMessageLooseOf<"hello"> | undefined,
): boolean {
  return session.chat?.state === "found" && opensInChat(fp, session, hello);
}
