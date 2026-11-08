import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/\p{Cc}/u.test(s));
export const PluginId = z.string().regex(/^[a-z0-9-]{1,32}$/);
const command = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const file = z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/);
export const PluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: PluginId,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: text(40),
  description: text(120),
  homepage: z.url().refine((s) => new URL(s).protocol === "https:"),
  platforms: z
    .array(z.enum(["darwin", "linux"]))
    .min(1)
    .max(2),
  requires: z.object({ command, help: text(240) }),
  page: z.object({ name: text(40), args: z.array(text(4096)).max(63) }),
  icon: z.object({ file, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export const RegistryEntrySchema = z.object({
  id: PluginId,
  name: text(40),
  description: text(120),
  command,
  repository: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  directory: z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
