import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentHookScript } from "./agent-hook.js";
import { writeAtomic } from "./codex-integration.js";
import { agentSessionsDir } from "./conversation/agent-sessions.js";

/**
 * Shellbell's Gemini CLI hook. It runs at SessionStart and before each prompt (BeforeAgent),
 * since Gemini's in-app `/resume` switches session without a SessionStart. The hook keeps only
 * the session ID and transcript path; it never stores the prompt BeforeAgent receives.
 */
export const GEMINI_HOOK_NAME = "shellbell-session";
const EVENTS = ["SessionStart", "BeforeAgent"] as const;

export interface GeminiIntegrationPaths {
  /** Gemini's settings file, under `$GEMINI_CLI_HOME` or the home folder. */
  readonly settings: string;
  /** Shellbell's state directory. */
  readonly stateDir: string;
}

export function geminiIntegrationPaths(stateDir: string, home = homedir()): GeminiIntegrationPaths {
  return {
    settings: join(process.env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"),
    stateDir,
  };
}

const scriptPath = (p: GeminiIntegrationPaths) => join(p.stateDir, "gemini-session-hook.sh");
const command = (p: GeminiIntegrationPaths) => `sh '${scriptPath(p).replaceAll("'", `'\\''`)}'`;

type Hook = { name?: unknown; command?: unknown };
type Settings = {
  hooks?: Record<string, { hooks?: Hook[] }[]>;
  hooksConfig?: { enabled?: unknown; disabled?: unknown };
};

/** The settings, or null when the file holds what Shellbell won't rewrite (comments, odd types). */
function readSettings(p: GeminiIntegrationPaths): Settings | null {
  if (!existsSync(p.settings)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(p.settings, "utf8"));
  } catch {
    // Gemini also accepts comments; rewriting the file would drop them.
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settings = value as Settings;
  const hooks = settings.hooks as unknown;
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)))
    return null;
  for (const event of EVENTS) {
    const list = settings.hooks?.[event] as unknown;
    if (list !== undefined && !Array.isArray(list)) return null;
  }
  return settings;
}

const ours = (p: GeminiIntegrationPaths) => (entry: { hooks?: Hook[] }) =>
  entry?.hooks?.some((hook) => hook?.name === GEMINI_HOOK_NAME && hook.command === command(p)) ===
  true;

export interface GeminiIntegrationStatus {
  readonly installed: boolean;
  /**
   * `off`: the owner turned Gemini's hooks off, or disabled Shellbell's in `/hooks`.
   * `unknown`: settings Shellbell won't edit, such as a file with comments.
   */
  readonly hooks: "on" | "off" | "unknown";
}

export function geminiIntegrationStatus(p: GeminiIntegrationPaths): GeminiIntegrationStatus {
  const settings = readSettings(p);
  if (!settings) return { installed: false, hooks: "unknown" };
  const installed =
    EVENTS.every((event) => (settings.hooks?.[event] ?? []).some(ours(p))) &&
    existsSync(scriptPath(p));
  const disabled = settings.hooksConfig?.disabled;
  const off =
    settings.hooksConfig?.enabled === false ||
    (Array.isArray(disabled) && disabled.includes(GEMINI_HOOK_NAME));
  return { installed, hooks: off ? "off" : "on" };
}

/**
 * Adds the hook beside any others, without touching them. Never turns Gemini's hooks on: they
 * are on unless the owner turned them off, and that choice stays.
 */
export function installGeminiIntegration(p: GeminiIntegrationPaths): GeminiIntegrationStatus {
  const before = existsSync(p.settings) ? readFileSync(p.settings, "utf8") : null;
  const settings = readSettings(p);
  if (!settings)
    throw new Error(
      `${p.settings} has comments or settings Shellbell won't rewrite. Remove the comments, then run shellbell agents setup gemini.`,
    );
  const status = geminiIntegrationStatus(p);
  if (status.hooks === "off")
    throw new Error(`Gemini hooks are turned off in ${p.settings}; Shellbell leaves them off.`);
  writeAtomic(
    scriptPath(p),
    agentHookScript("gemini", agentSessionsDir("gemini", p.stateDir)),
    0o700,
  );
  chmodSync(scriptPath(p), 0o700);
  const hooks = { ...settings.hooks };
  for (const event of EVENTS) {
    const entries = hooks[event] ?? [];
    if (!entries.some(ours(p)))
      hooks[event] = [
        ...entries,
        {
          hooks: [{ type: "command", name: GEMINI_HOOK_NAME, command: command(p), timeout: 5000 }],
        },
      ] as { hooks?: Hook[] }[];
  }
  // A running Gemini can rewrite its settings, such as when the model changes; don't race it.
  const now = existsSync(p.settings) ? readFileSync(p.settings, "utf8") : null;
  if (now !== before)
    throw new Error(`${p.settings} changed while Shellbell was editing it. Try again.`);
  writeAtomic(p.settings, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  return geminiIntegrationStatus(p);
}

/** Removes only Shellbell's hook and script; other hooks and settings stay as they are. */
export function uninstallGeminiIntegration(p: GeminiIntegrationPaths): GeminiIntegrationStatus {
  const settings = readSettings(p);
  if (settings?.hooks && EVENTS.some((event) => settings.hooks?.[event]?.some(ours(p)))) {
    const hooks = { ...settings.hooks };
    for (const event of EVENTS) {
      const remaining = (hooks[event] ?? []).filter((entry) => !ours(p)(entry));
      if (remaining.length) hooks[event] = remaining;
      else delete hooks[event];
    }
    const { hooks: _previous, ...rest } = settings;
    const next = Object.keys(hooks).length ? { ...rest, hooks } : rest;
    writeAtomic(p.settings, `${JSON.stringify(next, null, 2)}\n`);
  }
  rmSync(scriptPath(p), { force: true });
  rmSync(agentSessionsDir("gemini", p.stateDir), { recursive: true, force: true });
  return geminiIntegrationStatus(p);
}
