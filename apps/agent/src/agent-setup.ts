import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentHookScript } from "./agent-hook.js";
import {
  type CodexIntegrationPaths,
  codexIntegrationPaths,
  codexIntegrationStatus,
  installCodexIntegration,
  uninstallCodexIntegration,
} from "./codex-integration.js";
import { agentHelperDir, agentRecordsDir, type HookAgent } from "./conversation/agent-sessions.js";
import {
  type GeminiIntegrationPaths,
  geminiIntegrationPaths,
  geminiIntegrationStatus,
  installGeminiIntegration,
  uninstallGeminiIntegration,
} from "./gemini-integration.js";
import { privateDirectory } from "./host-files.js";

/**
 * The coding agents found on this computer, and whether the phone can show each one's whole
 * session in text sized for it. The Mac app, the command line and Linux all read this one list.
 *
 * - `ready`: full history works now.
 * - `needs-setup`: a small helper has to be added first (Codex and Gemini).
 * - `hooks-off`: the owner turned the agent's hooks off; Shellbell leaves them off.
 * - `blocked`: the agent's settings are in a form Shellbell won't edit; `detail` says what to do.
 * - `coming-soon`: found, but Shellbell can't read its history yet, so it opens as a terminal.
 */
export type AgentSetupState = "ready" | "needs-setup" | "hooks-off" | "blocked" | "coming-soon";

export interface AgentSetupEntry {
  readonly kind: string;
  readonly name: string;
  readonly state: AgentSetupState;
  /** Whether Shellbell added a helper to this agent, so it can be removed. */
  readonly helper: boolean;
  /** Set up was offered and skipped; the owner isn't asked again for this agent. */
  readonly skipped: boolean;
  readonly detail?: string;
}

export interface AgentSetupPaths {
  readonly stateDir: string;
  /** Where setup's own files live (`agentHelperDir`); never the Linux state folder. */
  readonly helperDir: string;
  readonly home: string;
  readonly codex: CodexIntegrationPaths;
  readonly gemini: GeminiIntegrationPaths;
  readonly claudeDir: string;
}

export function agentSetupPaths(
  stateDir: string,
  home = homedir(),
  platform = process.platform,
): AgentSetupPaths {
  const helperDir = agentHelperDir(stateDir, platform);
  return {
    stateDir,
    helperDir,
    home,
    codex: codexIntegrationPaths(stateDir, home, helperDir),
    gemini: geminiIntegrationPaths(stateDir, home, helperDir),
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
  };
}

/**
 * Agents Shellbell can't read yet, found by the folder each keeps in the home folder. The same
 * folders Herdr's integrations use; agents without a known folder are only seen while running.
 */
const COMING_SOON: readonly (readonly [kind: string, name: string, folder: string])[] = [
  ["cursor", "Cursor", ".cursor/cli-config.json"],
  ["copilot", "Copilot", ".copilot"],
  ["opencode", "OpenCode", ".config/opencode"],
  ["pi", "Pi", ".pi/agent"],
  ["omp", "Oh My Pi", ".omp/agent"],
  ["devin", "Devin", ".config/devin"],
  ["droid", "Droid", ".factory"],
  ["kimi", "Kimi", ".kimi-code"],
  ["kilo", "Kilo Code", ".config/kilo"],
  ["hermes", "Hermes", ".hermes"],
  ["qodercli", "Qoder", ".qoder"],
  ["qwen", "Qwen", ".qwen"],
  ["mastracode", "Mastra Code", ".mastracode"],
  ["grok", "Grok", ".grok"],
  ["letta", "Letta", ".letta"],
];

const recordPath = (p: AgentSetupPaths) => join(p.helperDir, "agent-setup.json");

