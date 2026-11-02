import { type BlockedPrompt, promptEvidence, provenQuestion } from "../input/agentPrompt";

export interface AgentWaiting {
  readonly question: string | null;
}

/**
 * Whether Chat should stop and send the owner to the terminal: the computer reports the session
 * as blocked, or its screen shows a menu or a y/n prompt. An unknown state never blocks, and a
 * password prompt is left to Secret input.
 */
export function agentWaiting(input: {
  sessionState: string | undefined;
  prompt: BlockedPrompt | null;
  secret: boolean;
}): AgentWaiting | null {
  if (input.secret) return null;
  const evidence = input.prompt ? promptEvidence(input.prompt) : null;
  if (input.sessionState !== "blocked" && !evidence) return null;
  return { question: input.prompt ? provenQuestion(input.prompt) : null };
}
