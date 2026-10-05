import { z } from "zod";
import { decodeBoundedRecord } from "./bounded-cbor.js";
import { encodeCbor, ProtocolError } from "./codec.js";
import { V2GenerationSchema, V2IdSchema } from "./session-v2.js";

const DOMAIN = "shellbell-v2-route-payload";
export const V2_ROUTE_LIMITS = {
  terminalBytes: 59_000,
  signalBytes: 30_000,
  controlBytes: 512,
  payloadBytes: 60_000,
  attemptMs: 15_000,
  directAttempts: 32,
  wireSessions: 128,
} as const;
export const V2RouteReferenceSchema = z
  .object({
    route: z.enum(["relay", "direct"]),
    sessionId: V2IdSchema,
    attemptId: V2IdSchema,
    generation: V2GenerationSchema,
  })
  .strict();
export type V2RouteReference = z.infer<typeof V2RouteReferenceSchema>;
const common = { transitionId: V2IdSchema, target: V2RouteReferenceSchema };
export const V2RouteControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route.prepare"), ...common }).strict(),
  z.object({ type: z.literal("route.prepared"), ...common }).strict(),
  z.object({ type: z.literal("route.commit"), ...common }).strict(),
  z.object({ type: z.literal("route.committed"), ...common }).strict(),
  z
    .object({
      type: z.literal("route.abort"),
      ...common,
      reason: z.enum(["cancelled", "timeout", "not-ready", "candidate-failed"]),
    })
    .strict(),
]);
export type V2RouteControl = z.infer<typeof V2RouteControlSchema>;
export type V2RoutePayload =
  | { kind: "control"; control: V2RouteControl }
  | { kind: "terminal" | "signal"; bytes: Uint8Array };

function boundedBytes(value: unknown, limit: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length > 0 && value.length <= limit;
}

export function encodeV2RoutePayload(payload: V2RoutePayload): Uint8Array {
  let body: unknown;
  if (payload.kind === "control") {
    body = V2RouteControlSchema.parse(payload.control);
    if (encodeCbor(body).length > V2_ROUTE_LIMITS.controlBytes)
      throw new ProtocolError("malformed");
  } else {
    if (
      !boundedBytes(
        payload.bytes,
        payload.kind === "terminal" ? V2_ROUTE_LIMITS.terminalBytes : V2_ROUTE_LIMITS.signalBytes,
      )
    )
      throw new ProtocolError("malformed");
    body = payload.bytes;
  }
  const bytes = encodeCbor([DOMAIN, payload.kind, body]);
  if (bytes.length > V2_ROUTE_LIMITS.payloadBytes) throw new ProtocolError("malformed");
  return bytes;
}

export function decodeV2RoutePayload(bytes: Uint8Array): V2RoutePayload {
  const decoded = decodeBoundedRecord(bytes, V2_ROUTE_LIMITS.payloadBytes, { allowBytes: true });
  if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== DOMAIN)
    throw new ProtocolError("malformed");
  if (decoded[1] === "control") {
    if (encodeCbor(decoded[2]).length > V2_ROUTE_LIMITS.controlBytes)
      throw new ProtocolError("malformed");
    const control = V2RouteControlSchema.parse(decoded[2]);
    return {
      kind: "control",
      control: {
        ...control,
        transitionId: control.transitionId.slice(),
        target: {
          route: control.target.route,
          sessionId: control.target.sessionId.slice(),
          attemptId: control.target.attemptId.slice(),
          generation: control.target.generation.slice(),
        },
      },
    };
  }
  if (
    (decoded[1] !== "terminal" && decoded[1] !== "signal") ||
    !boundedBytes(
      decoded[2],
      decoded[1] === "terminal" ? V2_ROUTE_LIMITS.terminalBytes : V2_ROUTE_LIMITS.signalBytes,
    )
  )
    throw new ProtocolError("malformed");
  return { kind: decoded[1], bytes: decoded[2].slice() };
}
