import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

// The desktop service starts with a fixed PATH that omits per-user installs,
// where Herdr's installer and cargo place their binaries.
const USER_BIN_DIRS = [".local/bin", ".cargo/bin"];

/** Resolve the same PATH candidate for native probes and fixed attach commands. */
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
  const home = env.HOME || homedir();
  const userDirs = isAbsolute(home) ? USER_BIN_DIRS.map((dir) => join(home, dir)) : [];
  return [...(env.PATH?.split(delimiter) ?? []), ...userDirs]
    .map((path) => resolve(path, name))
    .find(executable);
}
