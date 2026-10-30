import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { type InitialTerminalSize, InitialTerminalSizeSchema } from "@shellbell/protocol";
import { BackendUnavailable, NotShownOnComputer } from "./types.js";

export interface TerminalCommand {
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
  initialSize?: InitialTerminalSize;
}
export interface TerminalWindowLauncher {
  id: string;
  label: string;
  available(): boolean;
  launch(command: TerminalCommand): Promise<void>;
}
const run = promisify(execFile);

/** Native launch configuration uses a shell string; every word is a literal, including IDs. */
export function terminalCommandLine(command: TerminalCommand): string {
  const words = [command.executable, ...command.args];
  const validWord = (value: string) =>
    [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
  if (
    !isAbsolute(command.executable) ||
    words.some((word) => !validWord(word)) ||
    words.reduce((size, word) => size + word.length, 0) > 4096
  )
    throw new Error("Invalid terminal command");
  const environment = Object.entries(command.environment ?? {}).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || !validWord(value))
      throw new Error("Invalid terminal environment");
    return `${key}=${value}`;
  });
  const literal = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;
  const result = [...(environment.length ? ["/usr/bin/env", ...environment] : []), ...words]
    .map(literal)
    .join(" ");
  if (result.length > 8192) throw new Error("Terminal command is too large");
  return result;
}

/**
 * Open the desktop window for a session that was just created for a phone. A session whose window
 * did not open is visible only on the phone, so it is closed again before the error is returned.
 */
export async function openOrDiscard(
  open: () => Promise<void>,
  discard: () => Promise<void>,
): Promise<void> {
  try {
    await open();
  } catch {
    try {
      await discard();
    } catch {
      throw new NotShownOnComputer(
        "The terminal window could not open on your computer, and the new session could not be closed. Check the session list.",
      );
    }
    throw new NotShownOnComputer(
      "The terminal window didn't open on your computer, so the new session was closed. If your computer is locked, unlock it and try again.",
    );
  }
}

export function ghosttyWindowLauncher(
  options: {
    platform?: string;
    roots?: readonly string[];
    exists?: (path: string) => boolean;
    execute?: (file: string, args: string[]) => Promise<unknown>;
  } = {},
): TerminalWindowLauncher | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const path = () =>
    (options.roots ?? ["/Applications", join(homedir(), "Applications")])
      .map((root) => join(root, "Ghostty.app"))
      .find(options.exists ?? existsSync);
  return {
    id: "ghostty",
    label: "Ghostty",
    available: () => path() !== undefined,
    async launch(command) {
      const application = path();
      if (!application)
        throw new BackendUnavailable(
          "Ghostty is not installed",
          "Install Ghostty on your computer.",
        );
      const line = terminalCommandLine(command);
      const size =
        command.initialSize === undefined
          ? undefined
          : InitialTerminalSizeSchema.parse(command.initialSize);
      try {
        // A separate instance accepts launch arguments even when the normal app is already open.
        // It does not restore ordinary Ghostty windows or write its own window layout on exit.
        // No `-g`: Ghostty started in the background never creates its first window.
        await (
          options.execute ?? ((file, args) => run(file, args, { timeout: 5000, maxBuffer: 4096 }))
        )("/usr/bin/open", [
          "-n",
          "-a",
          application,
          "--args",
          "--initial-window=true",
          "--window-save-state=never",
          "--quit-after-last-window-closed=true",
          ...(size ? [`--window-width=${size.cols}`, `--window-height=${size.rows}`] : []),
          `--initial-command=${line}`,
        ]);
      } catch {
        throw new BackendUnavailable(
          "Ghostty could not be launched",
          "Check that Ghostty opens on your computer, then try again.",
        );
      }
    },
  };
}

/** How long a window script stays usable; after that it is removed, and refuses to run. */
const TERMINAL_SCRIPT_LIFETIME_MS = 2 * 60_000;
/**
 * How old an earlier process's leftover script must be before a launch removes it. Far longer
 * than the lifetime, so a clock that jumps forward cannot remove a script about to be opened.
 */
const TERMINAL_SCRIPT_SWEEP_AGE_MS = 60 * 60_000;

