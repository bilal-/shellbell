import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import type { NotificationContext } from "@shellbell/protocol";

export interface NotificationFacts {
  sessionId: string;
  revision: string;
  locality: "local" | "guest" | "unknown";
  sessionLabel: string;
  cwd?: string;
  customName?: string;
  title?: string;
  shell?: string;
  agentName?: string;
}
export interface GitContext {
  repository: string;
  branch?: string;
  observedAt?: number;
}
/** Reported OSC paths alone do not prove that a directory belongs to this host. */
export function makeNotificationFacts(
  input: Pick<NotificationFacts, "sessionId" | "sessionLabel" | "cwd" | "title">,
  processName: string | undefined,
  cwdSource: "local-process" | "reported",
): NotificationFacts {
  const command = basename(processName ?? "")
    .replace(/^-/, "")
    .replace(/\.exe$/i, "");
  const shell = ["sh", "bash", "zsh", "fish", "dash", "ksh", "pwsh", "powershell", "cmd"].includes(
    command,
  )
    ? command
    : undefined;
  const agentName = command === "claude" ? "Claude" : command === "codex" ? "Codex" : undefined;
  const guest = ["ssh", "mosh", "docker", "podman", "kubectl", "wsl"].includes(command);
  return {
    ...input,
    shell,
    agentName,
    locality: guest
      ? "guest"
      : cwdSource === "local-process" && (shell || agentName)
        ? "local"
        : "unknown",
    revision: JSON.stringify([
      input.sessionId,
      input.cwd,
      input.title,
      input.sessionLabel,
      command,
      cwdSource,
    ]),
  };
}
export type GitContextReader = (
  cwd: string,
  signal: AbortSignal,
) => Promise<GitContext | undefined>;
export interface ContextDependencies {
  computerName: string;
  now: () => number;
  stillCurrent: (facts: NotificationFacts) => boolean | Promise<boolean>;
  git: GitContextReader;
}
function cleanLabel(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = value
    .replace(/[\r\n\t\u2028\u2029]+/gu, " ")
    .replace(/[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  // Terminal/window titles commonly embed cwd or remote origins. Never move those paths
  // onto a lock screen; conservative omission falls back to the stable session label.
  if (
    /(?:^|[\s("'=:])(?:\/|~[\\/]|[a-z]:[\\/])|\\\\|[a-z][a-z0-9+.-]*:\/\/|[^\s@]+@[^\s:]+:/iu.test(
      clean,
    )
  )
    return undefined;
  let out = "";
  let bytes = 0;
  for (const char of clean) {
    const next = Buffer.byteLength(char, "utf8");
    if (bytes + next > maxBytes) break;
    bytes += next;
    out += char;
  }
  return out || undefined;
}

/** Agent-owned bounded reader; never inherit Git path/config overrides from a shell. */
export function createGitContextReader(options: { now?: () => number } = {}): GitContextReader {
  const now = options.now ?? Date.now;
  const cache = new Map<string, GitContext & { observedAt: number }>();
  let active = 0;
  const waiting = new Set<() => void>();
  async function acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted || waiting.size >= 32) throw new Error("git context unavailable");
    if (active >= 2)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          waiting.delete(ready);
          reject(new Error("git context unavailable"));
        };
        const ready = () => {
          waiting.delete(ready);
          signal.removeEventListener("abort", abort);
          active += 1;
          resolve();
        };
        waiting.add(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    else active += 1;
    if (signal.aborted) {
      active -= 1;
      waiting.values().next().value?.();
      throw new Error("git context unavailable");
    }
    return () => {
      active -= 1;
      waiting.values().next().value?.();
    };
  }
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const run = (cwd: string, args: string[], signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-c", "core.fsmonitor=false", "-C", cwd, ...args],
        {
          env,
          encoding: "utf8",
          signal,
          timeout: 250,
          killSignal: "SIGKILL",
          maxBuffer: 8192,
          windowsHide: true,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
    });
  return async (cwd, signal) => {
    if (!isAbsolute(cwd) || cwd.length > 1024 || signal.aborted) return undefined;
    const at = now();
    for (const [path, value] of cache)
      if (at < value.observedAt || at - value.observedAt >= 5000) cache.delete(path);
    const cached = cache.get(cwd);
    if (cached) return cached;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 250);
    let release: (() => void) | undefined;
    try {
      release = await acquire(controller.signal);
      const top = await run(cwd, ["rev-parse", "--show-toplevel"], controller.signal);
      let branch: string | undefined;
      try {
        branch = await run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], controller.signal);
      } catch (e) {
        if (!controller.signal.aborted && (e as { code?: unknown }).code === 1)
          branch = "detached HEAD";
      }
      if (controller.signal.aborted) return undefined;
      const repository = cleanLabel(basename(top), 256);
      if (!repository) return undefined;
      const result = { repository, branch: cleanLabel(branch, 256), observedAt: at };
      if (cache.size >= 500) cache.delete(cache.keys().next().value!);
      cache.set(cwd, result);
      return result;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      release?.();
    }
  };
}

export async function resolveNotificationContext(
  facts: NotificationFacts,
  deps: ContextDependencies,
): Promise<NotificationContext> {
  const at = deps.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, 250);
  });
  const current = async () => {
    const valid = await Promise.race([
      Promise.resolve().then(() => deps.stillCurrent(facts)),
      deadline,
    ]);
    if (!valid) throw new Error("stale notification context");
  };
  try {
    await current();
    let git: GitContext | undefined;
    if (facts.locality === "local" && facts.cwd && isAbsolute(facts.cwd)) {
      git = await Promise.race([
        Promise.resolve()
          .then(() => deps.git(facts.cwd!, controller.signal))
          .catch(() => undefined),
        deadline,
      ]);
    }
    // A synchronous freshness check still works after the Git deadline; do not race it
    // against an already-resolved timer. Async checks must stay within the budget.
    const valid = deps.stillCurrent(facts);
    if (typeof valid === "boolean" ? !valid : !(await Promise.race([valid, deadline])))
      throw new Error("stale notification context");
    const context: NotificationContext = {
      computerName: cleanLabel(deps.computerName, 128) ?? "Computer",
      sessionLabel: cleanLabel(facts.sessionLabel, 128) ?? "Session",
      observedAt: Math.min(at, git?.observedAt ?? at),
    };
    for (const [name, limit] of [
      ["customName", 256],
      ["title", 256],
      ["shell", 64],
      ["agentName", 64],
    ] as const) {
      const value = cleanLabel(facts[name], limit);
      if (value) context[name] = value;
    }
    const repo = cleanLabel(git?.repository, 256);
    const branch = cleanLabel(git?.branch, 256);
    if (repo) context.repository = repo;
    if (repo && branch) context.branch = branch;
    return context;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
