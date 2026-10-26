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
  });
}

function matches(record: CodexSessionRecord, markers: CodexPaneMarkers): boolean {
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
export class CodexSessions {
  private stamp = "";
  private records: readonly CodexSessionRecord[] = [];
  constructor(
    private readonly dir = codexSessionsDir(),
    private readonly now = () => Date.now(),
  ) {}

  private load(): readonly CodexSessionRecord[] {
    let names: string[];
    try {
      const stat = statSync(this.dir);
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return [];
      names = readdirSync(this.dir).filter((name) => RECORD.test(name));
    } catch {
      return (this.records = []);
    }
    names.sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]) || (a < b ? 1 : -1));
    // The names change with every record the hook adds, even within one clock tick.
    const stamp = names.join("/");
    if (stamp === this.stamp) return this.records;
    const records: CodexSessionRecord[] = [];
    for (const [index, name] of names.entries()) {
      const path = join(this.dir, name);
      try {
        const stat = statSync(path);
        const old = this.now() - stat.mtimeMs > KEEP_MS;
        // The newest records are the only ones that can still name a running Codex.
        if (index >= RECORDS || old) {
          unlinkSync(path);
          continue;
        }
        if (!stat.isFile() || stat.size > RECORD_BYTES) continue;
        if (process.getuid && stat.uid !== process.getuid()) continue;
        const record = parseCodexRecord(name, readFileSync(path, "utf8"));
        if (record) records.push(record);
      } catch {
        // A file removed or rewritten while reading is simply not a record.
      }
    }
    this.stamp = stamp;
    return (this.records = records);
  }

  /**
   * The session last started in this pane, or null. `since`, when the pane's running Codex
   * started, rules out a record that an earlier Codex in the same pane left behind.
   */
  find(markers: CodexPaneMarkers, since?: number): CodexSessionRecord | null {
    let records: readonly CodexSessionRecord[];
    try {
      records = this.load();
    } catch {
      return null;
    }
    const found = records.find((record) => matches(record, markers));
    // Process start times are whole seconds; the hook runs after its process starts.
    if (!found || (since !== undefined && found.time < since - 1000)) return null;
    return found;
  }
}

let shared: CodexSessions | undefined;
export function codexSessions(): CodexSessions {
  shared ??= new CodexSessions();
  return shared;
}
