import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { Bytes, E2EBodySchema, FpSchema } from "./envelope.js";
import {
  NotificationBoxSchema,
  NotificationFeaturesSchema,
  NotificationHeaderSchema,
} from "./notification.js";
import { PairRevocationV2Schema } from "./pair-revocation-v2.js";

export const MAX_PAIRINGS = 10;

export const RoleSchema = z.enum(["agent", "phone", "pairing"]);
export const EventKindSchema = z.enum(["prompt", "idle", "exit", "blocked"]);
export const AuthFailReasonSchema = z.enum([
  "bad-sig",
  "not-paired",
  "fp-mismatch",
  "no-agent",
  "no-window",
  "timeout",
]);
export const PairingRejectReasonSchema = z.enum([
  "bad-code",
  "declined",
  "window-closed",
  "no-agent",
  "too-many",
]);

const name = z.string().min(1).max(64);
const connId = z.string().min(1).max(64);
const PairingBox = E2EBodySchema;
const PushTokenSchema = z
  .strictObject({
    type: z.literal("push-token"),
    token: z.string().min(1).max(4096),
    platform: z.enum(["ios", "android"]),
    provider: z.enum(["fcm", "apns"]).optional(),
    environment: z.enum(["development", "production"]).optional(),
    enabled: z.boolean(),
    features: NotificationFeaturesSchema.optional(),
  })
  .superRefine((message, context) => {
    if (message.provider === undefined) {
      if (message.token.length > 256) {
        context.addIssue({
          code: "custom",
          path: ["token"],
          message: "legacy token exceeds 256 characters",
        });
      }
      if (message.environment !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["environment"],
          message: "environment requires APNs",
        });
      }
      return;
    }

    if ([...message.token].some((character) => character.charCodeAt(0) > 0x7f)) {
      context.addIssue({ code: "custom", path: ["token"], message: "native token must be ASCII" });
    }
    if (message.provider === "fcm") {
      if (message.platform !== "android") {
        context.addIssue({ code: "custom", path: ["platform"], message: "FCM requires Android" });
      }
      if (message.environment !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["environment"],
          message: "FCM has no environment",
        });
      }
    } else {
      if (message.platform !== "ios") {
        context.addIssue({ code: "custom", path: ["platform"], message: "APNs requires iOS" });
      }
      if (message.environment === undefined) {
        context.addIssue({
          code: "custom",
          path: ["environment"],
          message: "APNs requires an environment",
        });
      }
    }
  })
  .refine(
    (message): message is PushTokenMessage => {
      if (message.provider === undefined) {
        return message.token.length <= 256 && message.environment === undefined;
      }
      if ([...message.token].some((character) => character.charCodeAt(0) > 0x7f)) {
        return false;
      }
      return message.provider === "fcm"
        ? message.platform === "android" && message.environment === undefined
        : message.platform === "ios" && message.environment !== undefined;
    },
    { message: "invalid push-token provider, platform, environment, or token" },
  );
const PairedPhone = z.object({
  phoneFp: FpSchema,
  ed25519Pub: Bytes(32),
  name,
  /** Optional only for legacy agents; mandatory before v2 revocation-only submission. */
  pairId: Bytes(32).optional(),
});

