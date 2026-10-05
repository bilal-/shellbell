/**
 * Bounded, end-to-end-only v2 negotiation messages. The relays must never parse SDP/ICE.
 * No production endpoint imports this module until the v2 coordinator is implemented.
 */
import { z } from "zod";
import { bytesEqual, hexToBytes } from "./bytes.js";
import { decodeCbor, encodeCbor, ProtocolError } from "./codec.js";
import { Bytes } from "./envelope.js";
import { decodeNoiseSequence } from "./noise-kkpsk2.js";
import { V2GenerationSchema, V2IdSchema, type V2Role } from "./session-v2.js";

export const V2_FEATURE = "session-v2";
export const V2_SIGNAL_LIMITS = {
  sdpChars: 24_000,
  candidateChars: 1_024,
  candidatesPerSide: 32,
  encodedBytes: 30_000,
  bootstrapConfirmBytes: 512,
} as const;

const bootstrapGeneration = V2GenerationSchema.refine(
  (value) => value[0] === 1 && value.subarray(1).every((byte) => byte === 0),
  { message: "initial relay generation must be one" },
);
const directGeneration = V2GenerationSchema.refine(
  (value) => value[0] !== 1 || value.subarray(1).some((byte) => byte !== 0),
  { message: "direct generation must exceed one" },
);
const sdp = z
  .string()
  .min(1)
  .max(V2_SIGNAL_LIMITS.sdpChars)
  .regex(/^[\x20-\x7e\r\n]+$/, "SDP must contain printable ASCII and line endings only");
const candidate = z
  .string()
  .min(1)
  .max(V2_SIGNAL_LIMITS.candidateChars)
  .startsWith("candidate:")
  .regex(/^[\x20-\x7e]+$/, "ICE candidate must contain printable ASCII only");
const commonDirect = {
  sessionId: V2IdSchema,
  offerId: V2IdSchema,
  generation: directGeneration,
};

/**
 * Admit a data-channel-only, trickle-ICE description. Native setRemoteDescription still does
 * full SDP parsing; this preflight prevents candidates hidden in SDP from bypassing the cap.
 */
function validDataChannelSdp(value: string, expectedFingerprint: Uint8Array): boolean {
  if (/\r(?!\n)/.test(value)) return false;
  const lines = value.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.some((line) => !/^[a-z]=/.test(line))) return false;
  const media = lines.filter((line) => line.startsWith("m="));
  if (
    media.length !== 1 ||
    !/^m=application [0-9]+ (?:UDP|TCP)\/DTLS\/SCTP webrtc-datachannel$/i.test(media[0] ?? "")
  ) {
    return false;
  }
  if (
    lines.some((line) =>
      /^a=(?:candidate|remote-candidates|end-of-candidates)(?::|$)/i.test(line),
    ) ||
    !lines.some((line) => /^a=ice-ufrag:/i.test(line)) ||
    !lines.some((line) => /^a=ice-pwd:/i.test(line))
  ) {
    return false;
  }
  const fingerprints = lines.filter((line) => /^a=fingerprint:/i.test(line));
  if (fingerprints.length === 0) return false;
  for (const line of fingerprints) {
    const match = /^a=fingerprint:sha-256 ((?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i.exec(line);
    if (!match?.[1] || !bytesEqual(hexToBytes(match[1].replaceAll(":", "")), expectedFingerprint)) {
      return false;
    }
  }
  return true;
}

/** First relay route is bootstrapped inside a *paired* v1 encrypted connection. */
export const V2BootstrapSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session.v2.begin"),
      sessionId: V2IdSchema,
      generation: bootstrapGeneration,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.v2.accept"),
      sessionId: V2IdSchema,
      attemptId: V2IdSchema,
      generation: bootstrapGeneration,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.v2.noise1"),
      sessionId: V2IdSchema,
      attemptId: V2IdSchema,
      message: Bytes(48),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.v2.noise2"),
      sessionId: V2IdSchema,
      attemptId: V2IdSchema,
      message: Bytes(48),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.v2.confirm"),
      sessionId: V2IdSchema,
      attemptId: V2IdSchema,
      frame: z.custom<Uint8Array>(
        (value) =>
          value instanceof Uint8Array &&
          value.length > 0 &&
          value.length <= V2_SIGNAL_LIMITS.bootstrapConfirmBytes,
        { message: "invalid v2 confirmation frame length" },
      ),
    })
    .strict(),
]);
export type V2Bootstrap = z.infer<typeof V2BootstrapSchema>;

/** State supplied by the paired v1 handshake dispatcher, never by a relay frame. */
export interface V2BootstrapAdmission {
  sender: V2Role;
  expectedType: V2Bootstrap["type"];
  sessionId?: Uint8Array;
  attemptId?: Uint8Array;
}

function trustedIdMatches(actual: Uint8Array, expected: Uint8Array | undefined): boolean {
  return (
    expected !== undefined && V2IdSchema.safeParse(expected).success && bytesEqual(actual, expected)
  );
}

function admittedBootstrap(message: V2Bootstrap, expected: V2BootstrapAdmission): boolean {
  if (!expected || message.type !== expected.expectedType) return false;
  if (message.type === "session.v2.begin") {
    return (
      expected.sender === "phone" &&
      expected.sessionId === undefined &&
      expected.attemptId === undefined
    );
  }
  if (!trustedIdMatches(message.sessionId, expected.sessionId)) return false;
  if (message.type === "session.v2.accept") {
    return expected.sender === "computer" && expected.attemptId === undefined;
  }
  if (!trustedIdMatches(message.attemptId, expected.attemptId)) return false;
  if (message.type === "session.v2.noise1") return expected.sender === "phone";
  if (message.type === "session.v2.noise2") return expected.sender === "computer";
  return expected.sender === "phone" || expected.sender === "computer";
}

