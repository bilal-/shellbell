import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * Codex 0.166 and later run every session inside one shared background process, so the hook
 * Shellbell adds (`agent-hook.ts`) runs there, with no terminal, and can't say which pane shows
 * which session. Each Codex window still names its session in its own title, by default its
 * activity, the session's name and its project: `⠋ Fix the login | shellbell`.
 *
 * A pane whose foreground process is Codex shows a session only when its title names exactly
 * one of Codex's named sessions whose project, and folder when the pane reports one, agree.
 * Anything less certain stays a terminal: a session not named yet, a title the owner set up
 * differently, or two sessions with one name in one project.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codex's default title parts and their limits (`codex-rs/tui/src/chatwidget/status_surfaces.rs`). */
const NAME_CHARS = 48;
const PROJECT_CHARS = 24;
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /;
const ACTION_REQUIRED = /^\[ [!.] \] Action Required \| /;
const INDEX_BYTES = 4 * 1024 * 1024;
const META_BYTES = 1024 * 1024;
const LOAD_MS = 1000;
const MISSING_MS = 10_000;
const THREADS = 1024;

/** A title's session name and project, without Codex's activity marks, or null. */
export function codexTitleParts(title: string): { name: string; project: string } | null {
  let rest = title.trim();
  // Listening for speech adds a dot; activity adds a spinner frame or a blinking prompt.
  if (rest.startsWith("● ")) rest = rest.slice(2);
  else if (rest === "●") return null;
  rest = rest.replace(SPINNER, "").replace(ACTION_REQUIRED, "");
  const at = rest.lastIndexOf(" | ");
  if (at <= 0) return null;
  const name = rest.slice(0, at);
  const project = rest.slice(at + 3);
  return project && !project.includes(" | ") ? { name, project } : null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Codex's own shortening: at most `max` characters, the last three `...` when cut. */
function shortened(value: string, max: number): string {
  const parts = [...segmenter.segment(value)].map((part) => part.segment);
  return parts.length <= max ? value : `${parts.slice(0, max - 3).join("")}...`;
}

/** The names Codex can show as a folder's project: the folder or a Git checkout holding it. */
function projectNames(cwd: string, exists: (path: string) => boolean): Set<string> {
  const names = new Set([shortened(basename(cwd), PROJECT_CHARS)]);
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir))
    if (exists(join(dir, ".git"))) names.add(shortened(basename(dir), PROJECT_CHARS));
  return names;
}

/** The first line of a file, read in bounded pieces, or null past `META_BYTES`. */
function firstLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < META_BYTES) {
      const chunk = Buffer.alloc(64 * 1024);
      const read = readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const end = chunk.subarray(0, read).indexOf(10);
      chunks.push(chunk.subarray(0, end < 0 ? read : end));
      total += read;
      if (end >= 0) return Buffer.concat(chunks).toString("utf8");
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function localDay(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return join(String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
}

export interface CodexThreadsOptions {
  readonly now?: () => number;
  readonly exists?: (path: string) => boolean;
}

export class CodexThreads {
  private stamp = "";
  private loadedAt = Number.NEGATIVE_INFINITY;
  /** Each named session's current name, from Codex's `session_index.jsonl`. */
  private names = new Map<string, string>();
  /** Each session's folder, which never changes; null while its record can't be found. */
  private folders = new Map<string, { cwd: string | null; at: number }>();
  private readonly now: () => number;
  private readonly exists: (path: string) => boolean;

  constructor(
    private readonly home: string,
    options: CodexThreadsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.exists = options.exists ?? existsSync;
  }

  /**
   * The one session a Codex window with this title shows, or null. `cwd` is the folder the
   * pane reports for its foreground process, when it reports one.
   */
  find(title: string | undefined, cwd?: string): string | null {
    const parts = title ? codexTitleParts(title) : null;
    if (!parts) return null;
    try {
      const matches = [...this.load()].filter(([id, name]) => {
        if (shortened(name, NAME_CHARS) !== parts.name) return false;
        const folder = this.folder(id);
        if (!folder || (cwd !== undefined && folder !== cwd)) return false;
        return projectNames(folder, this.exists).has(parts.project);
      });
      return matches.length === 1 ? matches[0]![0] : null;
    } catch {
      // Codex's files can be mid-write or unreadable; that proves nothing.
      return null;
    }
  }

  private load(): Map<string, string> {
    // Panes ask on every title change, which a working Codex makes ten times a second.
    if (this.now() - this.loadedAt < LOAD_MS) return this.names;
    this.loadedAt = this.now();
    const path = join(this.home, "session_index.jsonl");
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
        this.names = new Map();
        return this.names;
      }
      size = stat.size;
      const stamp = `${stat.mtimeMs}:${size}`;
      if (stamp === this.stamp) return this.names;
      this.stamp = stamp;
    } catch {
      this.stamp = "";
      this.names = new Map();
      return this.names;
    }
    const start = Math.max(0, size - INDEX_BYTES);
    const fd = openSync(path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - start);
      text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start)).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = text.split("\n");
    // A read from the middle starts inside a line.
    if (start > 0) lines.shift();
    const names = new Map<string, string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof entry.id !== "string" || !UUID.test(entry.id)) continue;
        const id = entry.id.toLowerCase();
        // A rename appends a line; the last one is the session's name now.
        names.delete(id);
        if (typeof entry.thread_name === "string" && entry.thread_name.trim())
          names.set(id, entry.thread_name);
      } catch {
        // A line still being written isn't an entry yet.
      }
    }
    this.names = names;
    return names;
  }

  /** A session's folder from the first record of its file, found by the day its ID names. */
  private folder(id: string): string | null {
    const known = this.folders.get(id);
    if (known && (known.cwd !== null || this.now() - known.at < MISSING_MS)) return known.cwd;
    const cwd = this.readFolder(id);
    if (this.folders.size >= THREADS) this.folders.clear();
    this.folders.set(id, { cwd, at: this.now() });
    return cwd;
  }

  private readFolder(id: string): string | null {
    // Codex's IDs are UUIDv7: the first twelve hex digits are when the session started, and
    // Codex files it under that local day. A day either side allows for a clock change.
    if (id[14] !== "7") return null;
    const started = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    const sessions = join(this.home, "sessions");
    for (const offset of [0, -1, 1]) {
      const dir = join(sessions, localDay(started + offset * 24 * 60 * 60 * 1000));
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const name = names.find((n) => n.startsWith("rollout-") && n.endsWith(`-${id}.jsonl`));
      if (!name) continue;
      const line = firstLine(join(dir, name));
      if (!line) return null;
      const meta = JSON.parse(line) as {
        type?: unknown;
        payload?: { id?: unknown; cwd?: unknown };
      };
      const cwd = meta.payload?.cwd;
      if (meta.type !== "session_meta" || meta.payload?.id !== id) return null;
      return typeof cwd === "string" && isAbsolute(cwd) ? cwd : null;
    }
    return null;
  }
}

let shared: CodexThreads | undefined;
export function codexThreads(): CodexThreads {
  shared ??= new CodexThreads(process.env.CODEX_HOME || join(homedir(), ".codex"));
  return shared;
}
