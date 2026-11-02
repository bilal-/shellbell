import { agentHarness } from "../agents/registry";

/**
 * The agent's name for the command bar: `claude` reads "Claude", `codex` "Codex". A kind that is
 * not a plain word (or says nothing, like `unknown`) gets no name, and the bar says "the agent".
 */
export function agentName(kind: string | undefined): string | null {
  const name = kind?.trim() ?? "";
  const known = agentHarness(name)?.name;
  if (known) return known;
  if (!/^[a-z][a-z0-9]*(?:[- .][a-z0-9]+)*$/i.test(name) || name.length > 20) return null;
  if (/^(?:unknown|agent|none)$/i.test(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function agentPlaceholder(kind: string | undefined): string {
  return `Message ${agentName(kind) ?? "the agent"}…`;
}

export {
  type BlockedPrompt,
  blockedPrompt,
  MENU_LABEL_MAX,
  type MenuOption,
  type PromptEvidence,
  promptEvidence,
  provenQuestion,
  QUESTION_MAX,
} from "@shellbell/protocol";