const BOOTSTRAP_BYTES = 1_024;

export function encodeV2Bootstrap(input: V2Bootstrap): Uint8Array {
  const parsed = V2BootstrapSchema.safeParse(input);
  if (!parsed.success) throw new ProtocolError("malformed", "invalid v2 bootstrap");
  const bytes = encodeCbor(parsed.data);
  if (bytes.length > BOOTSTRAP_BYTES) {
    throw new ProtocolError("malformed", "v2 bootstrap too large");
  }
  return bytes;
}

export function decodeV2Bootstrap(bytes: Uint8Array, expected: V2BootstrapAdmission): V2Bootstrap {
  if (bytes.length > BOOTSTRAP_BYTES) {
    throw new ProtocolError("malformed", "v2 bootstrap too large");
  }
  const parsed = V2BootstrapSchema.safeParse(decodeCbor(bytes));
  if (!parsed.success || !admittedBootstrap(parsed.data, expected)) {
    throw new ProtocolError("malformed", "invalid or stale v2 bootstrap");
  }
  return parsed.data;
}

/** Offer/answer/candidates are application plaintext only *inside* an active encrypted v2 frame. */
export const DirectSignalSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("direct.offer"),
        ...commonDirect,
        sdp,
        phoneDtls: Bytes(32),
      })
      .strict(),
    z
      .object({
        type: z.literal("direct.answer"),
        ...commonDirect,
        attemptId: V2IdSchema,
        sdp,
        computerDtls: Bytes(32),
      })
      .strict(),
    z
      .object({
        type: z.literal("direct.candidate"),
        ...commonDirect,
        index: z
          .number()
          .int()
          .min(0)
          .max(V2_SIGNAL_LIMITS.candidatesPerSide - 1),
        candidate,
        mid: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[\x21-\x7e]+$/)
          .nullable(),
        mlineIndex: z.number().int().min(0).max(0).nullable(),
      })
      .strict(),
    z
      .object({
        type: z.literal("direct.end"),
        ...commonDirect,
        count: z.number().int().min(0).max(V2_SIGNAL_LIMITS.candidatesPerSide),
      })
      .strict(),
    z
      .object({
        type: z.literal("direct.abort"),
        ...commonDirect,
        reason: z.enum(["timeout", "ice-failed", "dtls-failed", "resource-limit", "cancelled"]),
      })
      .strict(),
  ])
  .superRefine((signal, context) => {
    if (signal.type === "direct.candidate" && signal.mid === null && signal.mlineIndex === null) {
      context.addIssue({ code: "custom", message: "candidate needs a media section" });
    }
    if (signal.type === "direct.offer" && !validDataChannelSdp(signal.sdp, signal.phoneDtls)) {
      context.addIssue({ code: "custom", message: "invalid data-channel offer SDP" });
    }
    if (signal.type === "direct.answer" && !validDataChannelSdp(signal.sdp, signal.computerDtls)) {
      context.addIssue({ code: "custom", message: "invalid data-channel answer SDP" });
    }
  });
export type DirectSignal = z.infer<typeof DirectSignalSchema>;

/** Trusted session/attempt context supplied by the v2 receive coordinator, not the relay. */
export interface DirectSignalAdmission {
  sender: V2Role;
  sessionId: Uint8Array;
  committedGeneration: Uint8Array;
  pending?: { offerId: Uint8Array; generation: Uint8Array };
}

function admitted(signal: DirectSignal, expected: DirectSignalAdmission): boolean {
  if (
    !expected ||
    (expected.sender !== "phone" && expected.sender !== "computer") ||
    !V2IdSchema.safeParse(expected.sessionId).success ||
    !V2GenerationSchema.safeParse(expected.committedGeneration).success ||
    !bytesEqual(signal.sessionId, expected.sessionId)
  ) {
    return false;
  }
  if (signal.type === "direct.offer") {
    return (
      expected.sender === "phone" &&
      expected.pending === undefined &&
      decodeNoiseSequence(signal.generation) > decodeNoiseSequence(expected.committedGeneration)
    );
  }
  const pending = expected.pending;
  return (
    pending !== undefined &&
    V2IdSchema.safeParse(pending.offerId).success &&
    V2GenerationSchema.safeParse(pending.generation).success &&
    decodeNoiseSequence(pending.generation) > decodeNoiseSequence(expected.committedGeneration) &&
    bytesEqual(signal.offerId, pending.offerId) &&
    bytesEqual(signal.generation, pending.generation) &&
    (signal.type !== "direct.answer" || expected.sender === "computer")
  );
}

export function encodeDirectSignal(input: DirectSignal): Uint8Array {
  const parsed = DirectSignalSchema.safeParse(input);
  if (!parsed.success) throw new ProtocolError("malformed", "invalid direct signal");
  const bytes = encodeCbor(parsed.data);
  if (bytes.length > V2_SIGNAL_LIMITS.encodedBytes) {
    throw new ProtocolError("malformed", "direct signal too large");
  }
  return bytes;
}

export function decodeDirectSignal(
  bytes: Uint8Array,
  expected: DirectSignalAdmission,
): DirectSignal {
  if (bytes.length > V2_SIGNAL_LIMITS.encodedBytes) {
    throw new ProtocolError("malformed", "direct signal too large");
  }
  const parsed = DirectSignalSchema.safeParse(decodeCbor(bytes));
  if (!parsed.success || !admitted(parsed.data, expected)) {
    throw new ProtocolError("malformed", "invalid or stale direct signal");
  }
  return parsed.data;
}
