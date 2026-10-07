import { findTerminalExecutable } from "../executable.js";

export function findHerdrExecutable(
  env: NodeJS.ProcessEnv = process.env,
  executable?: (path: string) => boolean,
): string | undefined {
  return findTerminalExecutable("herdr", env, executable);
}
