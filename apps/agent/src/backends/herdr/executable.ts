import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function findHerdrExecutable(
  env: NodeJS.ProcessEnv = process.env,
  executable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  return (env.PATH?.split(delimiter) ?? [])
    .map((directory) => resolve(directory, "herdr"))
    .find(executable);
}
