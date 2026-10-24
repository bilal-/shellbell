import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  encodeCbor,
  type InnerMessageOf,
  MAX_TERMINAL_MESSAGE_BYTES,
  type SessionInfo,
} from "@shellbell/protocol";
import {
  cleanLabel,
  commandName,
  type GitContextReader,
  GUEST_COMMANDS,
  SHELL_COMMANDS,
} from "./notification-context.js";

/**
 * How the phone names a session, shared by every backend:
 *
 * - `project` is the row title: a deliberate manual name (a renamed tmux window, a Herdr
 *   workspace label), else the folder name, which the agent upgrades to the Git top level for
 *   sessions whose directory is on this computer (`ProjectNames`).
 * - `agent` appears only for a recognised coding agent; `task` is the text it puts in the terminal
 *   title, with status glyphs and Codex's trailing ` | <project>` removed.
 *
 * Every value is one bounded line from `cleanLabel`: no control or bidi characters, and text that
 * looks like a path or remote origin is omitted rather than shown.
 */
export type SessionNaming = Pick<SessionInfo, "project" | "agent">;

export const PROJECT_MAX = 128;
export const KIND_MAX = 32;
export const TASK_MAX = 256;

/**
 * Status glyphs coding agents put before the task in a terminal title: Braille spinners
 * (U+2800-28FF), quarter circles, the Claude Code stars, middle dot, bullet and asterisk.
 */
const GLYPHS = "\\u2800-\\u28FF\\u25D0-\\u25D3\\u2722\\u2733\\u2736\\u273B\\u273D\\u00B7\\u2022*";
const LEADING_STATUS = new RegExp(`^[${GLYPHS}][${GLYPHS}\\uFE0F]*\\s+(?=\\S)`, "u");
const BRAILLE_LEAD = /^[⠀-⣿]/u;
const VERSION = /^v?\d+(?:\.\d+)+$/;

/** A title without its leading status glyph run; titles without one are only trimmed. */
export function stripStatusGlyphs(title: string): string {
  const trimmed = title.trim();
  return trimmed.replace(LEADING_STATUS, "");
}

function hasStatusGlyph(title: string | undefined): boolean {
  const trimmed = title?.trim() ?? "";
  return LEADING_STATUS.test(trimmed);
}

/** A stable lowercase agent kind for well-known agents; any other name is cleaned and bounded. */
export function agentKind(raw: string | undefined): string | undefined {
  const name = raw?.trim().toLowerCase() ?? "";
  if (/^claude(?:[- ]code)?$/.test(name)) return "claude";
  if (/^codex(?:[- ]cli)?$/.test(name)) return "codex";
  return cleanLabel(name, KIND_MAX);
}

/**
 * The agent a terminal is running, from its foreground process or, when that is only a runtime
 * (Claude Code often appears as `node` or its own version number) or unknown, from the agent's
 * characteristic title: a status glyph followed by the task. A shell or other program in the
 * foreground is never an agent, whatever its title says.
 */
export function detectAgent(
  processName: string | undefined,
  title: string | undefined,
): string | undefined {
  const command = commandName(processName).toLowerCase();
  if (command === "claude" || command === "codex" || command === "agy") return command;
  if (command !== "" && command !== "node" && !VERSION.test(command)) return undefined;
  if (!hasStatusGlyph(title)) return undefined;
  const text = title?.trim() ?? "";
  // Codex titles read `<spinner> <task> | <project>`; Claude Code has no project suffix.
  return BRAILLE_LEAD.test(text) && / \| [^|]+$/.test(text) ? "codex" : "claude";
}

/** The last folder of `cwd`, `~` for the home folder, nothing for a root. */
export function projectFromCwd(cwd: string | undefined, home = homedir()): string | undefined {
  if (!cwd) return undefined;
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  if (home && trim(cwd) === trim(home)) return "~";
  const last = trim(cwd).split(/[\\/]/).pop();
  return cleanLabel(last, PROJECT_MAX);
}

