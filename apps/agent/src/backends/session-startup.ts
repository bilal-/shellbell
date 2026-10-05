import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendName } from "@shellbell/protocol";
import { findHerdrExecutable } from "./herdr/executable.js";
import type { BackendRegistry } from "./registry.js";
import { BackendUnavailable } from "./types.js";

const APPLICATIONS = {
  iterm2: { bundle: "iTerm.app", label: "iTerm2" },
} as const;
const run = promisify(execFile);

export function macApplicationLauncher(
  name: keyof typeof APPLICATIONS,
  options: {
    platform?: string;
    roots?: readonly string[];
    exists?: (path: string) => boolean;
    execute?: (file: string, args: string[]) => Promise<unknown>;
  } = {},
) {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const roots = options.roots ?? ["/Applications", join(homedir(), "Applications")];
  const exists = options.exists ?? existsSync;
  const definition = APPLICATIONS[name];
  const application = () => roots.map((root) => join(root, definition.bundle)).find(exists);
  return {
    available: () => application() !== undefined,
    start: async () => {
      const path = application();
      if (!path)
        throw new BackendUnavailable(
          `${definition.label} is not installed`,
          `Install ${definition.label} on your computer.`,
        );
      try {
        await (
          options.execute ?? ((file, args) => run(file, args, { timeout: 5000, maxBuffer: 4096 }))
        )("/usr/bin/open", ["-g", "-a", path]);
      } catch {
        throw new BackendUnavailable(
          `Could not launch ${definition.label}`,
          `Open ${definition.label} on your computer and check its local API.`,
        );
      }
    },
  };
}

export function herdrServerLauncher(
  options: {
    env?: NodeJS.ProcessEnv;
    executable?: (path: string) => boolean;
    spawnImpl?: typeof spawn;
  } = {},
) {
  const binary = () => findHerdrExecutable(options.env, options.executable);
  return {
    available: () => binary() !== undefined,
    start: async (): Promise<void> => {
      const file = binary();
      if (!file)
        throw new BackendUnavailable("Herdr is not installed", "Install Herdr on your computer.");
      await new Promise<void>((resolve, reject) => {
        const child = (options.spawnImpl ?? spawn)(file, ["server"], {
          detached: true,
          stdio: "ignore",
          env: options.env ?? process.env,
        });
        child.once("error", () =>
          reject(new BackendUnavailable("Could not start Herdr", "Check your Herdr installation.")),
        );
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  };
}

export function waitForBackend(
  registry: Pick<BackendRegistry, "connected" | "on">,
  name: BackendName,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new BackendUnavailable(
          `${name} did not become ready`,
          "Check the terminal application's local API on your computer.",
        ),
      );
    }, timeoutMs);
    timeout.unref();
    const check = () => {
      if (!registry.connected().some((backend) => backend.name === name)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const unsubscribe = registry.on(check);
    check();
  });
}
