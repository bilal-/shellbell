import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** At most this many folders, the limit the transcript readers accept. */
export const CLAUDE_CONFIG_DIRS = 8;
/** `~/.claude-work`, `~/.claude.personal`: profiles people run with `CLAUDE_CONFIG_DIR`. */
const PROFILE = /^\.claude[-_.][A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ClaudeFolders {
  /** Each folder's `projects`, where Claude Code writes transcripts. */
  readonly projects: readonly string[];
  /** Each folder's `sessions`, where it records which process runs which session. */
  readonly sessions: readonly string[];
}

const snapshots = new Map<string, ClaudeFolders>();

/** A real folder this user owns, never a link to one. */
function ownedFolder(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && (process.getuid === undefined || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

/**
 * Claude Code's config folders on this computer. Each Claude process writes its transcripts and
 * session records under the folder its own `CLAUDE_CONFIG_DIR` names, which the service can't
 * see, so every likely folder is searched: the service's own `CLAUDE_CONFIG_DIR`, `~/.claude`,
 * and profile folders such as `~/.claude-work`. A profile found this way counts only as real
 * folders the user owns, and its `projects` and `sessions` are each checked the same way.
 *
 * Read once per service, so the transcript search and the process checks always agree on
 * the folders. A profile first used after the service started is found when it restarts.
 */
export function claudeFolders(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ClaudeFolders {
  const key = `${home}\0${env.CLAUDE_CONFIG_DIR ?? ""}`;
  const cached = snapshots.get(key);
  if (cached) return cached;
  const projects: string[] = [];
  const sessions: string[] = [];
  const seen = new Set<string>();
  const add = (named: string, checked: boolean) => {
    // `~/.claude-work/` and `~/.claude-work` are one folder.
    const dir = resolve(named);
    if (seen.has(dir) || seen.size >= CLAUDE_CONFIG_DIRS) return;
    const project = join(dir, "projects");
    const session = join(dir, "sessions");
    const hasProjects = !checked || ownedFolder(project);
    const hasSessions = !checked || ownedFolder(session);
    if (!hasProjects && !hasSessions) return;
    seen.add(dir);
    if (hasProjects) projects.push(project);
    if (hasSessions) sessions.push(session);
  };
  // Folders named outright keep their earlier behaviour; the readers check what they open.
  if (env.CLAUDE_CONFIG_DIR) add(env.CLAUDE_CONFIG_DIR, false);
  add(join(home, ".claude"), false);
  let names: string[] = [];
  try {
    names = readdirSync(home).filter((name) => PROFILE.test(name));
  } catch {}
  for (const name of names.sort()) {
    const dir = join(home, name);
    if (ownedFolder(dir)) add(dir, true);
  }
  const folders = Object.freeze({
    projects: Object.freeze(projects),
    sessions: Object.freeze(sessions),
  });
  snapshots.set(key, folders);
  return folders;
}

/** The config folders whose `sessions` records can name a process's session. */
export function claudeConfigDirs(): readonly string[] {
  return claudeFolders().sessions.map((sessions) => dirname(sessions));
}
