import { FpSchema } from "@shellbell/protocol";
import { z } from "zod";
import { CONFIG_KEYS } from "../config-values.js";
import {
  ControlPairingOpenSchema,
  ControlRuntimeSchema,
  ControlV2DataSchemas,
  ControlV2EventSchema,
} from "../control-v2-protocol.js";
import { NativePathSchema } from "../local-path-schema.js";
import type { LocalStatus } from "../local-status.js";
import {
  InstallationModeSchema,
  type NativeExecutionKind,
  NativeExecutionKindSchema,
  OwnershipIntentSchema,
} from "../service-ownership-schema.js";

export {
  type NativeExecutionKind,
  NativeExecutionKindSchema,
} from "../service-ownership-schema.js";

import { AgentConfigSchema } from "../state-schema.js";

export { NativePathSchema } from "../local-path-schema.js";

export const NATIVE_RECORD_BYTES = 2 * 1024 * 1024;
export const NATIVE_RECOVERY_BYTES = 1024 * 1024;
const SafePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const RevisionSchema = z.uuid();
const ConfigRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);
const BoundedString = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 4096);
export const NativeModeSchema = z.enum(["manual", "persistent"]);
export type NativeMode = z.infer<typeof NativeModeSchema>;
/** Never map a desktop child to a launchd label. */
export function requireNativeManagerMode(mode: NativeExecutionKind): NativeMode {
  if (mode === "desktop") throw new NativeControllerError("conflict");
  return mode;
}
export const NativePhaseSchema = z.enum([
  "prepared",
  "source-stop-requested",
  "source-stopped",
  "destination-start-requested",
  "awaiting-approval",
  "destination-ready",
  "recovery-required",
]);
export type NativePhase = z.infer<typeof NativePhaseSchema>;
export const NativeEnvironmentSchema = z.strictObject({
  PATH: BoundedString.refine((value) =>
    value.split(":").every((path) => NativePathSchema.safeParse(path).success),
  ),
  SHELLBELL_DIR: NativePathSchema,
  SHELLBELL_SERVICE_INSTANCE: z.uuid(),
  HERDR_SOCKET_PATH: NativePathSchema.optional(),
  XDG_CONFIG_HOME: NativePathSchema.optional(),
});
export const NativeSelectionSchema: z.ZodType<NativeSelection> = z
  .strictObject({
    mode: NativeExecutionKindSchema,
    stateDir: NativePathSchema,
    computerFp: FpSchema,
    serviceInstance: z.uuid(),
    bundlePath: NativePathSchema,
    bundleId: z.literal("sh.bilal.shellbell.host"),
    agentVersion: z.string().min(1),
    environment: NativeEnvironmentSchema,
  })
  .refine(
    (value) =>
      value.environment.SHELLBELL_DIR === value.stateDir &&
      value.environment.SHELLBELL_SERVICE_INSTANCE === value.serviceInstance,
  );
export interface NativeSelection {
  mode: NativeExecutionKind;
  stateDir: string;
  computerFp: string;
  serviceInstance: string;
  bundlePath: string;
  bundleId: "sh.bilal.shellbell.host";
  agentVersion: string;
  environment: Record<string, string>;
}
export const NativeRecoverySchema = z.strictObject({
  id: z.uuid(),
  definitionPath: NativePathSchema,
  rawBase64: z
    .string()
    .max(4 * Math.ceil(NATIVE_RECOVERY_BYTES / 3))
    .refine(
      (value) =>
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
        Buffer.from(value, "base64").byteLength <= NATIVE_RECOVERY_BYTES &&
        Buffer.from(value, "base64").toString("base64") === value,
    ),
  sha256: ConfigRevisionSchema,
  wasLoaded: z.boolean(),
  stateDir: NativePathSchema,
  computerFp: FpSchema,
});
export type NativeRecovery = z.infer<typeof NativeRecoverySchema>;
const TransitionSummarySchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(["start", "stop", "restart", "remove", "recover"]),
  phase: NativePhaseSchema,
});
export const NativeTransitionSchema = TransitionSummarySchema.extend({
  source: NativeSelectionSchema.nullable(),
  destination: NativeSelectionSchema.nullable(),
  recoveryId: z.uuid().nullable(),
  restoreLegacy: z.strictObject({ restartPrevious: z.boolean() }).optional(),
}).refine((value) => value.restoreLegacy === undefined || value.action === "recover");
export interface NativeTransition {
  id: string;
  action: "start" | "stop" | "restart" | "remove" | "recover";
  phase: NativePhase;
  source: NativeSelection | null;
  destination: NativeSelection | null;
  recoveryId: string | null;
  restoreLegacy?: { restartPrevious: boolean };
}
export const NativeRecordSchema = z
  .strictObject({
    v: z.literal(1),
    revision: RevisionSchema,
    selection: NativeSelectionSchema.nullable(),
    transition: NativeTransitionSchema.nullable(),
    recovery: NativeRecoverySchema.nullable(),
  })
  .refine(
    (value) =>
      value.transition?.recoveryId == null || value.transition.recoveryId === value.recovery?.id,
  );