/** Names tmux's automatic-rename produces or leaves behind: never treated as manual. */
const AUTOMATIC_NAMES: ReadonlySet<string> = new Set([
  ...SHELL_COMMANDS,
  "claude",
  "codex",
  "agy",
  "node",
  "tmux",
  "[tmux]",
]);

/**
 * A tmux window name the user chose. automatic-rename writes the foreground command, so a name
 * equal to it, a shell or agent name, or a version number (Claude Code's process name) is
 * automatic; a lagging rename can briefly leave the previous command, which this also covers.
 */
export function manualWindowName(windowName: string, command: string): string | undefined {
  const name = windowName.trim();
  if (!name || name === command || name.endsWith("[dead]")) return undefined;
  if (AUTOMATIC_NAMES.has(name.toLowerCase()) || VERSION.test(name)) return undefined;
  return cleanLabel(name, PROJECT_MAX);
}

/**
 * Whether a session's directory describes this computer, so Git may be asked about it: a shell or
 * agent is in the foreground. `ssh`, containers and unknown programs are not asked.
 */
export function localProjectCommand(processName: string | undefined): boolean {
  const command = commandName(processName).toLowerCase();
  if (!command || GUEST_COMMANDS.has(command)) return false;
  return (
    SHELL_COMMANDS.has(command) ||
    command === "claude" ||
    command === "codex" ||
    command === "node" ||
    VERSION.test(command)
  );
}

function taskText(
  raw: string | undefined,
  kind: string,
  context: { project?: string; folder?: string; command?: string; ignore?: readonly string[] },
): string | undefined {
  if (!raw) return undefined;
  let text = stripStatusGlyphs(raw.replace(/[\r\n\t]+/g, " "));
  // iTerm2 can append the job to a session name: `✳ Fix it (claude)`.
  if (context.command) {
    const job = ` (${context.command})`;
    if (text.endsWith(job)) text = text.slice(0, -job.length).trimEnd();
  }
  const suffix = / \| ([^|]+)$/.exec(text);
  if (
    suffix &&
    (kind === "codex" ||
      suffix[1]?.trim() === context.project ||
      suffix[1]?.trim() === context.folder)
  )
    text = text.slice(0, suffix.index).trimEnd();
  const clean = cleanLabel(text, TASK_MAX);
  if (!clean) return undefined;
  const lower = clean.toLowerCase();
  const repeats = [kind, "claude", "claude code", "codex", ...(context.ignore ?? [])];
  if (repeats.some((name) => name.toLowerCase() === lower)) return undefined;
  return clean;
}

export function sameNaming(a: SessionNaming, b: SessionNaming): boolean {
  return (
    a.project === b.project && a.agent?.kind === b.agent?.kind && a.agent?.task === b.agent?.task
  );
}

function withAgent(project: string | undefined, kind: string | undefined, task?: string) {
  const out: SessionNaming = {};
  if (project) out.project = project;
  if (kind) out.agent = task ? { kind, task } : { kind };
  return out;
}

/**
 * tmux and iTerm2: `project` is a manual name when the backend has one, else the folder name;
 * the agent comes from the foreground process or title (`detectAgent`).
 */
export function nameSession(input: {
  cwd?: string;
  /** A deliberate name, already established as manual by the backend. */
  project?: string;
  processName?: string;
  title?: string;
  /** Default titles that are not a task, such as tmux's host-name pane title. */
  ignore?: readonly string[];
}): SessionNaming {
  const folder = projectFromCwd(input.cwd);
  const project = cleanLabel(input.project, PROJECT_MAX) ?? folder;
  const kind = detectAgent(input.processName, input.title);
  if (!kind) return withAgent(project, undefined);
  const command = commandName(input.processName);
  const task = taskText(input.title, kind, {
    project,
    folder,
    command: command || undefined,
    ignore: input.ignore,
  });
  return withAgent(project, kind, task);
}

/** The Herdr pane fields naming reads; tokens and other display-only fields are ignored. */
export interface HerdrNamingPane {
  agent?: string | null;
  display_agent?: string | null;
  label?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
}

/**
 * Herdr: the workspace label is the project (Herdr names workspaces after their repository unless
 * the user renames one); the pane's own `agent` names the agent and its `label` is the task.
 */
