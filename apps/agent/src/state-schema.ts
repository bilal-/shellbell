import { z } from "zod";

export const AgentConfigSchema = z.object({
  v: z.literal(1),
  relayUrl: z.string().url(),
  computerName: z.string().min(1).max(64),
  accent: z.string().min(1).max(32),
  notifyMinCommandMs: z.number().int().nonnegative().default(10_000),
  idleQuietMs: z.number().int().positive().default(4_000),
  idleMinActiveMs: z.number().int().nonnegative().default(1_500),
  /** Trusted, locally installed ESM adapters. Never populated by a paired device. */
  terminalPlugins: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (path) =>
            path.startsWith("/") &&
            path.endsWith(".mjs") &&
            [...path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
        ),
    )
    .max(29)
    .optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export const PairingSchema = z.object({
  phoneFp: z.string().regex(/^[a-z2-7]{26}$/),
  name: z.string().min(1).max(64),
  platform: z.enum(["ios", "android"]),
  ed25519Pub: z.string(),
  x25519Pub: z.string(),
  kPair: z.string(),
  // Absence means the original relay-only protocol. A confirmed v2 session
  // permanently raises this floor for this exact pairing.
  minProtocolVersion: z.literal(2).optional(),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type Pairing = z.infer<typeof PairingSchema>;
export const PairingsFile = z.object({ v: z.literal(1), phones: z.array(PairingSchema) });

/** Preserve an established floor unless a fresh QR produces a different K_pair. */
export function preservePairProtocolFloor(previous: Pairing | undefined, next: Pairing): Pairing {
  if (!previous || previous.phoneFp !== next.phoneFp || previous.kPair !== next.kPair) {
    return next;
  }
  if (previous.ed25519Pub !== next.ed25519Pub || previous.x25519Pub !== next.x25519Pub) {
    throw new Error("shellbell: pairing identity changed without a new pairing key");
  }
  return previous.minProtocolVersion === 2 ? { ...next, minProtocolVersion: 2 } : next;
}
