import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalAgent } from "../agents.js";
import { type AgentSessions, agentSessions, type PaneMarkers } from "./agent-sessions.js";
import { type CodexThreads, codexThreads } from "./codex-threads.js";
import type { ConversationReference } from "./reference.js";

/**
 * Proves which agent conversation a terminal is showing, for backends that don't report it
 * (tmux, iTerm2 and other terminals). Herdr reports it itself. The proof comes from the agent's
 * own foreground process on the terminal's tty, never from the pane title or working folder:
 *
 * - Claude Code writes `<config>/sessions/<pid>.json` with its session ID and process start
 *   time; both must match the running process.
 * - Antigravity CLI holds `presence/<conversation>.lock` open while a conversation is active;
 *   the process must hold exactly one.
 *
 * - Codex and Gemini keep no record of which process owns which session. With Shellbell's hook
 *   installed, the pane's newest record from this exact process is the proof (see
 *   `agent-sessions.ts`).
 * - Codex 0.166 and later run sessions in a shared background process, where the hook can't see
 *   the pane. There the session Codex names in the pane's own title is the proof, and only when
 *   exactly one session fits (see `codex-threads.ts`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTY = /^\/dev\/(ttys\d{1,5}|pts\/\d{1,6})$/;
const SESSION_FILE_BYTES = 64 * 1024;
const RUN_MS = 2000;
const PROCESSES = 256;

export interface ProcessBindingOptions {
  /** Runs a command and returns its output; replaced in tests. */
  run?: (file: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
  claudeDir?: string;
  antigravityDir?: string;
  platform?: NodeJS.Platform;
  /** How the terminal's backend names this pane, for the Codex and Gemini hooks' records. */
  codexPane?: PaneMarkers;
  codexSessions?: AgentSessions;
  geminiSessions?: AgentSessions;
  /** The pane's title and the folder it reports, read only when Codex runs there unrecorded. */
  codexTitle?: () => Promise<{ title?: string; cwd?: string }>;
  codexThreads?: CodexThreads;
}

