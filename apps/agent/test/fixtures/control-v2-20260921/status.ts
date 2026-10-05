// Frozen strict control-v2 status/hello parser from d96b143. See README.md.
import { isAbsolute } from "node:path";
import { z } from "zod";

const FpSchema = z.string().regex(/^[a-z2-7]{26}$/);
const SafePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PhoneNameSchema = z.string().min(1).max(64);
const RuntimeSchema = z
  .object({
    pid: SafePositiveInteger,
    agentVersion: z.string().min(1),
    computerFp: FpSchema,
    stateDir: z.string().min(1).refine(isAbsolute, "state directory must be absolute"),
    serviceInstance: z.uuid().nullable(),
  })
  .strict();
const BackendSchema = z
  .object({ name: z.enum(["iterm2", "tmux", "herdr"]), connected: z.boolean() })
  .strict();
const PhoneSchema = z
  .object({ phoneFp: FpSchema, name: PhoneNameSchema, lastSeenAt: z.string().nullable() })
  .strict();
const ConnectedSchema = z
  .object({ phoneFp: FpSchema, name: PhoneNameSchema, viewed: z.string().nullable() })
  .strict();
export const FrozenStatusSchema = z
  .object({
    controlVersion: z.literal(1),
    process: RuntimeSchema,
    backends: z.array(BackendSchema),
    terminalReady: z.boolean(),
    relayOnline: z.boolean(),
    sessions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    phones: z.array(PhoneSchema).max(10),
    connected: z.array(ConnectedSchema).max(10),
  })
  .strict()
  .superRefine((status, ctx) => {
    const order = ["iterm2", "tmux", "herdr"];
    if (
      status.backends.length !== order.length ||
      status.backends.some((backend, i) => backend.name !== order[i]) ||
      status.terminalReady !== status.backends.some((backend) => backend.connected)
    )
      ctx.addIssue({ code: "custom", message: "status must satisfy LocalStatus semantics" });
  });
export const FrozenHelloSchema = z
  .object({
    version: z.literal(2),
    runtime: RuntimeSchema,
    capabilities: z.tuple([
      z.literal("status"),
      z.literal("devices"),
      z.literal("pairing"),
      z.literal("revoke"),
    ]),
  })
  .strict();
