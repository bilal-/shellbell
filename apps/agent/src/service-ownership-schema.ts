import { FpSchema } from "@shellbell/protocol";
import { z } from "zod";
import { NativePathSchema } from "./local-path-schema.js";
export const InstallationModeSchema = z.enum(["desktop", "headless"]);
export type InstallationMode = z.infer<typeof InstallationModeSchema>;
export const OwnershipPhaseSchema = z.enum([
  "prepared",
  "source-stopped",
  "destination-started",
  "recovery-required",
]);
export type OwnershipPhase = z.infer<typeof OwnershipPhaseSchema>;
export const NativeExecutionKindSchema = z.enum(["manual", "persistent", "desktop"]);
export type NativeExecutionKind = z.infer<typeof NativeExecutionKindSchema>;
export const OwnershipIntentSchema = z.strictObject({
  id: z.uuid(),
  source: z.enum(["desktop", "headless", "legacy-native"]).nullable(),
  target: InstallationModeSchema,
  sourceManager: z
    .enum(["desktop-child", "native-manual", "native-persistent", "launchd", "systemd"])
    .nullable(),
  sourceInstance: z.uuid().nullable(),
  stateDir: NativePathSchema,
  computerFp: FpSchema,
  targetBundlePath: NativePathSchema.nullable(),
  targetVersion: z.string().min(1).max(256),
  phase: OwnershipPhaseSchema,
});
export type OwnershipIntent = z.infer<typeof OwnershipIntentSchema>;
export const OwnerRecordSchema = z.strictObject({
  v: z.literal(1),
  revision: z.uuid(),
  mode: InstallationModeSchema,
  consented: z.boolean(),
  startupEnabled: z.boolean(),
  transition: OwnershipIntentSchema.nullable(),
});
export type OwnerRecord = z.infer<typeof OwnerRecordSchema>;
