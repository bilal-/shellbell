import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import type { Command } from "commander";
import { defaultConfig, type Paths, paths } from "./config.js";
import { type HostInitMode, initializeLinuxHost } from "./host-init.js";
import { type LinuxHostOptions, type LinuxPaths, resolveLinuxPaths } from "./host-paths.js";
import { requireLinuxState } from "./host-state.js";

/** Shared selection for foreground and ordinary storage commands; never writes. */
export function selectAgentPaths(
  platform: NodeJS.Platform = process.platform,
  linuxOptions?: LinuxHostOptions,
): Paths {
  if (platform !== "linux") return paths();
  const p = resolveLinuxPaths(linuxOptions);
  requireLinuxState(p);
  return p;
}

export interface HostCommandDeps {
  platform?: NodeJS.Platform;
  selectPaths?: () => LinuxPaths;
  hostname?: () => string;
}

export function addHostCommand(root: Command, deps: HostCommandDeps = {}): void {
  root
    .command("host")
    .description("manage explicit Linux host identity state")
    .command("init")
    .description("initialize Linux host state without starting an agent or enabling autostart")
    .option("--new", "create a new independent host identity")
    .option("--adopt <absolute-source>", "copy validated inactive legacy identity and pairings")
    .option(
      "--confirm-source-inactive",
      "confirm no agent uses the source, including on other hosts",
    )
    .action(async (options: { new?: boolean; adopt?: string; confirmSourceInactive?: boolean }) => {
      const json = Boolean(root.opts<{ json?: boolean }>().json);
      let failure: string | undefined;
      if ((deps.platform ?? process.platform) !== "linux")
        failure = "host init is available only on Linux";
      else if (Boolean(options.new) === (options.adopt !== undefined))
        failure = "choose exactly one of --new or --adopt <absolute-source>";
      else if (
        options.adopt !== undefined &&
        (!isAbsolute(options.adopt) || !options.confirmSourceInactive)
      )
        failure = "adoption requires an absolute source and --confirm-source-inactive";
      else if (options.new && options.confirmSourceInactive)
        failure = "--confirm-source-inactive requires --adopt";
      if (!failure) {
        try {
          const p = (deps.selectPaths ?? resolveLinuxPaths)();
          const mode: HostInitMode = options.new
            ? { kind: "new" }
            : { kind: "adopt", source: options.adopt!, confirmSourceInactive: true };
          const config = {
            ...defaultConfig(),
            computerName: (deps.hostname ?? hostname)().replace(/\.local$/, "") || "Linux",
          };
          const result = await initializeLinuxHost(p, mode, config);
          const output = { status: result.status, next: "shellbell start" };
          if (json) console.log(JSON.stringify(output));
          else
            console.log(
              `  host state ${result.status}; run shellbell start for foreground operation`,
            );
          return;
        } catch {
          failure =
            "Linux host initialization failed; inspect host state and runtime permissions. Existing or partial state is preserved; do not delete paired keys to retry. Use shellbell doctor for admission diagnostics.";
        }
      }
      process.exitCode = 2;
      if (json) console.log(JSON.stringify({ error: failure }));
      else console.error(`  ${failure}`);
    });
}