function skippedKinds(p: AgentSetupPaths): Set<string> {
  try {
    const value: unknown = JSON.parse(readFileSync(recordPath(p), "utf8"));
    const skipped = (value as { skipped?: unknown } | null)?.skipped;
    return new Set(Array.isArray(skipped) ? skipped.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Setup can run before the service has ever started, so it may create its helper folder: on
 * macOS the state folder, on Linux a folder beside it, leaving the state folder for host
 * initialization. Either way it holds a script agents run, so it must be this user's private,
 * real folder (`privateDirectory`): one someone else made first, such as under /tmp, is refused.
 */
function helperDir(p: AgentSetupPaths): void {
  mkdirSync(p.helperDir, { recursive: true, mode: 0o700 });
  try {
    privateDirectory(p.helperDir, process.getuid?.() ?? -1);
  } catch {
    throw new Error(
      `${p.helperDir} isn't a private folder of yours, so Shellbell won't put agent helpers there.`,
    );
  }
}

function saveSkipped(p: AgentSetupPaths, skipped: Set<string>): void {
  if (!skipped.size) {
    rmSync(recordPath(p), { force: true });
    return;
  }
  helperDir(p);
  const tmp = `${recordPath(p)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, skipped: [...skipped].sort() })}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, recordPath(p));
}

function codexEntry(p: AgentSetupPaths, skipped: boolean): AgentSetupEntry {
  const base = { kind: "codex", name: "Codex", skipped };
  try {
    const status = codexIntegrationStatus(p.codex);
    if (status.installed)
      return status.hooksFeature === "off"
        ? { ...base, state: "hooks-off", helper: true }
        : { ...base, state: "ready", helper: true };
    if (status.hooksFeature === "off") return { ...base, state: "hooks-off", helper: false };
    if (status.hooksFeature === "unknown")
      return {
        ...base,
        state: "blocked",
        helper: false,
        detail: `Add hooks = true to the [features] section of ${join(p.codex.codexHome, "config.toml")}.`,
      };
    return { ...base, state: "needs-setup", helper: false };
  } catch (error) {
    return {
      ...base,
      state: "blocked",
      helper: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function geminiEntry(p: AgentSetupPaths, skipped: boolean): AgentSetupEntry {
  const base = { kind: "gemini", name: "Gemini", skipped };
  const status = geminiIntegrationStatus(p.gemini);
  if (status.hooks === "unknown")
    return {
      ...base,
      state: "blocked",
      helper: false,
      detail: `${p.gemini.settings} has comments or settings Shellbell won't rewrite. Remove the comments, then run shellbell agents setup gemini.`,
    };
  if (status.hooks === "off") return { ...base, state: "hooks-off", helper: status.installed };
  return { ...base, state: status.installed ? "ready" : "needs-setup", helper: status.installed };
}

/** Every agent found on this computer, full-history agents first. Reads only; changes nothing. */
export function detectAgents(p: AgentSetupPaths): AgentSetupEntry[] {
  const skipped = skippedKinds(p);
  const found: AgentSetupEntry[] = [];
  const plain = { helper: false, skipped: false };
  if (existsSync(p.claudeDir))
    found.push({ kind: "claude", name: "Claude Code", state: "ready", ...plain });
  if (existsSync(p.codex.codexHome)) found.push(codexEntry(p, skipped.has("codex")));
  if (existsSync(join(p.home, ".gemini", "antigravity-cli")))
    found.push({ kind: "agy", name: "Antigravity", state: "ready", ...plain });
  // Gemini CLI keeps its sessions under ~/.gemini/tmp; Antigravity alone doesn't create it.
  if (existsSync(join(p.gemini.settings, "..", "tmp")))
    found.push(geminiEntry(p, skipped.has("gemini")));
  for (const [kind, name, folder] of COMING_SOON)
    if (existsSync(join(p.home, folder)))
      found.push({ kind, name, state: "coming-soon", ...plain });
  return found;
}

/** Agents to offer set up for: they need a helper, and the owner hasn't skipped them. */
export function agentsToOffer(agents: readonly AgentSetupEntry[]): AgentSetupEntry[] {
  return agents.filter((agent) => agent.state === "needs-setup" && !agent.skipped);
}

/**
 * Adds the helper to each named agent that needs one, or to every such agent when `kinds` is
 * absent. Never turns on hooks the owner turned off. Throws with a plain reason if an agent's
 * settings can't be changed; agents already done stay done.
 */
export function setupAgents(p: AgentSetupPaths, kinds?: readonly string[]): AgentSetupEntry[] {
  const wanted = (kind: string) => !kinds || kinds.includes(kind);
  helperDir(p);
  const skipped = skippedKinds(p);
  for (const agent of detectAgents(p)) {
    if (!wanted(agent.kind)) continue;
    skipped.delete(agent.kind);
    if (agent.state !== "needs-setup") continue;
    if (agent.kind === "codex") installCodexIntegration(p.codex);
    if (agent.kind === "gemini") installGeminiIntegration(p.gemini);
  }
  saveSkipped(p, skipped);
  return detectAgents(p);
}

/** Records that the owner chose not to set these agents up, so they aren't asked again. */
export function skipAgentSetup(p: AgentSetupPaths, kinds: readonly string[]): AgentSetupEntry[] {
  const skipped = skippedKinds(p);
  for (const kind of kinds) skipped.add(kind);
  saveSkipped(p, skipped);
  return detectAgents(p);
}

/** Takes Shellbell's helper back out of an agent; its other settings stay as they are. */
export function removeAgentSetup(p: AgentSetupPaths, kind: string): AgentSetupEntry[] {
  if (kind === "codex") uninstallCodexIntegration(p.codex);
  if (kind === "gemini") uninstallGeminiIntegration(p.gemini);
  // Removing is a choice too: don't offer it again until the owner sets it up.
  return skipAgentSetup(p, [kind]);
}

/**
 * Brings Shellbell's own helper scripts up to date after an update, so an older helper (which
 * kept more of its input) is replaced. Only rewrites a script Shellbell already installed, in
 * Shellbell's state folder; never touches an agent's own settings.
 */
export function refreshAgentHooks(p: AgentSetupPaths): void {
  for (const agent of ["codex", "gemini"] as const satisfies readonly HookAgent[]) {
    const script = join(p.helperDir, `${agent}-session-hook.sh`);
    try {
      const current = agentHookScript(agent, agentRecordsDir(p.helperDir, agent));
      if (existsSync(script) && readFileSync(script, "utf8") !== current) {
        const tmp = `${script}.${process.pid}.tmp`;
        writeFileSync(tmp, current, { mode: 0o700 });
        renameSync(tmp, script);
      }
    } catch {
      // The old script keeps working; the next setup writes it again.
    }
  }
}

/** One line per agent, in the words the command line, Settings and the phone share. */
export function agentSetupLine(agent: AgentSetupEntry): string {
  switch (agent.state) {
    case "ready":
      return agent.kind === "codex"
        ? "Ready. Codex sessions started from now on show their full history. If Codex asks, trust Shellbell's helper."
        : agent.kind === "gemini"
          ? "Ready. Gemini sessions started from now on show their full history."
          : "Ready.";
    case "needs-setup":
      return "Needs a small helper for full history on your phone.";
    case "hooks-off":
      return agent.kind === "gemini"
        ? "Gemini hooks are turned off (in Gemini's settings.json or its /hooks list), so its sessions open as a terminal."
        : "Codex hooks are turned off (hooks = false in Codex's config.toml), so its sessions open as a terminal.";
    case "blocked":
      return agent.detail ?? "Shellbell couldn't change this agent's settings.";
    case "coming-soon":
      return "Full history coming soon. Opens as a terminal for now.";
  }
}