export function herdrNaming(pane: HerdrNamingPane, workspaceLabel: string | undefined) {
  const folder = projectFromCwd(pane.foreground_cwd ?? pane.cwd ?? undefined);
  const project = cleanLabel(workspaceLabel, PROJECT_MAX) ?? folder;
  const kind = agentKind(pane.agent || pane.display_agent || undefined);
  if (!kind) return withAgent(project, undefined);
  const raw = pane.label || pane.terminal_title_stripped || pane.terminal_title || undefined;
  const ignore = pane.display_agent ? [pane.display_agent] : [];
  return withAgent(project, kind, taskText(raw, kind, { project, folder, ignore }));
}

const PROJECT_TTL_MS = 30_000;
const MAX_LOOKUPS = 16;
const MAX_REMEMBERED = 256;

/**
 * Git top-level names for local session folders. Session lists never wait for Git: `lookup`
 * answers from memory (a stale answer included) and starts a bounded background lookup, then
 * `onChange` asks for a fresh list once an answer differs from what was shown.
 */
export class ProjectNames {
  private readonly known = new Map<string, { project: string | null; at: number }>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly git: GitContextReader,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.known.size;
  }

  lookup(cwd: string): string | undefined {
    if (!isAbsolute(cwd) || cwd.length > 1024) return undefined;
    const hit = this.known.get(cwd);
    const at = this.now();
    if (!hit || at < hit.at || at - hit.at >= PROJECT_TTL_MS) this.refresh(cwd, hit?.project);
    return hit?.project ?? undefined;
  }

  private refresh(cwd: string, shown: string | null | undefined): void {
    if (this.pending.has(cwd) || this.pending.size >= MAX_LOOKUPS) return;
    this.pending.add(cwd);
    const controller = new AbortController();
    let lookup: Promise<Awaited<ReturnType<GitContextReader>>>;
    try {
      lookup = this.git(cwd, controller.signal);
    } catch {
      lookup = Promise.resolve(undefined);
    }
    void lookup
      .catch(() => undefined)
      .then((context) => {
        const project = cleanLabel(context?.repository, PROJECT_MAX) ?? null;
        this.known.delete(cwd);
        while (this.known.size >= MAX_REMEMBERED) {
          const oldest = this.known.keys().next().value;
          if (oldest === undefined) break;
          this.known.delete(oldest);
        }
        this.known.set(cwd, { project, at: this.now() });
        if (project !== (shown ?? null)) this.onChange();
      })
      .finally(() => {
        this.pending.delete(cwd);
        controller.abort();
      });
  }
}

/**
 * A session list message that fits one terminal message. Display names are optional, so when a
 * long list would not fit, task text goes first, then the other names, then folders and long
 * titles; phones then show the shortened title. A list that still does not fit keeps the sessions
 * that do, in order, rather than sending none.
 */
export function fitSessionList(
  list: SessionInfo[],
  limit = MAX_TERMINAL_MESSAGE_BYTES,
): InnerMessageOf<"sessions"> {
  const fits = (candidate: SessionInfo[]) =>
    encodeCbor({ type: "sessions", list: candidate }).length <= limit;
  const tiers: ((s: SessionInfo) => SessionInfo)[] = [
    ({ agent, ...rest }) => (agent ? { ...rest, agent: { kind: agent.kind } } : rest),
    ({ project: _p, windowLabel: _w, agent: _a, ...rest }) => rest,
    ({ project: _p, windowLabel: _w, agent: _a, cwd: _c, title, ...rest }) => ({
      ...rest,
      title: Array.from(title).slice(0, SHORT_TITLE).join(""),
    }),
  ];
  if (fits(list)) return { type: "sessions", list };
  let fitted = list;
  for (const tier of tiers) {
    fitted = list.map(tier);
    if (fits(fitted)) return { type: "sessions", list: fitted };
  }
  let low = 0;
  let high = fitted.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(fitted.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  return { type: "sessions", list: fitted.slice(0, low) };
}

/** Title length kept when a long session list must shed bytes. */
const SHORT_TITLE = 64;
