import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

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
  return (env.PATH?.split(delimiter) ?? []).map((path) => resolve(path, name)).find(executable);
}
