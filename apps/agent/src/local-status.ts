import { isAbsolute } from "node:path";
import {
  BackendNameSchema,
  FpSchema,
  MAX_PAIRINGS,
  MAX_TERMINAL_ADAPTERS,
} from "@shellbell/protocol";
import { z } from "zod";
import { BACKEND_ORDER } from "./backends/registry.js";

export const LOCAL_CONTROL_VERSION = 1 as const;

const LocalBackendStatusSchema = z.object({
  name: BackendNameSchema,
  connected: z.boolean(),
});

export type LocalBackendStatus = z.infer<typeof LocalBackendStatusSchema>;

const backendsSchema = z.array(LocalBackendStatusSchema).max(MAX_TERMINAL_ADAPTERS);

export const LocalRuntimeSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  agentVersion: z.string().min(1),
  computerFp: FpSchema,
  stateDir: z.string().min(1).refine(isAbsolute, "state directory must be absolute"),
  serviceInstance: z.uuid().nullable(),
});
export type LocalRuntime = z.infer<typeof LocalRuntimeSchema>;

const runtimeShape = {
  controlVersion: z.literal(LOCAL_CONTROL_VERSION),
  process: LocalRuntimeSchema,
  backends: backendsSchema,
  terminalReady: z.boolean(),
};

function validateReadiness(
  value: { backends: readonly LocalBackendStatus[]; terminalReady: boolean },
  ctx: z.RefinementCtx,
): void {
  if (
    value.backends.length < BACKEND_ORDER.length ||
    BACKEND_ORDER.some((name, index) => value.backends[index]?.name !== name) ||
    new Set(value.backends.map((backend) => backend.name)).size !== value.backends.length ||
    value.backends
      .slice(BACKEND_ORDER.length)
      .some((backend, index, extras) => index > 0 && backend.name < extras[index - 1]!.name)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["backends"],
      message: "backend status must contain each known backend in protocol order",
    });
  }
  if (value.terminalReady !== value.backends.some((backend) => backend.connected)) {
    ctx.addIssue({
      code: "custom",
      path: ["terminalReady"],
      message: "terminal readiness must match backend connectivity",
    });
  }
}

const phoneNameSchema = z.string().min(1).max(64);

export const TransportDiagnosticsSchema = z.object({
  route: z.enum(["relay", "direct"]).nullable(),
  ready: z.boolean(),
  phase: z.string().max(32),
  lastFailure: z.string().max(32).nullable(),
  relaySent: z.number().int().nonnegative(),
  relayReceived: z.number().int().nonnegative(),
  directSent: z.number().int().nonnegative(),
  directReceived: z.number().int().nonnegative(),
});

export const LocalStatusSchema = z
  .object({
    ...runtimeShape,
    relayOnline: z.boolean(),
    sessions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    phones: z
      .array(
        z.object({
          phoneFp: FpSchema,
          name: phoneNameSchema,
          lastSeenAt: z.string().nullable(),
        }),
      )
      .max(MAX_PAIRINGS),
    connected: z
      .array(
        z.object({
          phoneFp: FpSchema,
          name: phoneNameSchema,
          viewed: z.string().nullable(),
          transport: TransportDiagnosticsSchema.optional(),
        }),
      )
      .max(MAX_PAIRINGS),
  })
  .superRefine(validateReadiness);

export type LocalStatus = z.infer<typeof LocalStatusSchema>;

/** Reads the launchd-provided runtime identity only for a service process. */
export function serviceInstanceFromEnvironment(
  isService: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isService) return null;
  const value = env.SHELLBELL_SERVICE_INSTANCE;
  if (value === undefined) return null;
  if (!z.uuid().safeParse(value).success) {
    throw new Error("SHELLBELL_SERVICE_INSTANCE must be a valid UUID");
  }
  return value;
}