export const CtrlMessageSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("notify-context"),
      sessionId: NotificationHeaderSchema.shape.sessionId,
      eventId: NotificationHeaderSchema.shape.eventId,
      kind: z.enum(["prompt", "idle", "blocked"]),
      exitCode: z.number().int().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      boxes: z.array(NotificationBoxSchema).max(MAX_PAIRINGS),
    })
    .refine(
      (m) =>
        new Set(m.boxes.map((b) => b.phoneFp)).size === m.boxes.length &&
        m.boxes.every(
          (b) =>
            b.sessionId === m.sessionId &&
            b.eventId === m.eventId &&
            b.computerFp === m.boxes[0]?.computerFp,
        ),
      "inconsistent notification recipients",
    ),
  z.object({ type: z.literal("challenge"), nonce: Bytes(32), connId }),
  z.object({
    type: z.literal("auth"),
    role: RoleSchema,
    fp: FpSchema,
    ed25519Pub: Bytes(32),
    sig: Bytes(64),
    name,
    appVersion: z.string().max(32),
    gate: Bytes(16).optional(),
  }),
  z.object({
    type: z.literal("auth-ok"),
    role: RoleSchema,
    agentOnline: z.boolean(),
    computerName: z.string().max(64).nullable(),
    serverTime: z.number(),
    minFrameMs: z.number().int().min(50).max(2000),
    features: NotificationFeaturesSchema.optional(),
  }),
  z.object({ type: z.literal("auth-fail"), reason: AuthFailReasonSchema }),
  z.object({
    type: z.literal("presence"),
    agentOnline: z.boolean(),
    computerName: z.string().max(64).nullable(),
  }),
  z.object({
    type: z.literal("unpaired"),
    phoneFps: z.array(FpSchema).max(MAX_PAIRINGS),
    proofs: z.array(PairRevocationV2Schema).max(MAX_PAIRINGS).optional(),
  }),
  z.object({
    type: z.literal("phones"),
    connected: z.array(z.object({ phoneFp: FpSchema, connId, name })).max(MAX_PAIRINGS),
  }),
  z.object({ type: z.literal("pairings-sync"), phones: z.array(PairedPhone).max(MAX_PAIRINGS) }),
  z.object({ type: z.literal("revocation-ack"), phoneFp: FpSchema, pairId: Bytes(32) }),
  z.object({ type: z.literal("pairing-open"), gateHash: Bytes(32), expiresAt: z.number() }),
  z.object({ type: z.literal("pairing-close") }),
  z.object({ type: z.literal("pairing-request"), phoneFp: FpSchema, box: PairingBox }),
  z.object({ type: z.literal("pairing-response"), phoneFp: FpSchema, box: PairingBox }),
  z.object({
    type: z.literal("pairing-reject"),
    phoneFp: FpSchema,
    reason: PairingRejectReasonSchema,
  }),
  z.object({
    type: z.literal("pairing-add"),
    phoneFp: FpSchema,
    ed25519Pub: Bytes(32),
    name,
    pairId: Bytes(32).optional(),
  }),
  z.object({
    type: z.literal("unpair"),
    phoneFp: FpSchema,
    proof: PairRevocationV2Schema.optional(),
  }),
  z.object({
    type: z.literal("revocation-submit"),
    phoneEd25519Pub: Bytes(32),
    proof: PairRevocationV2Schema,
  }),
  z.object({
    type: z.literal("revocation-receipt"),
    phoneFp: FpSchema,
    pairId: Bytes(32),
    status: z.enum(["stored", "absent", "stale", "unavailable"]),
  }),
  PushTokenSchema,
  z.object({ type: z.literal("lease"), ttlMs: z.number().int().min(0).max(120000) }),
  z.object({
    type: z.literal("notify"),
    sessionId: z.string().min(1).max(128),
    kind: z.enum(["prompt", "idle", "blocked"]),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("phone-connected"), phoneFp: FpSchema, connId, name }),
  z.object({ type: z.literal("phone-disconnected"), phoneFp: FpSchema, connId }),
  z.object({ type: z.literal("error"), code: z.string().max(64), message: z.string().max(512) }),
]);
export type CtrlMessage = z.infer<typeof CtrlMessageSchema>;
export type PushTokenMessage =
  | {
      type: "push-token";
      token: string;
      platform: "ios" | "android";
      provider?: never;
      environment?: never;
      enabled: boolean;
      features?: z.infer<typeof NotificationFeaturesSchema>;
    }
  | {
      type: "push-token";
      token: string;
      platform: "android";
      provider: "fcm";
      environment?: never;
      enabled: boolean;
      features?: z.infer<typeof NotificationFeaturesSchema>;
    }
  | {
      type: "push-token";
      token: string;
      platform: "ios";
      provider: "apns";
      environment: "development" | "production";
      enabled: boolean;
      features?: z.infer<typeof NotificationFeaturesSchema>;
    };
export type CtrlMessageOf<T extends CtrlMessage["type"]> = T extends "push-token"
  ? PushTokenMessage
  : Extract<CtrlMessage, { type: T }>;
export type Role = z.infer<typeof RoleSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;

export function parseCtrl(u: unknown): CtrlMessage {
  const r = CtrlMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `ctrl: ${z.prettifyError(r.error)}`);
  return r.data;
}
