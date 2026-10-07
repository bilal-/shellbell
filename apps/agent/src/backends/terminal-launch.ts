import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BackendUnavailable } from "./types.js";

export interface TerminalCommand {
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}
export interface TerminalWindowLauncher {
  id: string;
  label: string;
  available(): boolean;
  launch(command: TerminalCommand): Promise<void>;
}
const run = promisify(execFile);

export function findTerminalExecutable(
  name: "tmux" | "herdr",
  env: NodeJS.ProcessEnv = process.env,
  executable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  return (env.PATH?.split(delimiter) ?? []).map((path) => resolve(path, name)).find(executable);
}

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
      try {
        // A separate instance accepts launch arguments even when the normal app is already open.
        // It does not restore ordinary Ghostty windows or write its own window layout on exit.
        await (
          options.execute ?? ((file, args) => run(file, args, { timeout: 5000, maxBuffer: 4096 }))
        )("/usr/bin/open", [
          "-n",
          "-g",
          "-a",
          application,
          "--args",
          "--initial-window=true",
          "--window-save-state=never",
          "--quit-after-last-window-closed=true",
          `--initial-command=${line}`,
        ]);
      } catch {
        throw new BackendUnavailable(
          "Ghostty could not be launched",
          "Check the session list before retrying; the session may already exist.",
        );
      }
    },
  };
}
