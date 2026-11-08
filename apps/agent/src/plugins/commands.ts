import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import { PageRegistrationError } from "../web/page-registry.js";
import { browsePlugins, type PluginBrowserIO, pluginListText } from "./browser.js";
import { PluginManager } from "./manager.js";
import { PluginError } from "./schema.js";

export interface PluginCommandDeps {
  manager?: () => PluginManager;
  io?: PluginBrowserIO;
}
export function addPluginCommands(root: Command, deps: PluginCommandDeps = {}): void {
  const json = () => root.opts<{ json?: boolean }>().json === true;
  const run = async (action: (manager: PluginManager) => Promise<void>) => {
    const manager = deps.manager?.() ?? new PluginManager({ home: homedir(), env: process.env });
    try {
      await action(manager);
    } catch (error) {
      const result =
        error instanceof PluginError
          ? { code: error.code, message: error.message }
          : error instanceof PageRegistrationError
            ? { code: "unsafe-registration", message: error.message }
            : {
                code: "plugin-failed",
                message: "The plugin action failed. Run shellbell pages for file diagnostics.",
              };
      if (json()) console.log(JSON.stringify({ error: result }));
      else console.error(`shellbell: ${result.message}`);
      process.exitCode = 1;
    } finally {
      manager.close();
    }
  };
  const list = async (manager: PluginManager) => {
    const entries = await manager.list();
    console.log(json() ? JSON.stringify(entries) : pluginListText(entries));
  };
  const plugins = root
    .command("plugins")
    .description("browse and install plugins from Shellbell's GitHub registry")
    .option(
      "--from-directory <directory>",
      "preview a provider's local plugin package instead of GitHub",
    )
    .action((options) =>
      run(async (manager) => {
        if (json()) await list(manager);
        else
          await browsePlugins(
            manager,
            deps.io ?? { input: process.stdin, output: process.stdout },
            localDirectory(options),
          );
      }),
    );
  function localDirectory(options: { fromDirectory?: string }): string | undefined {
    const directory =
      options.fromDirectory ?? plugins.opts<{ fromDirectory?: string }>().fromDirectory;
    return directory ? resolve(directory) : undefined;
  }
  plugins
    .command("list")
    .description("list available plugins and local installation state")
    .action(() => run(list));
  plugins
    .command("info <id>")
    .description("show a plugin's manifest and pinned GitHub source")
    .option("--from-directory <directory>", "preview a local provider package")
    .action((id, options) =>
      run(async (manager) => {
        const info = await manager.info(id, localDirectory(options));
        const result = {
          ...info.package.manifest,
          source: {
            repository: info.entry.repository,
            revision: info.entry.revision,
            localPreview: info.package.localPreview,
          },
          executable: info.executable,
        };
        if (json()) console.log(JSON.stringify(result));
        else
          console.log(
            `${result.name} ${result.version}\n${result.description}\nSource: github.com/${result.source.repository} @ ${result.source.revision}${result.source.localPreview ? " (local preview)" : ""}\nRequires: ${result.requires.command}\n${result.requires.help}\nStarts on page open: ${JSON.stringify([result.executable ?? result.requires.command, ...result.page.args])}`,
          );
      }),
    );
  plugins
    .command("install <id>")
    .description("install a plugin for an application already on this computer")
    .option("--from-directory <directory>", "install an explicit local provider package preview")
    .action((id, options) =>
      run(async (manager) => {
        const result = await manager.install(id, localDirectory(options));
        console.log(
          json()
            ? JSON.stringify(result)
            : `${id} plugin ${result.changed ? "installed" : "already installed"}${result.localPreview ? " (local preview)" : ""}. Open its page from your paired phone.`,
        );
      }),
    );
  plugins
    .command("uninstall <id>")
    .description("remove a plugin while keeping the application and its data")
    .action((id) =>
      run(async (manager) => {
        const result = await manager.uninstall(id);
        console.log(
          json()
            ? JSON.stringify(result)
            : `${id} plugin ${result.changed ? "removed" : "is not installed"}. The application and its data remain installed.`,
        );
      }),
    );
}
