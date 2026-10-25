import { tokens } from "../theme/tokens";

/** The markers and working colour an agent uses on its own screen. */
export interface AgentStyle {
  readonly prompt: string;
  readonly reply: string;
  readonly replyColor: string;
  readonly step: string;
  readonly working: string;
  readonly workingColor: string;
}

export interface AgentHarness {
  /** The name people know it by, when its command name differs. */
  readonly name?: string;
  /**
   * The view a session opens in. Agents that draw on the alternate screen, such as Claude Code
   * and Codex, keep no terminal scrollback, so Conversation is the only way to read back. Agents
   * that print inline scroll back fine in Terminal, which also shows their exact screen.
   */
  readonly defaultView: "conversation" | "terminal";
  readonly style: AgentStyle;
}

const CLAUDE_STYLE: AgentStyle = {
  prompt: ">",
  reply: "●",
  replyColor: tokens.text,
  step: "●",
  working: "✻",
  workingColor: "#D77757",
};

/**
 * Every agent harness the phone knows, keyed by the kind the computer reports. To add one,
 * add an entry here; an agent missing from it opens in Terminal with Claude Code's markers.
 */
export const AGENT_HARNESSES: Readonly<Record<string, AgentHarness>> = {
  claude: { defaultView: "conversation", style: CLAUDE_STYLE },
  codex: {
    defaultView: "conversation",
    style: {
      prompt: "›",
      reply: "•",
      replyColor: tokens.textMuted,
      step: "•",
      working: "•",
      workingColor: tokens.terminal16[6],
    },
  },
  agy: {
    name: "Antigravity",
    defaultView: "terminal",
    style: {
      prompt: ">",
      reply: "✦",
      replyColor: "#8AB4F8",
      step: "●",
      working: "✦",
      workingColor: "#8AB4F8",
    },
  },
};

export function agentHarness(kind: string | undefined): AgentHarness | undefined {
  const key = kind?.trim().toLowerCase() ?? "";
  return Object.hasOwn(AGENT_HARNESSES, key) ? AGENT_HARNESSES[key] : undefined;
}

export function agentStyle(kind: string | undefined): AgentStyle {
  return agentHarness(kind)?.style ?? CLAUDE_STYLE;
}

/** Whether a session should open in Conversation before the owner picks a view. */
export function prefersConversation(kind: string | undefined): boolean {
  return agentHarness(kind)?.defaultView === "conversation";
}
