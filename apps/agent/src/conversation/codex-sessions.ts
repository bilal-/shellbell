import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";

/**
 * Which terminal pane started which Codex session. Codex keeps no record of the process that
 * owns a thread, so an opt-in SessionStart hook (`shellbell integration install codex`) writes
 * one small file per session start into this directory: the pane markers from the hook's
 * environment, which Codex passes on from the terminal, then Codex's own hook input.
 *
 * Only the session ID is taken from the input. The transcript locator finds that session's file
 * under Codex's sessions folder itself, with all of its usual checks.
 */
export const CODEX_HOOK_FORMAT = "shellbell-codex-hook 1";
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD = /^\d{1,12}-\d{1,10}\.rec$/;
const RECORD_BYTES = 80 * 1024;
const RECORDS = 256;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface CodexPaneMarkers {
  /** The pane's terminal, such as `ttys003` or `pts/4`, when the backend knows it. */
  readonly tty?: string;
  /** tmux's socket path and pane ID, as in `$TMUX` and `$TMUX_PANE`. */
  readonly tmux?: { readonly socket: string; readonly pane: string };
  /** iTerm2's session UUID, the part of `$ITERM_SESSION_ID` after the colon. */
  readonly iterm?: string;
  /** Herdr's pane ID, as in `$HERDR_PANE_ID`. */
  readonly herdr?: string;
}

export interface CodexSessionRecord {
  readonly name: string;
  /** When the hook ran, in milliseconds. */
  readonly time: number;
  readonly session: string;
  readonly tmuxSocket: string;
  readonly tmuxPane: string;
  readonly iterm: string;
  readonly herdr: string;
  /** The Codex process that started the session, its start time and its terminal. */
  readonly process: { readonly pid: number; readonly start: string; readonly tty: string };
}

export function codexSessionsDir(dir = paths().dir): string {
  return join(dir, "codex-sessions");
}

/** One hook file: `key=value` lines after the format line, a blank line, then Codex's JSON. */
export function parseCodexRecord(name: string, text: string): CodexSessionRecord | null {
  const split = text.indexOf("\n\n");
  if (split < 0) return null;
  const [format, ...fields] = text.slice(0, split).split("\n");
  if (format !== CODEX_HOOK_FORMAT) return null;
  const header = new Map(
    fields.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  let input: unknown;
  try {
    input = JSON.parse(text.slice(split + 2));
  } catch {
    return null;
  }
  const session = (input as { session_id?: unknown } | null)?.session_id;
  const time = Number(header.get("time"));
  if (typeof session !== "string" || !SESSION.test(session) || !Number.isSafeInteger(time))
    return null;
  // Without its Codex process and terminal a record proves nothing about any pane.
  if (!/^\d{1,9}$/.test(header.get("pid") ?? "") || !header.get("start") || !header.get("tty"))
    return null;
  const tmux = header.get("tmux") ?? "";
  return Object.freeze({
    name,
    time: time * 1000,
    session: session.toLowerCase(),
    // `$TMUX` is `socket,server pid,session`; only the socket names the server.
    tmuxSocket: tmux.split(",")[0]!,
    tmuxPane: header.get("tmux_pane") ?? "",
    // `$ITERM_SESSION_ID` is `w0t1p0:UUID`; the API names a session by the UUID.
    iterm: (header.get("iterm") ?? "").split(":").pop()!.toLowerCase(),
    herdr: header.get("herdr_pane") ?? "",
    process: {
      pid: Number(header.get("pid")),
      start: header.get("start")!,
      tty: header.get("tty")!,
    },
  });
}

function matches(record: CodexSessionRecord, markers: CodexPaneMarkers): boolean {
  if (markers.tty !== undefined && record.process.tty !== markers.tty) return false;
  if (markers.tmux)
    return (
      !!record.tmuxPane &&
      record.tmuxPane === markers.tmux.pane &&
      record.tmuxSocket === markers.tmux.socket
    );
  if (markers.iterm) return !!record.iterm && record.iterm === markers.iterm.toLowerCase();
  if (markers.herdr) return !!record.herdr && record.herdr === markers.herdr;
  return false;
}

/**
 * The hook's records, read again only when their names change. Reads are synchronous and
 * bounded (at most 256 files of 80 KB), so backends that resolve references while handling an
 * event can ask too.
 */
/** The process's start time as `ps -o lstart=` gives it, in UTC, or null once it has exited. */
function processStart(pid: number): string | null {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1000,
        env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
      })
        .trim()
        .replace(/\s+/g, " ") || null
    );
  } catch {
    return null;
  }
}
/** Whether a process exists, without spawning anything. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** How long a process's start time, once checked, stands for its identity. */
const VERIFIED_MS = 60_000;
/** How often the record folder is read again; a new record waits this long at most. */
const LOAD_MS = 1000;

