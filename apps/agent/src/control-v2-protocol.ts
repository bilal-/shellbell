import { isAbsolute } from "node:path";
import { BackendNameSchema, FpSchema, MAX_PAIRINGS } from "@shellbell/protocol";
import { z } from "zod";
import { CONTROL_LIMITS } from "./control-framing.js";
import { LocalStatusSchema, TransportDiagnosticsSchema } from "./local-status.js";

export { CONTROL_LIMITS } from "./control-framing.js";

const SafePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const FlowIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const PhoneNameSchema = z.string().min(1).max(64);

/** The ownership tuple deliberately reuses the existing local-status field names. */
export const ControlRuntimeSchema = z
  .object({
    pid: SafePositiveInteger,
    agentVersion: z.string().min(1),
    computerFp: FpSchema,
    stateDir: z.string().min(1).refine(isAbsolute, "state directory must be absolute"),
    serviceInstance: z.uuid().nullable(),
  })
  .strict();
export type ControlRuntime = z.infer<typeof ControlRuntimeSchema>;

const ControlBackendStatusSchema = z
  .object({
    name: BackendNameSchema,
    connected: z.boolean(),
  })
  .strict();
const ControlPhoneSchema = z
  .object({
    phoneFp: FpSchema,
    name: PhoneNameSchema,
    lastSeenAt: z.string().nullable(),
  })
  .strict();
const ControlConnectedPhoneSchema = z
  .object({
    phoneFp: FpSchema,
    name: PhoneNameSchema,
    viewed: z.string().nullable(),
    transport: TransportDiagnosticsSchema.strict().optional(),
  })
  .strict();

const ControlStatusSchema = z
  .object({
    controlVersion: z.literal(1),
    process: ControlRuntimeSchema,
    backends: z.array(ControlBackendStatusSchema),
    terminalReady: z.boolean(),
    relayOnline: z.boolean(),
    sessions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    phones: z.array(ControlPhoneSchema).max(MAX_PAIRINGS),
    connected: z.array(ControlConnectedPhoneSchema).max(MAX_PAIRINGS),
  })
  .strict()
  .superRefine((status, ctx) => {
    const validated = LocalStatusSchema.safeParse(status);
    if (!validated.success)
      ctx.addIssue({ code: "custom", message: "status must satisfy LocalStatus semantics" });
  });

const EmptyDataSchema = z.object({}).strict();
const ControlHelloSchema = z
  .object({
    version: z.literal(2),
    runtime: ControlRuntimeSchema,
    capabilities: z.tuple([
      z.literal("status"),
      z.literal("devices"),
      z.literal("pairing"),
      z.literal("revoke"),
    ]),
  })
  .strict();
const ControlDevicesSchema = z.array(ControlPhoneSchema).max(MAX_PAIRINGS);
const ControlRevokeSchema = z.object({ removed: z.boolean() }).strict();
export const ControlPairingOpenSchema = z
  .object({
    flowId: FlowIdSchema,
    qrText: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).byteLength <= CONTROL_LIMITS.lineBytes),
    expiresAt: SafePositiveInteger,
  })
  .strict();
export type ControlPairingOpen = z.infer<typeof ControlPairingOpenSchema>;

export const ControlV2DataSchemas = {
  hello: ControlHelloSchema,
  status: ControlStatusSchema,
  "status.config": z.object({ revision: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  devices: ControlDevicesSchema,
  "devices.revoke": ControlRevokeSchema,
  "pairing.open": ControlPairingOpenSchema,
  "pairing.close": EmptyDataSchema,
  "pairing.confirm": EmptyDataSchema,
} as const;

const RequestBase = {
  v: z.literal(2),
  id: SafePositiveInteger,
};
const MutationBase = {
  ...RequestBase,
  expect: ControlRuntimeSchema,
};

export const ControlV2RequestSchema = z.discriminatedUnion("cmd", [
  z.object({ ...RequestBase, cmd: z.literal("hello") }).strict(),
  z.object({ ...RequestBase, cmd: z.literal("status") }).strict(),
  z.object({ ...RequestBase, cmd: z.literal("status.config") }).strict(),
  z.object({ ...RequestBase, cmd: z.literal("devices") }).strict(),
  z
    .object({
      ...MutationBase,
      cmd: z.literal("devices.revoke"),
      args: z.object({ phoneFp: FpSchema }).strict(),
    })
    .strict(),
  z.object({ ...MutationBase, cmd: z.literal("pairing.open") }).strict(),
  z
    .object({
      ...MutationBase,
      cmd: z.literal("pairing.close"),
      args: z.object({ flowId: FlowIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...MutationBase,
      cmd: z.literal("pairing.confirm"),
      args: z
        .object({
          flowId: FlowIdSchema,
          challengeId: FlowIdSchema,
          phoneFp: FpSchema,
          accept: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);
export type ControlV2Request = z.infer<typeof ControlV2RequestSchema>;

export const ControlV2ErrorCodeSchema = z.enum([
  "bad-request",
  "unsupported-version",
  "handshake-required",
  "runtime-mismatch",
  "pairing-busy",
  "stale-flow",
  "stale-challenge",
  "response-too-large",
  "operation-failed",
]);
export type ControlV2ErrorCode = z.infer<typeof ControlV2ErrorCodeSchema>;

const ControlV2SuccessSchema = z
  .object({ v: z.literal(2), id: SafePositiveInteger, ok: z.literal(true), data: z.unknown() })
  .strict()
  .refine((value) => Object.hasOwn(value, "data"));
const ControlV2FailureSchema = z
  .object({
    v: z.literal(2),
    id: SafePositiveInteger,
    ok: z.literal(false),
    error: z.object({ code: ControlV2ErrorCodeSchema }).strict(),
  })
  .strict();
export const ControlV2ResponseSchema = z.union([ControlV2SuccessSchema, ControlV2FailureSchema]);
export type ControlV2Response = z.infer<typeof ControlV2ResponseSchema>;

const PairingRequestEventSchema = z
  .object({
    v: z.literal(2),
    event: z.literal("pairing.request"),
    flowId: FlowIdSchema,
    challengeId: FlowIdSchema,
    phoneFp: FpSchema,
    name: PhoneNameSchema,
  })
  .strict();
const PairingClosedEventSchema = z
  .object({ v: z.literal(2), event: z.literal("pairing.closed"), flowId: FlowIdSchema })
  .strict();
export const ControlV2EventSchema = z.discriminatedUnion("event", [
  PairingRequestEventSchema,
  PairingClosedEventSchema,
]);
export type ControlV2Event = z.infer<typeof ControlV2EventSchema>;
