import { z } from "zod";
import { decodeCbor, encodeCbor, ProtocolError } from "./codec.js";

export const FRAME_LIMITS = {
  unauth: 4096,
  ctrl: 16384,
  e2eFromPhone: 65536,
  e2eFromAgent: 1048576,
} as const;

export const Bytes = (n?: number) =>
  z.custom<Uint8Array>((v) => v instanceof Uint8Array && (n === undefined || v.length === n), {
    message: n === undefined ? "expected bytes" : `expected ${n} bytes`,
  });

export const FpSchema = z.string().regex(/^[a-z2-7]{26}$/, "fingerprint");

export const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    t: z.enum(["ctrl", "e2e"]),
    from: z.union([FpSchema, z.literal("relay")]),
    to: FpSchema.optional(),
    seq: z.number().int().nonnegative(),
    body: z.unknown(),
  })
  .refine((e) => e.t !== "e2e" || e.to !== undefined, { message: "e2e envelope needs to" });
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const E2EBodySchema = z.object({ n: Bytes(24), c: Bytes() });
export type E2EBody = z.infer<typeof E2EBodySchema>;

export function encodeEnvelope(e: Envelope): Uint8Array {
  return encodeCbor(e);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const raw = decodeCbor(bytes);
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError("malformed", z.prettifyError(parsed.error));
  return parsed.data;
}
