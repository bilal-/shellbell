import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { PageRegistry, type PageRegistryOptions } from "../web/page-registry.js";
import { digest, type PluginPackage, PluginPackages, pluginRegistry } from "./package.js";
import { PluginError, type RegistryEntry } from "./schema.js";

const metadata = z.object({
  id: z.string(),
  version: z.string(),
  repository: z.string(),
  revision: z.string(),
  manifestHash: z.string(),
  configurationHash: z.string(),
  localPreview: z.boolean(),
});
type Metadata = z.infer<typeof metadata>;
function configurationHash(record: Record<string, unknown>): string {
  const { shellbellPlugin: _, ...config } = record;
  return digest(
    JSON.stringify(config, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
    ),
  );
}
function parseRecord(bytes: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new PluginError(
    "invalid-registration",
    "The existing page registration is invalid. It has not been changed.",
  );
}
function marker(record: Record<string, unknown>, id: string): Metadata | null {
  const parsed = metadata.safeParse(record.shellbellPlugin);
  return parsed.success && parsed.data.id === id ? parsed.data : null;
}
export interface PluginStatus {
  id: string;
  name: string;
  description: string;
  repository: string;
  revision: string;
  installed: boolean;
  available: boolean;
  command: string;
  executable?: string;
  version?: string;
  status: "available" | "missing-command" | "installed" | "needs-attention" | "custom-page";
  detail?: string;
  localPreview?: boolean;
}
export interface PluginManagerOptions extends Omit<PageRegistryOptions, "changed" | "create"> {
  env: NodeJS.ProcessEnv;
  catalog?: readonly RegistryEntry[];
  fetch?: typeof fetch;
}
/** Shellbell owns discovery/install state. Providers own the declarative package. */
export class PluginManager {
  readonly catalog: readonly RegistryEntry[];
  private readonly inspect: PageRegistry;
  private readonly writer: PageRegistry;
  private readonly packages: PluginPackages;
  private readonly controller = new AbortController();
  constructor(private readonly options: PluginManagerOptions) {
    this.catalog = options.catalog ?? pluginRegistry;
    this.inspect = new PageRegistry({ ...options, create: false });
    this.writer = new PageRegistry({ ...options, create: true });
    this.packages = new PluginPackages({
      files: this.inspect,
      fetch: options.fetch,
      signal: this.controller.signal,
    });
  }
  close(): void {
    this.controller.abort();
    this.inspect.close();
    this.writer.close();
  }
  private entry(id: string): RegistryEntry {
    const entry = this.catalog.find((p) => p.id === id);
    if (!entry)
      throw new PluginError(
        "unknown-plugin",
        "No such plugin in Shellbell's registry. Run shellbell plugins list.",
      );
    return entry;
  }
  private executable(command: string): string | undefined {
    const directories = [
      ...(this.options.env.PATH?.split(delimiter) ?? []),
      join(this.options.home, ".local/bin"),
    ];
    for (const directory of directories) {
      if (!isAbsolute(directory)) continue;
      const candidate = resolve(directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
    return undefined;
  }
  async list(): Promise<PluginStatus[]> {
    return Promise.all(
      this.catalog.map(async (entry) => {
        const executable = this.executable(entry.command);
        const result: PluginStatus = {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          repository: entry.repository,
          revision: entry.revision,
          command: entry.command,
          installed: false,
          available: executable !== undefined,
          ...(executable && { executable }),
          status: executable ? "available" : "missing-command",
        };
        try {
          const bytes = await this.inspect.registrationFile(entry.id);
          if (!bytes) return result;
          const record = parseRecord(bytes),
            own = marker(record, entry.id);
          if (!own)
            return {
              ...result,
              status: "custom-page",
              detail: "A custom page already uses this ID. It will not be replaced.",
            };
          const installedExecutable =
            Array.isArray(record.start) && typeof record.start[0] === "string"
              ? record.start[0]
              : undefined;
          let usable = false;
          try {
            if (installedExecutable && isAbsolute(installedExecutable)) {
              accessSync(installedExecutable, constants.X_OK);
              usable = statSync(installedExecutable).isFile();
            }
          } catch {}
          return {
            ...result,
            installed: true,
            available: executable !== undefined || usable,
            ...(!executable && usable && { executable: installedExecutable! }),
            version: own.version,
            localPreview: own.localPreview,
            status: usable ? "installed" : "needs-attention",
            ...(!usable && {
              detail:
                "The registered executable is missing. Install the application, then reinstall this plugin.",
            }),
          };
        } catch {
          return {
            ...result,
            status: "needs-attention",
            detail:
              "The page registration could not be read safely. Run shellbell pages for details.",
          };
        }
      }),
    );
  }
  async info(
    id: string,
    fromDirectory?: string,
  ): Promise<{ entry: RegistryEntry; package: PluginPackage; executable?: string }> {
    const entry = this.entry(id),
      pkg = await this.packages.load(entry, fromDirectory);
    return { entry, package: pkg, executable: this.executable(entry.command) };
  }
  async install(
    id: string,
    fromDirectory?: string,
  ): Promise<{ id: string; changed: boolean; version: string; localPreview: boolean }> {
    const entry = this.entry(id),
      executable = this.executable(entry.command);
    if (!executable)
      throw new PluginError(
        "missing-command",
        `Install ${entry.name} first, then run shellbell plugins install ${entry.id}. Shellbell does not install the application.`,
      );
    if (this.controller.signal.aborted)
      throw new PluginError("cancelled", "Plugin action cancelled.");
    const previous = await this.inspect.registrationFile(id);
    if (previous) {
      const record = parseRecord(previous),
        own = marker(record, id);
      if (!own)
        throw new PluginError(
          "custom-page",
          "A custom page already uses this ID. It has not been replaced.",
        );
      if (own.configurationHash !== configurationHash(record))
        throw new PluginError(
          "customized",
          "This plugin's page was customized. Keep it, or uninstall the plugin before installing it again.",
        );
    }
    const pkg = await this.packages.load(entry, fromDirectory),
      platform = this.options.platform ?? process.platform;
    if (!pkg.manifest.platforms.some((p) => p === platform))
      throw new PluginError(
        "unsupported-platform",
        "This plugin does not support this computer's operating system.",
      );
    const iconName = pkg.icon ? `plugin-${id}-${digest(pkg.icon)}.png` : undefined;
    const record: Record<string, unknown> = {
      shellbell: 1,
      name: pkg.manifest.page.name,
      description: pkg.manifest.description,
      start: [executable, ...pkg.manifest.page.args],
      startHelp: pkg.manifest.requires.help.slice(0, 120),
      ...(iconName && { icon: join(this.writer.directory, iconName) }),
    };
    record.shellbellPlugin = {
      id,
      version: pkg.manifest.version,
      repository: entry.repository,
      revision: entry.revision,
      manifestHash: pkg.manifestHash,
      configurationHash: configurationHash(record),
      localPreview: pkg.localPreview,
    } satisfies Metadata;
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    let repairedIcon = false;
    if (iconName && pkg.icon) {
      try {
        await this.writer.putFile(iconName, pkg.icon);
        repairedIcon = true;
      } catch (error) {
        const existing = await this.inspect.trustedFile(
          join(this.writer.directory, iconName),
          65536,
        );
        if (!existing.equals(pkg.icon)) throw error;
      }
    }
    if (previous?.equals(bytes))
      return {
        id,
        changed: repairedIcon,
        version: pkg.manifest.version,
        localPreview: pkg.localPreview,
      };
    await this.writer.putFile(`${id}.json`, bytes, previous);
    return { id, changed: true, version: pkg.manifest.version, localPreview: pkg.localPreview };
  }
  async uninstall(id: string): Promise<{ id: string; changed: boolean }> {
    this.entry(id);
    if (this.controller.signal.aborted)
      throw new PluginError("cancelled", "Plugin action cancelled.");
    const previous = await this.inspect.registrationFile(id);
    if (!previous) return { id, changed: false };
    const record = parseRecord(previous);
    if (!marker(record, id))
      throw new PluginError(
        "custom-page",
        "This is a custom page, not a Shellbell-managed plugin. It has not been removed.",
      );
    await this.writer.removeRegistration(id, previous);
    return { id, changed: true };
  }
}
