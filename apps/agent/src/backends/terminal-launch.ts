import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { BackendUnavailable, NotShownOnComputer } from "./types.js";

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