function run(file: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      // A fixed UTC clock and C locale make `lstart` match the agents' own start-time strings.
      {
        signal,
        timeout: RUN_MS,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TZ: "UTC", LC_ALL: "C" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

interface Process {
  readonly pid: number;
  readonly start: string;
  readonly command: string;
}

/** Foreground processes on one terminal, with their start times. */
async function foreground(
  tty: string,
  signal: AbortSignal,
  exec: NonNullable<ProcessBindingOptions["run"]>,
): Promise<Process[]> {
  const output = await exec(
    "ps",
    ["-t", tty.slice("/dev/".length), "-o", "pid=,stat=,lstart=,comm="],
    signal,
  );
  const processes: Process[] = [];
  for (const line of output.split("\n")) {
    // `lstart` is always five fields, such as `Sat Oct 24 04:16:59 2026`.
    const match = /^\s*(\d+)\s+(\S+)\s+(\S+ \S+\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+?)\s*$/.exec(line);
    if (!match || !match[2]!.includes("+")) continue;
    if (processes.length >= PROCESSES) break;
    const command = match[4]!.split("/").pop()!;
    processes.push({ pid: Number(match[1]), start: match[3]!.replace(/\s+/g, " "), command });
  }
  return processes;
}

async function claude(process_: Process, dir: string): Promise<string | null> {
  const path = join(dir, "sessions", `${process_.pid}.json`);
  const stat = await lstat(path).catch(() => null);
  if (
    !stat?.isFile() ||
    stat.size > SESSION_FILE_BYTES ||
    (process.getuid && stat.uid !== process.getuid())
  )
    return null;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null) return null;
  const record = value as { pid?: unknown; sessionId?: unknown; procStart?: unknown };
  // A reused pid has a different start time, so an old session file can't bind a new process.
  if (
    record.pid !== process_.pid ||
    typeof record.procStart !== "string" ||
    record.procStart.replace(/\s+/g, " ") !== process_.start ||
    typeof record.sessionId !== "string" ||
    !UUID.test(record.sessionId)
  )
    return null;
  return record.sessionId.toLowerCase();
}

async function openFiles(
  pid: number,
  signal: AbortSignal,
  exec: NonNullable<ProcessBindingOptions["run"]>,
  platform: NodeJS.Platform,
): Promise<string[]> {
  if (platform === "linux") {
    const dir = `/proc/${pid}/fd`;
    const names = await readdir(dir);
    const paths: string[] = [];
    for (const name of names.slice(0, 4096)) {
      const target = await readlink(join(dir, name)).catch(() => null);
      if (target) paths.push(target);
    }
    return paths;
  }
  // Numeric addresses and ports: name lookups for the agent's sockets could stall to the timeout.
  const output = await exec("lsof", ["-n", "-P", "-a", "-p", String(pid), "-Fn"], signal);
  return output
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

async function antigravity(
  process_: Process,
  dir: string,
  signal: AbortSignal,
  exec: NonNullable<ProcessBindingOptions["run"]>,
  options: ProcessBindingOptions,
): Promise<string | null> {
  const presence = join(dir, "presence");
  // Always fresh: the same process can release one conversation's lock and take another's, so
  // an earlier list must never prove which conversation it holds now.
  const paths = await openFiles(process_.pid, signal, exec, options.platform ?? process.platform);
  const held = new Set(
    paths.flatMap((path) => {
      if (!path.startsWith(`${presence}/`)) return [];
      const name = path.slice(presence.length + 1);
      const id = name.endsWith(".lock") ? name.slice(0, -".lock".length) : "";
      return UUID.test(id) ? [id.toLowerCase()] : [];
    }),
  );
  return held.size === 1 ? [...held][0]! : null;
}

/** The one conversation a terminal's foreground agent proves it is running, or null. */
export async function processConversationReference(
  tty: string,
  signal: AbortSignal,
  options: ProcessBindingOptions = {},
): Promise<ConversationReference | null> {
  if (!TTY.test(tty) || signal.aborted) return null;
  const exec = options.run ?? run;
  try {
    const found = new Map<string, ConversationReference>();
    for (const process_ of await foreground(tty, signal, exec)) {
      if (signal.aborted) return null;
      const owner = `process:${tty}:${process_.pid}:${process_.start}`;
      // Claude Code's session file, with matching pid and start time, is the proof; its process
      // can show as `node` or a version number, so every foreground process is checked.
      const kind = canonicalAgent(process_.command);
      // Gemini runs as `node`; only its hook's record for this exact process names it.
      const gemini = options.codexPane
        ? (options.geminiSessions ?? agentSessions("gemini")).find(
            { ...options.codexPane, tty: tty.slice("/dev/".length) },
            { pid: process_.pid, start: process_.start },
          )
        : null;
      if (gemini) {
        found.set(`gemini:${gemini.session}`, {
          agent: "gemini",
          kind: "id",
          value: gemini.session,
          owner: `${owner}:${gemini.session}`,
        });
      } else if (kind === "codex") {
        // The hook recorded this exact process, by pid and start time, on this terminal.
        const record = options.codexPane
          ? (options.codexSessions ?? agentSessions("codex")).find(
              { ...options.codexPane, tty: tty.slice("/dev/".length) },
              { pid: process_.pid, start: process_.start },
            )
          : null;
        const pane = !record && options.codexTitle ? await options.codexTitle() : undefined;
        const session =
          record?.session ??
          (pane ? (options.codexThreads ?? codexThreads()).find(pane.title, pane.cwd) : null);
        if (session)
          found.set(`codex:${session}`, {
            agent: "codex",
            kind: "id",
            value: session,
            owner: `${owner}:${session}`,
          });
      } else if (kind !== "agy") {
        const id = await claude(
          process_,
          options.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
        );
        if (id) found.set(`claude:${id}`, { agent: "claude", kind: "id", value: id, owner });
      } else {
        const id = await antigravity(
          process_,
          options.antigravityDir ?? join(homedir(), ".gemini", "antigravity-cli"),
          signal,
          exec,
          options,
        );
        if (id) found.set(`agy:${id}`, { agent: "agy", kind: "id", value: id, owner });
      }
    }
    // Two agents in the foreground of one terminal can't be told apart; show the terminal.
    return found.size === 1 ? Object.freeze([...found.values()][0]!) : null;
  } catch {
    // Process tools and files can fail or name private paths. Missing proof stays private.
    return null;
  }
}
