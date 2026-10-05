import { z } from "zod";
import { fromBase64Url, toBase64Url, utf8 } from "./bytes.js";
import { FpSchema } from "./envelope.js";

export const NOTIFICATION_FEATURE = "notify-context-v1";
export const NOTIFICATION_DOMAIN = "shellbell-notification-v1";
export const NOTIFICATION_LIMITS = {
  plaintextBytes: 1536,
  ciphertextBytes: 1552,
  providerBytes: 3500,
  freshnessMs: 120_000,
  clockSkewMs: 60_000,
  previousGenerationMs: 300_000,
  sessions: 500,
  encryptions: 2 ** 20,
} as const;

/** Bound before decoding; reject padding and nonzero unused trailing bits. */
function encodedBytes(min: number, max = min) {
  return z
    .string()
    .min(Math.ceil((min * 4) / 3))
    .max(Math.ceil((max * 4) / 3))
    .refine((value) => {
      try {
        const bytes = fromBase64Url(value);
        return bytes.length >= min && bytes.length <= max && toBase64Url(bytes) === value;
      } catch {
        return false;
      }
    }, "invalid canonical base64url");
}
export const NotificationGenerationSchema = encodedBytes(16);
export const NotificationFeaturesSchema = z.array(z.string().min(1).max(32)).max(8);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequence = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine(
    (value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n,
    "sequence overflow",
  );
// Explicitly reject terminal controls rather than rendering them in notification labels.
const unsafeLabel = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
function label(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine(
      (s) => s.trim().length > 0 && !unsafeLabel.test(s) && utf8(s).length <= maxBytes,
      "invalid notification label",
    );
}
export const NotificationContextSchema = z.strictObject({
  computerName: label(128),
  sessionLabel: label(128),
  observedAt: timestamp,
  customName: label(256).optional(),
  repository: label(256).optional(),
  branch: label(256).optional(),
  title: label(256).optional(),
  shell: label(64).optional(),
  agentName: label(64).optional(),
});
export type NotificationContext = z.infer<typeof NotificationContextSchema>;
export const NotificationHeaderSchema = z.strictObject({
  computerFp: FpSchema,
  phoneFp: FpSchema,
  generation: NotificationGenerationSchema,
  sessionId: z.string().min(1).max(128),
  eventId: encodedBytes(16),
});
export type NotificationHeader = z.infer<typeof NotificationHeaderSchema>;
export const NotificationReasonSchema = z.enum([
  "command-finished",
  "prompt-returned",
  "agent-finished",
  "agent-blocked",
  "quiet",
]);
export type NotificationReason = z.infer<typeof NotificationReasonSchema>;
export const NotificationPayloadSchema = NotificationHeaderSchema.extend({
  context: NotificationContextSchema,
  reason: NotificationReasonSchema,
  exitCode: z.number().int().optional(),
  durationMs: timestamp.optional(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  sequence,
})
  .refine(
    (p) =>
      p.expiresAt > p.issuedAt &&
      p.expiresAt - p.issuedAt <= NOTIFICATION_LIMITS.freshnessMs &&
      p.context.observedAt <= p.issuedAt,
    "invalid notification times",
  )
  .refine(
    (p) => utf8(JSON.stringify(p)).length <= NOTIFICATION_LIMITS.plaintextBytes,
    "notification plaintext exceeds byte limit",
  );
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;
export const NotificationBoxSchema = NotificationHeaderSchema.extend({
  nonce: encodedBytes(12),
  ciphertext: encodedBytes(17, NOTIFICATION_LIMITS.ciphertextBytes),
});
export type NotificationBox = z.infer<typeof NotificationBoxSchema>;

/** Select only public routing fields; never copy plaintext into a box. */
export function notificationHeader(p: NotificationHeader): NotificationHeader {
  return NotificationHeaderSchema.parse({
    computerFp: p.computerFp,
    phoneFp: p.phoneFp,
    generation: p.generation,
    sessionId: p.sessionId,
    eventId: p.eventId,
  });
}
