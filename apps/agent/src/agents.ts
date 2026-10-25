/**
 * Coding agents Shellbell recognises, keyed by the canonical kind sent to the phone. Mirrors
 * Herdr's agent list (`src/detect/mod.rs` in herdrdev/herdr), so a tmux or iTerm2 session and a
 * Herdr pane running the same agent report the same kind. To add an agent, add its kind and
 * every command name or label it can appear as; the phone's agent registry gives it a name,
 * mark and default view.
 */
export const AGENTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude", "claude-code", "claude code"],
  codex: ["codex", "codex-cli", "codex cli"],
  agy: ["agy", "antigravity", "antigravity-cli"],
  gemini: ["gemini", "gemini-cli"],
  cursor: ["cursor", "cursor-agent"],
  copilot: ["copilot", "github-copilot", "ghcs"],
  opencode: ["opencode", "opencode2", "open-code"],
  pi: ["pi"],
  omp: ["omp"],
  devin: ["devin", "devin-cli", "devin cli"],
  cline: ["cline", ".cline"],
  mastracode: ["mastracode", "mastra-code", "mastra code"],
  kimi: ["kimi", "kimi-code", "kimi code"],
  kiro: ["kiro", "kiro-cli"],
  droid: ["droid"],
  amp: ["amp", "amp-local"],
  grok: ["grok", "grok-build"],
  hermes: ["hermes", "hermes-agent"],
  kilo: ["kilo", "kilo-code", "kilo code"],
  qodercli: ["qodercli", "qoderclicn", "qoder", "qodercn"],
  qwen: ["qwen", "qwen-code", "qwen code"],
  letta: ["letta", "letta-code", "letta code"],
  maki: ["maki"],
  muse: ["muse", "muse-code", "muse-cli"],
};

const LOOKUP = new Map(
  Object.entries(AGENTS).flatMap(([kind, names]) => names.map((name) => [name, kind] as const)),
);

/**
 * The canonical kind for a command name or agent label, or undefined for shells and other
 * programs. Paths and Windows suffixes are ignored, as Herdr does.
 */
export function canonicalAgent(name: string | undefined | null): string | undefined {
  const base = (name ?? "")
    .trim()
    .toLowerCase()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|exe)$/, "");
  if (!base) return undefined;
  // Muse's launcher execs `muse-bin-<version>`; require a digit so `muse-binary` stays unmatched.
  if (/^muse-bin-\d/.test(base)) return "muse";
  return LOOKUP.get(base);
}
