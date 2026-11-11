import { constants, type Stats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTranscriptReference } from "./reference.js";

const SESSION_BYTES = 64 * 1024;
const SESSION_FILES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeBackgroundOptions {
  dir: string;
  run(file: string, args: readonly string[], signal: AbortSignal): Promise<string>;
}

export type ClaudeBackgroundResult =
  | { status: "unchanged" }
  | { status: "unavailable" }
  | { status: "resolved"; session: string; owner: string };

interface Session {
  pid: number;
  procStart: string;
  sessionId: string;
  kind?: string;
  jobId?: string;
  parkedJobId?: string;
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

async function sessionFile(dir: string, pid: number): Promise<Session | null | undefined> {
  const path = join(dir, "sessions", `${pid}.json`);
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : null,
  );
  if (before === undefined) return undefined;
  if (
    !before?.isFile() ||
    before.size > SESSION_BYTES ||
    (process.getuid && before.uid !== process.getuid())
  )
    return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!file) return null;
  try {
    if (!sameFile(before, await file.stat())) return null;
    const buffer = Buffer.alloc(SESSION_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SESSION_BYTES) return null;
    const after = await file.stat();
    const named = await lstat(path).catch(() => null);
    if (!named?.isFile() || !sameFile(before, after) || !sameFile(after, named)) return null;
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Session;
    if (
      value?.pid !== pid ||
      typeof value.procStart !== "string" ||
      typeof value.sessionId !== "string" ||
      !UUID.test(value.sessionId)
    )
      return null;
    return { ...value, procStart: value.procStart.replace(/\s+/g, " ").trim() };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** Resolve Claude's explicit interactive -> background-job relationship without reading transcripts. */
export async function resolveClaudeBackground(
  reference: AgentTranscriptReference | null,
  foregroundPids: () => Promise<readonly number[]>,
  signal: AbortSignal,
  options: ClaudeBackgroundOptions,
): Promise<ClaudeBackgroundResult> {
  if (reference?.agent !== "claude" || reference.kind !== "id" || !UUID.test(reference.value))
    return { status: "unchanged" };
  try {
    const pids = [...new Set(await foregroundPids())];
    if (
      signal.aborted ||
      pids.length > 256 ||
      pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
    )
      return { status: "unavailable" };
    const parents: Session[] = [];
    for (const pid of pids) {
      if (signal.aborted) return { status: "unavailable" };
      const record = await sessionFile(options.dir, pid);
      if (record === null) return { status: "unavailable" };
      if (
        record?.sessionId.toLowerCase() === reference.value.toLowerCase() &&
        record.kind === "interactive" &&
        record.parkedJobId != null
      )
        parents.push(record);
    }
    if (!parents.length) return { status: "unchanged" };
    if (parents.length !== 1) return { status: "unavailable" };
    const parent = parents[0]!;
    const job = parent.parkedJobId;
    if (typeof job !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(job))
      return { status: "unavailable" };
    const candidates: Session[] = [];
    const directory = await opendir(join(options.dir, "sessions"));
    let count = 0;
    for await (const entry of directory) {
      if (signal.aborted || ++count > SESSION_FILES) return { status: "unavailable" };
      if (!/^[1-9]\d*\.json$/.test(entry.name)) continue;
      const pid = Number(entry.name.slice(0, -5));
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      const record = await sessionFile(options.dir, pid);
      if (record?.kind === "bg" && record.jobId === job) candidates.push(record);
    }
    if (!candidates.length || signal.aborted) return { status: "unavailable" };
    const output = await options.run(
      "ps",
      [
        "-p",
        [parent.pid, ...candidates.map((candidate) => candidate.pid)].join(","),
        "-o",
        "pid=,lstart=",
      ],
      signal,
    );
    const starts = new Map<number, string>();
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\S+ \S+\s+\d+ \d\d:\d\d:\d\d \d{4})\s*$/.exec(line);
      if (match) starts.set(Number(match[1]), match[2]!.replace(/\s+/g, " "));
    }
    const live = candidates.filter(
      (candidate) => starts.get(candidate.pid) === candidate.procStart,
    );
    if (signal.aborted || starts.get(parent.pid) !== parent.procStart || live.length !== 1)
      return { status: "unavailable" };
    const background = live[0]!;
    const parentNow = await sessionFile(options.dir, parent.pid);
    const backgroundNow = await sessionFile(options.dir, background.pid);
    if (
      signal.aborted ||
      parentNow?.sessionId !== parent.sessionId ||
      parentNow.procStart !== parent.procStart ||
      parentNow.kind !== "interactive" ||
      parentNow.parkedJobId !== job ||
      backgroundNow?.sessionId !== background.sessionId ||
      backgroundNow.procStart !== background.procStart ||
      backgroundNow.kind !== "bg" ||
      backgroundNow.jobId !== job
    )
      return { status: "unavailable" };
    return {
      status: "resolved",
      session: background.sessionId.toLowerCase(),
      owner: `claude-background:${parent.pid}:${parent.procStart}:${background.pid}:${background.procStart}:${job}`,
    };
  } catch {
    return { status: "unavailable" };
  }
}