/** The process a pane shows running, as the terminal backend found it. */
export interface CodexProcess {
  readonly pid: number;
  readonly start: string;
}

export class CodexSessions {
  private stamp = "";
  private loadedAt = Number.NEGATIVE_INFINITY;
  private records: readonly CodexSessionRecord[] = [];
  /** When each record's process start time was last confirmed, so `ps` runs rarely. */
  private verified = new Map<string, number>();
  /** Records' processes known to have exited. */
  private dead = new Set<string>();
  constructor(
    private readonly dir = codexSessionsDir(),
    private readonly now = () => Date.now(),
    private readonly startOf: (pid: number) => string | null = processStart,
    private readonly exists: (pid: number) => boolean = processExists,
  ) {}

  /**
   * Whether the Codex that wrote a record still runs. A cheap existence check runs each time;
   * the start time, which tells a reused pid apart, is confirmed at most once a minute.
   */
  private running(record: CodexSessionRecord): boolean {
    const { pid, start } = record.process;
    const key = `${pid}:${start}`;
    // A record whose process was once seen gone, or with another start time, stays dead: a pid
    // reused later belongs to some other process.
    if (this.dead.has(key)) return false;
    if (!this.exists(pid)) {
      this.markDead(key);
      return false;
    }
    const at = this.verified.get(key);
    if (at !== undefined && this.now() - at < VERIFIED_MS) return true;
    const actual = this.startOf(pid);
    // `ps` can fail or time out on a busy machine; that says nothing, so try again later.
    if (actual === null) return false;
    if (actual !== start) {
      this.markDead(key);
      return false;
    }
    if (this.verified.size > RECORDS) this.verified.clear();
    this.verified.set(key, this.now());
    return true;
  }

  private markDead(key: string): void {
    this.verified.delete(key);
    if (this.dead.size > RECORDS) this.dead.clear();
    this.dead.add(key);
  }

  private load(): readonly CodexSessionRecord[] {
    // Backends ask on every pane event; the folder is read again at most once a second.
    if (this.now() - this.loadedAt < LOAD_MS) return this.records;
    this.loadedAt = this.now();
    let names: string[];
    try {
      const stat = statSync(this.dir);
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return [];
      names = readdirSync(this.dir).filter((name) => RECORD.test(name));
    } catch {
      this.records = [];
      return this.records;
    }
    names.sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]) || (a < b ? 1 : -1));
    // The names change with every record the hook adds, even within one clock tick.
    const stamp = names.join("/");
    if (stamp === this.stamp) return this.records;
    const records: CodexSessionRecord[] = [];
    /** Processes already holding a newer record: one Codex names one session at a time. */
    const latest = new Set<string>();
    for (const [index, name] of names.entries()) {
      const path = join(this.dir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > RECORD_BYTES) continue;
        if (process.getuid && stat.uid !== process.getuid()) continue;
        const record = parseCodexRecord(name, readFileSync(path, "utf8"));
        // Past the newest records or a month old, a record goes once its Codex has exited;
        // a long-running Codex keeps the only proof of its session.
        const stale = index >= RECORDS || this.now() - stat.mtimeMs > KEEP_MS;
        const owner = record && `${record.process.pid}:${record.process.start}`;
        // A Codex that started another session since has moved on from this one; with that,
        // records are bounded by the Codex processes running.
        const superseded = owner !== null && latest.has(owner);
        if (superseded || (stale && (!record || !this.exists(record.process.pid)))) {
          unlinkSync(path);
          continue;
        }
        if (owner) latest.add(owner);
        if (record) records.push(record);
      } catch {
        // A file removed or rewritten while reading is simply not a record.
      }
    }
    this.stamp = stamp;
    this.records = records;
    return records;
  }

  /**
   * The session last started in this pane by a Codex that still runs, or null. Given the
   * pane's own Codex process, as tmux and iTerm2 list it, only that process's record counts.
   */
  find(markers: CodexPaneMarkers, owner?: CodexProcess): CodexSessionRecord | null {
    let records: readonly CodexSessionRecord[];
    try {
      records = this.load();
    } catch {
      return null;
    }
    const found = records.find(
      (record) =>
        matches(record, markers) &&
        (!owner || (record.process.pid === owner.pid && record.process.start === owner.start)),
    );
    if (!found) return null;
    // The backend saw that very process running, so no further check is needed.
    if (owner) return found;
    // A Codex that exited leaves its record behind; a later one in the same pane isn't it.
    return this.running(found) ? found : null;
  }
}

let shared: CodexSessions | undefined;
export function codexSessions(): CodexSessions {
  shared ??= new CodexSessions();
  return shared;
}
