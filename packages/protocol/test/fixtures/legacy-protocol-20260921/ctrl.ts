import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { Bytes, E2EBodySchema, FpSchema } from "./envelope.js";

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
const PairedPhone = z.object({ phoneFp: FpSchema, ed25519Pub: Bytes(32), name });

export const CtrlMessageSchema = z.discriminatedUnion("type", [
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
  }),
  z.object({ type: z.literal("auth-fail"), reason: AuthFailReasonSchema }),
  z.object({
    type: z.literal("presence"),
    agentOnline: z.boolean(),
    computerName: z.string().max(64).nullable(),
  }),
  z.object({ type: z.literal("unpaired"), phoneFps: z.array(FpSchema).max(MAX_PAIRINGS) }),
  z.object({
    type: z.literal("phones"),
    connected: z.array(z.object({ phoneFp: FpSchema, connId, name })).max(MAX_PAIRINGS),
  }),
  z.object({ type: z.literal("pairings-sync"), phones: z.array(PairedPhone).max(MAX_PAIRINGS) }),
  z.object({ type: z.literal("pairing-open"), gateHash: Bytes(32), expiresAt: z.number() }),
  z.object({ type: z.literal("pairing-close") }),
  z.object({ type: z.literal("pairing-request"), phoneFp: FpSchema, box: PairingBox }),
  z.object({ type: z.literal("pairing-response"), phoneFp: FpSchema, box: PairingBox }),
  z.object({
    type: z.literal("pairing-reject"),
    phoneFp: FpSchema,
    reason: PairingRejectReasonSchema,
  }),
  z.object({ type: z.literal("pairing-add"), phoneFp: FpSchema, ed25519Pub: Bytes(32), name }),
  z.object({ type: z.literal("unpair"), phoneFp: FpSchema }),
  z.object({
    type: z.literal("push-token"),
    token: z.string().min(1).max(256),
    platform: z.enum(["ios", "android"]),
    enabled: z.boolean(),
  }),
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
export type CtrlMessageOf<T extends CtrlMessage["type"]> = Extract<CtrlMessage, { type: T }>;
export type Role = z.infer<typeof RoleSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;

export function parseCtrl(u: unknown): CtrlMessage {
  const r = CtrlMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `ctrl: ${z.prettifyError(r.error)}`);
  return r.data;
}
