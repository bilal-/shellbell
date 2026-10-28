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
   * The view a session opens in: Chat for every agent whose full history the computer can read,
   * since it is the easiest to read on a phone and scrolls back to the start. Terminal, which
   * shows the computer's exact screen, stays one tap away. Agents without a reader open there.
   */
  readonly defaultView: "conversation" | "terminal";
  /** The agent's brand colour, as Herdr's agent sidebar uses it. */
  readonly color: string;
  /** One or two letters shown in the agent's colour until a licensed logo ships. */
  readonly mark: string;
  readonly style?: AgentStyle;
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
  claude: { defaultView: "conversation", color: "#D97757", mark: "C", style: CLAUDE_STYLE },
  codex: {
    defaultView: "conversation",
    color: "#E8E8ED",
    mark: "Cx",
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
    defaultView: "conversation",
    color: "#4285F4",
    mark: "A",
    style: {
      prompt: ">",
      reply: "✦",
      replyColor: "#8AB4F8",
      step: "●",
      working: "✦",
      workingColor: "#8AB4F8",
    },
  },
  gemini: {
    name: "Gemini",
    defaultView: "conversation",
    color: "#4285F4",
    mark: "G",
    style: {
      prompt: ">",
      reply: "✦",
      replyColor: "#8AB4F8",
      step: "●",
      working: "✦",
      workingColor: "#8AB4F8",
    },
  },
  // Recognised by the computer (from Herdr's list); Terminal until each has a transcript adapter.
  cursor: { name: "Cursor", defaultView: "terminal", color: "#E8E8ED", mark: "Cu" },
  copilot: { name: "Copilot", defaultView: "terminal", color: "#E8E8ED", mark: "Co" },
  opencode: { name: "OpenCode", defaultView: "terminal", color: "#E8E8ED", mark: "O" },
  pi: { name: "Pi", defaultView: "terminal", color: "#E8E8ED", mark: "π" },
  omp: { name: "Oh My Pi", defaultView: "terminal", color: "#E8E8ED", mark: "π" },
  devin: { name: "Devin", defaultView: "terminal", color: "#4D6BFE", mark: "D" },
  cline: { name: "Cline", defaultView: "terminal", color: "#586876", mark: "Cl" },
  mastracode: { name: "Mastra Code", defaultView: "terminal", color: "#E8E8ED", mark: "M" },
  kimi: { name: "Kimi", defaultView: "terminal", color: "#1783FF", mark: "K" },
  kiro: { name: "Kiro", defaultView: "terminal", color: "#9046FF", mark: "Ki" },
  droid: { name: "Droid", defaultView: "terminal", color: "#E8E8ED", mark: "Dr" },
  amp: { name: "Amp", defaultView: "terminal", color: "#E8E8ED", mark: "Am" },
  grok: { name: "Grok", defaultView: "terminal", color: "#E8E8ED", mark: "Gk" },
  hermes: { name: "Hermes", defaultView: "terminal", color: "#E8E8ED", mark: "H" },
  kilo: { name: "Kilo Code", defaultView: "terminal", color: "#9A9808", mark: "Kl" },
  qodercli: { name: "Qoder", defaultView: "terminal", color: "#E8E8ED", mark: "Q" },
  qwen: { name: "Qwen", defaultView: "terminal", color: "#615CED", mark: "Qw" },
  letta: { name: "Letta", defaultView: "terminal", color: "#E8E8ED", mark: "L" },
  maki: { name: "Maki", defaultView: "terminal", color: "#E8E8ED", mark: "Mk" },
  muse: { name: "Muse", defaultView: "terminal", color: "#0082FB", mark: "Mu" },
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
