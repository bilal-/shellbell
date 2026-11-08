import { createHash } from "node:crypto";
import { join } from "node:path";
import { WEB_LIMITS } from "@shellbell/protocol";
import { z } from "zod";
import { type PageRegistry, validPagePNG } from "../web/page-registry.js";
import entries from "./registry.json" with { type: "json" };
import {
  PluginError,
  type PluginManifest,
  PluginManifestSchema,
  type RegistryEntry,
  RegistryEntrySchema,
} from "./schema.js";

export const pluginRegistry = z.array(RegistryEntrySchema).max(WEB_LIMITS.pages).parse(entries);
export const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export interface PluginPackage {
  manifest: PluginManifest;
  manifestHash: string;
  icon?: Buffer;
  localPreview: boolean;
}
export class PluginPackages {
  constructor(
    private readonly options: { files: PageRegistry; fetch?: typeof fetch; signal?: AbortSignal },
  ) {}
  async load(entry: RegistryEntry, fromDirectory?: string): Promise<PluginPackage> {
    const file = async (name: string, limit: number) =>
      fromDirectory
        ? this.options.files.trustedFile(join(fromDirectory, name), limit)
        : this.github(entry, name, limit);
    const bytes = await file("shellbell-plugin.json", 16384);
    let manifest: PluginManifest;
    try {
      manifest = PluginManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new PluginError(
        "invalid-package",
        "The repository has an invalid Shellbell plugin manifest.",
      );
    }
    if (manifest.id !== entry.id || manifest.requires.command !== entry.command)
      throw new PluginError("invalid-package", "The plugin does not match its registry entry.");
    const icon = manifest.icon ? await file(manifest.icon.file, WEB_LIMITS.iconBytes) : undefined;
    if (icon && (!validPagePNG(icon) || digest(icon) !== manifest.icon!.sha256))
      throw new PluginError("invalid-icon", "The repository's plugin icon failed validation.");
    return {
      manifest,
      manifestHash: digest(bytes),
      icon,
      localPreview: fromDirectory !== undefined,
    };
  }
  private async github(entry: RegistryEntry, name: string, limit: number): Promise<Buffer> {
    const path = [...entry.directory.split("/"), name].map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${entry.repository}/contents/${path}?ref=${entry.revision}`;
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        headers: {
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "Shellbell-Plugins",
        },
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(10000),
          ...(this.options.signal ? [this.options.signal] : []),
        ]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new PluginError(
          "package-unavailable",
          "The pinned plugin package is unavailable on GitHub. It may not have been published yet.",
        );
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit)
            throw new PluginError("package-too-large", "The plugin file exceeds its size limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError(
        "download-failed",
        "Could not fetch the plugin from GitHub. Check your connection and try again.",
      );
    }
  }
}