export interface NativeRecord {
  v: 1;
  revision: string;
  selection: NativeSelection | null;
  transition: NativeTransition | null;
  recovery: NativeRecovery | null;
}
export const NativeJobSchema = z.strictObject({
  registration: z.enum(["not-registered", "enabled", "requires-approval", "not-found", "unknown"]),
  loaded: z.boolean(),
  pid: SafePositiveInteger.nullable(),
  bundlePath: NativePathSchema.nullable(),
});
export type NativeJob = z.infer<typeof NativeJobSchema>;
export const NativeHelperResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(1),
    ok: z.literal(true),
    status: z.enum(["not-registered", "enabled", "requires-approval", "not-found"]),
  }),
  z.strictObject({
    v: z.literal(1),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(["unavailable", "denied", "invalid-bundle", "operation-failed"]),
    }),
  }),
]);
export type NativeHelperResponse = z.infer<typeof NativeHelperResponseSchema>;
export const NativeExpectedSchema = z.strictObject({
  revision: RevisionSchema.nullable(),
  runtime: ControlRuntimeSchema.extend({ stateDir: NativePathSchema }).nullable(),
});
export type NativeExpected = z.infer<typeof NativeExpectedSchema>;
export const NativeOwnershipStatusSchema = z.strictObject({
  revision: RevisionSchema.nullable(),
  mode: z.enum(["desktop", "headless", "legacy-native"]).nullable(),
  consented: z.boolean(),
  startupEnabled: z.boolean().nullable(),
  transition: OwnershipIntentSchema.nullable(),
});
export type NativeOwnershipStatus = z.infer<typeof NativeOwnershipStatusSchema>;
export const NativeStatusSchema = z.strictObject({
  desktopLogin: NativeJobSchema.shape.registration.optional(),
  desktop: NativeJobSchema.optional(),
  ownership: NativeOwnershipStatusSchema.optional(),
  revision: RevisionSchema.nullable(),
  selection: NativeSelectionSchema.nullable(),
  transition: TransitionSummarySchema.nullable(),
  recoveryAvailable: z.boolean(),
  manualRecoveryAvailable: z.boolean().optional(),
  legacy: z.strictObject({
    installed: z.boolean(),
    loaded: z.boolean(),
    stateDir: NativePathSchema.nullable(),
  }),
  manual: NativeJobSchema,
  persistent: NativeJobSchema,
  local: z.strictObject({
    kind: z.enum(["verified", "foreign", "absent", "unverified"]),
    status: ControlV2DataSchemas.status
      .safeExtend({ process: ControlRuntimeSchema.extend({ stateDir: NativePathSchema }) })
      .nullable(),
  }),
});
export interface NativeStatus {
  desktopLogin?: NativeJob["registration"];
  desktop?: NativeJob;
  ownership?: NativeOwnershipStatus;
  revision: string | null;
  selection: NativeSelection | null;
  transition: Pick<NativeTransition, "id" | "action" | "phase"> | null;
  recoveryAvailable: boolean;
  manualRecoveryAvailable?: boolean;
  legacy: { installed: boolean; loaded: boolean; stateDir: string | null };
  manual: NativeJob;
  persistent: NativeJob;
  local: { kind: "verified" | "foreign" | "absent" | "unverified"; status: LocalStatus | null };
}
export const NativeSettingsSchema = z.strictObject({
  saved: AgentConfigSchema.strict(),
  savedRevision: ConfigRevisionSchema,
  appliedRevision: ConfigRevisionSchema.nullable(),
  applied: z.enum(["not-running", "unknown", "matches", "restart-required"]),
});
export type NativeSettings = z.infer<typeof NativeSettingsSchema>;
export const NativeDataSchemas = {
  hello: z.strictObject({
    version: z.literal(1),
    agentVersion: z.string().min(1),
    capabilities: z.tuple([
      z.literal("status"),
      z.literal("settings"),
      z.literal("lifecycle"),
      z.literal("pairing"),
      z.literal("devices"),
      z.literal("diagnostics"),
    ]),
  }),
  status: NativeStatusSchema,
  "desktop.setup": NativeStatusSchema,
  "desktop.login.set": NativeStatusSchema,
  "desktop.start": NativeStatusSchema,
  "desktop.stop": NativeStatusSchema,
  "ownership.convert": NativeStatusSchema,
  "ownership.recover": NativeStatusSchema,
  "settings.get": NativeSettingsSchema,
  "settings.set": NativeSettingsSchema,
  "service.start": NativeStatusSchema,
  "service.stop": NativeStatusSchema,
  "service.restart": NativeStatusSchema,
  "service.remove": NativeStatusSchema,
  "service.recover": NativeStatusSchema,
  diagnostics: z.strictObject({
    checks: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(64),
          ok: z.boolean(),
          severity: z.enum(["pass", "warning", "error"]),
          detail: z.string().max(1024),
          fix: z.string().max(2048).optional(),
          required: z.boolean().optional(),
        }),
      )
      .max(32),
  }),
  devices: ControlV2DataSchemas.devices,
  "devices.revoke": ControlV2DataSchemas["devices.revoke"],
  "pairing.open": ControlPairingOpenSchema,
  "pairing.close": ControlV2DataSchemas["pairing.close"],
  "pairing.confirm": ControlV2DataSchemas["pairing.confirm"],
} as const;
const RequestBase = { v: z.literal(1), id: SafePositiveInteger };
const ExpectArgs = z.strictObject({ expect: NativeExpectedSchema });
const OwnerArgs = ExpectArgs.extend({ ownerRevision: RevisionSchema.nullable() });
const PairingRequest = ControlV2EventSchema.options[0];
const FlowIdSchema = PairingRequest.shape.flowId;
export const NativeRequestSchema = z.discriminatedUnion("cmd", [
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("desktop.login.set"),
    args: OwnerArgs.extend({ enabled: z.boolean() }),
  }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("desktop.setup"),
    args: OwnerArgs.extend({ consent: z.literal(true) }),
  }),
  z.strictObject({ ...RequestBase, cmd: z.literal("desktop.start"), args: OwnerArgs }),
  z.strictObject({ ...RequestBase, cmd: z.literal("desktop.stop"), args: OwnerArgs }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("ownership.convert"),
    args: OwnerArgs.extend({ target: InstallationModeSchema, consent: z.literal(true) }),
  }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("ownership.recover"),
    args: OwnerArgs.extend({ intentId: z.uuid() }),
  }),
  z.strictObject({ ...RequestBase, cmd: z.literal("hello") }),
  z.strictObject({ ...RequestBase, cmd: z.literal("status") }),
  z.strictObject({ ...RequestBase, cmd: z.literal("settings.get") }),
  z.strictObject({ ...RequestBase, cmd: z.literal("diagnostics") }),
  z.strictObject({ ...RequestBase, cmd: z.literal("devices") }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("settings.set"),
    args: ExpectArgs.extend({
      configRevision: ConfigRevisionSchema,
      changes: z
        .array(z.strictObject({ key: z.enum(CONFIG_KEYS), value: BoundedString }))
        .min(1)
        .max(6)
        .refine((changes) => new Set(changes.map((change) => change.key)).size === changes.length),
    }),
  }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("service.start"),
    args: ExpectArgs.extend({
      mode: NativeModeSchema,
      consent: z.literal(true),
      migrateLegacy: z.boolean(),
      stateDir: NativePathSchema.optional(),
    }),
  }),
  z.strictObject({ ...RequestBase, cmd: z.literal("service.stop"), args: ExpectArgs }),
  z.strictObject({ ...RequestBase, cmd: z.literal("service.restart"), args: ExpectArgs }),
  z.strictObject({ ...RequestBase, cmd: z.literal("service.remove"), args: ExpectArgs }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("service.recover"),
    args: ExpectArgs.extend({
      action: z.enum(["continue", "restore-legacy", "discard-backup", "use-manual"]),
      restartPrevious: z.boolean(),
      consent: z.literal(true),
    }).refine((value) => !value.restartPrevious || value.action === "restore-legacy"),
  }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("devices.revoke"),
    args: ExpectArgs.extend({ phoneFp: FpSchema }),
  }),
  z.strictObject({ ...RequestBase, cmd: z.literal("pairing.open"), args: ExpectArgs }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("pairing.close"),
    args: ExpectArgs.extend({ flowId: FlowIdSchema }),
  }),
  z.strictObject({
    ...RequestBase,
    cmd: z.literal("pairing.confirm"),
    args: ExpectArgs.extend({
      flowId: FlowIdSchema,
      challengeId: PairingRequest.shape.challengeId,
      phoneFp: FpSchema,
      accept: z.boolean(),
    }),
  }),
]);
export type NativeRequest = z.infer<typeof NativeRequestSchema>;
export const NativeErrorCodeSchema = z.enum([
  "bad-request",
  "unsupported-version",
  "handshake-required",
  "busy",
  "unavailable",
  "conflict",
  "unsafe-state",
  "invalid-config",
  "upgrade-required",
  "startup-unavailable",
  "delivery-unknown",
  "approval-required",
  "recovery-required",
  "operation-failed",
  "response-too-large",
  "timeout",
]);
export type NativeErrorCode = z.infer<typeof NativeErrorCodeSchema>;
export class NativeControllerError extends Error {
  constructor(public readonly code: NativeErrorCode) {
    super(code);
    this.name = "NativeControllerError";
  }
}
export const NativeResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ...RequestBase,
    ok: z.literal(true),
    data: z.union(Object.values(NativeDataSchemas)),
  }),
  z.strictObject({
    ...RequestBase,
    ok: z.literal(false),
    error: z.strictObject({ code: NativeErrorCodeSchema }),
  }),
]);
export type NativeResponse = z.infer<typeof NativeResponseSchema>;
export const NativeEventSchema = z.discriminatedUnion("event", [
  PairingRequest.extend({ v: z.literal(1) }),
  ControlV2EventSchema.options[1].extend({ v: z.literal(1) }),
]);
export type NativeEvent = z.infer<typeof NativeEventSchema>;
export interface NativeRecordTransaction {
  readonly current: NativeRecord | null;
  publish(next: Omit<NativeRecord, "revision">): NativeRecord;
}
