import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { findTerminalExecutable } from "../executable.js";

const run = promisify(execFile);

export function findHerdrExecutable(
  env: NodeJS.ProcessEnv = process.env,
  executable?: (path: string) => boolean,
): string | undefined {
  return findTerminalExecutable("herdr", env, executable);
}

export interface RunningHerdrOptions {
  platform?: NodeJS.Platform;
  /** `ps` on macOS; returns stdout. */
  ps?: (args: string[]) => Promise<string>;
  /** `/proc` on Linux. */
  procRoot?: string;
  uid?: number;
  executable?: (path: string) => boolean;
}

/**
 * The program behind this user's running `herdr server`, wherever it was installed (a package
 * manager, `~/.local/bin`, Nix, a custom prefix). Opening sessions with it keeps the client and
 * server on the same version. Undefined when no server runs, or when servers from different
 * programs run and the right one cannot be told apart.
 */
export async function findRunningHerdrServer(
  options: RunningHerdrOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  let paths: string[];
  try {
    if (platform === "darwin") paths = await darwinServers(options);
    else if (platform === "linux") paths = linuxServers(options);
    else return undefined;
  } catch {
    return undefined;
  }
  const unique = [...new Set(paths)];
  const executable = options.executable ?? isExecutableFile;
  return unique.length === 1 && isAbsolute(unique[0]!) && executable(unique[0]!)
    ? unique[0]
    : undefined;
}

/** `herdr server` with nothing after it: the server itself, not `herdr server stop`. */
function isServer(argv: readonly string[]): boolean {
  return argv.length === 2 && basename(argv[0]!) === "herdr" && argv[1] === "server";
}

async function darwinServers(options: RunningHerdrOptions): Promise<string[]> {
  const ps =
    options.ps ??
    (async (args: string[]) =>
      (await run("/bin/ps", args, { timeout: 2000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  // Without -a, ps lists only this user's processes. A program path can contain spaces, so
  // arguments are matched from the end and the path itself comes from `comm`, which macOS
  // reports in full.
  const pids = (await ps(["-x", "-ww", "-o", "pid=,args="])).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(?:.*\/)?herdr server\s*$/.exec(line);
    return match ? [match[1]!] : [];
  });
  if (pids.length === 0) return [];
  return (await ps(["-ww", "-o", "comm=", "-p", pids.join(",")]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function linuxServers(options: RunningHerdrOptions): string[] {
  const root = options.procRoot ?? "/proc";
  const uid = options.uid ?? process.getuid?.();
  const paths: string[] = [];
  for (const pid of readdirSync(root)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (uid !== undefined && statSync(join(root, pid)).uid !== uid) continue;
      const argv = readFileSync(join(root, pid, "cmdline"), "latin1").split("\0");
      if (argv.at(-1) === "") argv.pop();
      if (!isServer(argv)) continue;
      // A program replaced since it started reads as "<path> (deleted)"; it is not runnable.
      const exe = readlinkSync(join(root, pid, "exe"));
      if (!exe.endsWith(" (deleted)")) paths.push(exe);
    } catch {
      // The process exited or belongs to someone else.
    }
  }
  return paths;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