/**
 * Apple's Terminal, as a window for a tmux or Herdr session. Terminal opens a `.command` file in a
 * new window, and opening a document needs no Automation permission, so the command goes in a
 * private one-time script that deletes itself as it runs. Terminal starts the person's login
 * shell first, then the script. Scripts live in a private per-user folder; one that is never run
 * expires, and is removed by this process or, after a restart, by the next launch.
 */
export function terminalAppWindowLauncher(
  options: {
    platform?: string;
    roots?: readonly string[];
    exists?: (path: string) => boolean;
    execute?: (file: string, args: string[]) => Promise<unknown>;
    scriptRoot?: string;
    scriptLifetimeMs?: number;
    sweepAgeMs?: number;
    now?: () => number;
  } = {},
): TerminalWindowLauncher | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const path = () =>
    (options.roots ?? ["/System/Applications/Utilities", "/Applications/Utilities"])
      .map((root) => join(root, "Terminal.app"))
      .find(options.exists ?? existsSync);
  const scriptRoot =
    options.scriptRoot ?? join(homedir(), "Library", "Caches", "Shellbell", "terminal-windows");
  const lifetime = options.scriptLifetimeMs ?? TERMINAL_SCRIPT_LIFETIME_MS;
  const sweepAge = options.sweepAgeMs ?? TERMINAL_SCRIPT_SWEEP_AGE_MS;
  const now = options.now ?? Date.now;
  /** The folder, made private to this user; never one someone else made or a link elsewhere. */
  const privateRoot = async () => {
    await mkdir(scriptRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(scriptRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (process.getuid && root.uid !== process.getuid()) ||
      (root.mode & 0o077) !== 0
    )
      throw new Error("Terminal script folder is not private");
  };
  /** Removes scripts an earlier process left behind; bounded, and never follows links. */
  const sweep = async () => {
    const entries = await readdir(scriptRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 256)) {
      if (!entry.isDirectory() || !entry.name.startsWith("shellbell-terminal-")) continue;
      const directory = join(scriptRoot, entry.name);
      const stat = await lstat(directory).catch(() => undefined);
      if (stat?.isDirectory() && now() - stat.mtimeMs > Math.max(lifetime, sweepAge))
        await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  };
  return {
    id: "terminal",
    label: "Terminal",
    available: () => path() !== undefined,
    async launch(command) {
      const application = path();
      if (!application)
        throw new BackendUnavailable(
          "Terminal is missing",
          "Check that Terminal opens on your computer.",
        );
      const line = terminalCommandLine(command);
      const size =
        command.initialSize === undefined
          ? undefined
          : InitialTerminalSizeSchema.parse(command.initialSize);
      const deadline = Math.floor((now() + lifetime) / 1000);
      const script = [
        "#!/bin/sh",
        'rm -f -- "$0"; rmdir -- "$(/usr/bin/dirname -- "$0")" 2>/dev/null',
        // A window that opens too late must not attach to a session that was already closed.
        `[ "$(/bin/date +%s)" -le ${deadline} ] || exit 0`,
        // Terminal takes no size argument; it does resize its window for this escape sequence.
        ...(size ? [`printf '\\033[8;%s;%st' ${size.rows} ${size.cols}`] : []),
        `exec ${line}`,
        "",
      ].join("\n");
      let directory: string | undefined;
      const remove = () =>
        directory
          ? rm(directory, { recursive: true, force: true }).catch(() => {})
          : Promise.resolve();
      let file: string;
      try {
        await privateRoot();
        await sweep();
        directory = await mkdtemp(join(scriptRoot, "shellbell-terminal-"));
        file = join(directory, "Shellbell.command");
        await writeFile(file, script, { mode: 0o700, flag: "wx" });
      } catch {
        await remove();
        throw new BackendUnavailable(
          "Terminal window could not be prepared",
          "Check that your Library/Caches folder can be written to, then try again.",
        );
      }
      try {
        await (
          options.execute ?? ((file, args) => run(file, args, { timeout: 5000, maxBuffer: 4096 }))
        )("/usr/bin/open", ["-a", application, file]);
      } catch {
        await remove();
        throw new BackendUnavailable(
          "Terminal could not be launched",
          "Check that Terminal opens on your computer, then try again.",
        );
      }
      // The script normally deletes itself; this covers a window that never ran it.
      setTimeout(() => void remove(), lifetime).unref?.();
    },
  };
}
