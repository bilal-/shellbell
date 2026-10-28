import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentHookScript } from "./agent-hook.js";
import { agentSessionsDir } from "./conversation/agent-sessions.js";

export interface CodexIntegrationPaths {
  /** Codex's home, `$CODEX_HOME` or `~/.codex`. */
  readonly codexHome: string;
  /** Shellbell's state directory. */
  readonly stateDir: string;
}

export function codexIntegrationPaths(stateDir: string, home = homedir()): CodexIntegrationPaths {
  return { codexHome: process.env.CODEX_HOME || join(home, ".codex"), stateDir };
}

const scriptPath = (p: CodexIntegrationPaths) => join(p.stateDir, "codex-session-hook.sh");
const hooksPath = (p: CodexIntegrationPaths) => join(p.codexHome, "hooks.json");
const configPath = (p: CodexIntegrationPaths) => join(p.codexHome, "config.toml");
const command = (p: CodexIntegrationPaths) => `sh '${scriptPath(p).replaceAll("'", `'\\''`)}'`;

type Hooks = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };

function readHooks(p: CodexIntegrationPaths): Hooks {
  if (!existsSync(hooksPath(p))) return {};
  const value: unknown = JSON.parse(readFileSync(hooksPath(p), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${hooksPath(p)} isn't a JSON object; Shellbell left it unchanged.`);
  return value as Hooks;
}

/** Replaces a file in one step, keeping an existing file's permissions. */
export function writeAtomic(path: string, text: string, fallbackMode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : fallbackMode;
  const tmp = `${path}.shellbell-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

const ours = (p: CodexIntegrationPaths) => (entry: { hooks?: { command?: unknown }[] }) =>
  entry.hooks?.some((hook) => hook.command === command(p)) === true;

/** A table header, such as `[features]` or `[ "features" ] # note`, and its name. */
function tableHeader(line: string): string | null {
  const match = /^\[\s*(["']?)([^\]"']+)\1\s*\]\s*(?:#.*)?$/.exec(line.trim());
  return match ? match[2]!.trim() : null;
}

/**
 * Whether Codex's `hooks` feature is on, off or left at Codex's default, or `"unknown"` when the
 * file sets features in a form this line reader can't follow safely (an inline table).
 */
function hooksFeature(p: CodexIntegrationPaths): "on" | "off" | "unset" | "unknown" {
  if (!existsSync(configPath(p))) return "unset";
  let section = "";
  for (const raw of readFileSync(configPath(p), "utf8").split("\n")) {
    const line = raw.trim();
    const header = tableHeader(line);
    if (header !== null) {
      // A subtable such as [features.extra]: features are spread out; leave them be.
      if (header.startsWith("features.")) return "unknown";
      section = header;
      continue;
    }
    const value = /^["']?hooks["']?\s*=\s*(true|false)\b/.exec(line)?.[1];
    if (section === "features" && value) return value === "true" ? "on" : "off";
    const dotted = /^["']?features["']?\s*\.\s*["']?hooks["']?\s*=\s*(true|false)\b/.exec(
      line,
    )?.[1];
    if (section === "" && dotted) return dotted === "true" ? "on" : "off";
    // Features set some other way (an inline table, a header this reader doesn't follow): leave
    // the file alone rather than risk a second table or overriding a choice.
    if (
      /^\[/.test(line)
        ? /features/.test(line) && header === null
        : section === "" && /^["']?features["']?\s*=/.test(line)
    )
      return "unknown";
  }
  return "unset";
}

export interface CodexIntegrationStatus {
  readonly installed: boolean;
  readonly hooksFeature: "on" | "off" | "unset" | "unknown";
}

export function codexIntegrationStatus(p: CodexIntegrationPaths): CodexIntegrationStatus {
  const entries = readHooks(p).hooks?.SessionStart ?? [];
  return {
    installed: entries.some(ours(p)) && existsSync(scriptPath(p)),
    hooksFeature: hooksFeature(p),
  };
}

/**
 * Adds the hook beside any others, without touching them. Codex's `hooks` feature must be on;
 * Shellbell turns it on only when the setting is absent, never against an explicit `false`.
 */
export function installCodexIntegration(p: CodexIntegrationPaths): CodexIntegrationStatus {
  const feature = hooksFeature(p);
  if (feature === "off")
    throw new Error(
      `Codex hooks are turned off in ${configPath(p)} (hooks = false). Turn them on, then run this again.`,
    );
  if (feature === "unknown")
    throw new Error(
      `${configPath(p)} sets features in a form Shellbell won't edit. Add hooks = true to Codex's features, then run this again.`,
    );
  const hooks = readHooks(p);
  writeAtomic(
    scriptPath(p),
    agentHookScript("codex", agentSessionsDir("codex", p.stateDir)),
    0o700,
  );
  chmodSync(scriptPath(p), 0o700);
  const entries = hooks.hooks?.SessionStart ?? [];
  if (!entries.some(ours(p))) {
    const next = {
      ...hooks,
      hooks: {
        ...hooks.hooks,
        SessionStart: [
          ...entries,
          { hooks: [{ type: "command", command: command(p), timeout: 10 }] },
        ],
      },
    };
    writeAtomic(hooksPath(p), `${JSON.stringify(next, null, 2)}\n`);
  }
  if (feature === "unset") {
    const config = existsSync(configPath(p)) ? readFileSync(configPath(p), "utf8") : "";
    const lines = config.split("\n");
    const at = lines.findIndex((line) => tableHeader(line) === "features");
    if (at >= 0) lines.splice(at + 1, 0, "hooks = true");
    else
      lines.push(
        ...(config && !config.endsWith("\n") ? [""] : []),
        "[features]",
        "hooks = true",
        "",
      );
    writeAtomic(configPath(p), lines.join("\n"));
  }
  return codexIntegrationStatus(p);
}

/** Removes only Shellbell's hook and script; other hooks and settings stay as they are. */
export function uninstallCodexIntegration(p: CodexIntegrationPaths): CodexIntegrationStatus {
  const hooks = readHooks(p);
  const entries = hooks.hooks?.SessionStart;
  if (entries?.some(ours(p))) {
    const remaining = entries.filter((entry) => !ours(p)(entry));
    const rest = { ...hooks.hooks };
    if (remaining.length) rest.SessionStart = remaining;
    else delete rest.SessionStart;
    writeAtomic(hooksPath(p), `${JSON.stringify({ ...hooks, hooks: rest }, null, 2)}\n`);
  }
  rmSync(scriptPath(p), { force: true });
  // Records only ever bind panes while the hook writes them; without it they go too.
  rmSync(agentSessionsDir("codex", p.stateDir), { recursive: true, force: true });
  return codexIntegrationStatus(p);
}
