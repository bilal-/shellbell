/**
 * Experimental v2 endpoint session framing. Not exported from the package root or used by
 * production connections until persistence, relay forwarding, cross-runtime and review gates pass.
 * CBOR arrays below are intentionally positional, so object insertion order cannot change the
 * Noise prologue or frame associated data across JavaScript runtimes.
 */
import { z } from "zod";
import { bytesEqual } from "./bytes.js";
import { decodeCbor, encodeCbor, ProtocolError } from "./codec.js";
import { deriveNoisePsk } from "./crypto.js";
import { Bytes, FpSchema } from "./envelope.js";
import {
  decodeNoiseSequence,
  encodeNoiseSequence,
  NoiseKKpsk2Handshake,
  type NoiseKKpsk2Options,
  type NoiseTransport,
} from "./noise-kkpsk2.js";

const ID_BYTES = 16;
const FINGERPRINT_BYTES = 32;
const DATA_BYTES = 60_000;
const FRAME_BYTES = 61_000;
const CONFIRM_DOMAIN = "shellbell-v2-key-confirm";
const HANDSHAKE_FACTORY = Symbol("v2 handshake factory");
const SESSION_FACTORY = Symbol("v2 session factory");
export const V2IdSchema = Bytes(ID_BYTES).refine((value) => value.some((byte) => byte !== 0), {
  message: "v2 ID must not be zero",
});
export const V2GenerationSchema = Bytes(8).refine(
  (value) => {
    try {
      return decodeNoiseSequence(value) > 0n;
    } catch {
      return false;
    }
  },
  { message: "invalid v2 route generation" },
);
const common = {
  computerFp: FpSchema,
  phoneFp: FpSchema,
  sessionId: V2IdSchema,
  attemptId: V2IdSchema,
  generation: V2GenerationSchema,
};

export const V2SessionContextSchema = z.discriminatedUnion("route", [
  z.object({ ...common, route: z.literal("relay") }).strict(),
  z
    .object({
      ...common,
      route: z.literal("direct"),
      phoneDtls: Bytes(FINGERPRINT_BYTES),
      computerDtls: Bytes(FINGERPRINT_BYTES),
    })
    .strict(),
]);
export type V2SessionContext = z.infer<typeof V2SessionContextSchema>;
export type V2Role = "phone" | "computer";

const ciphertextSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.length >= 16 && value.length <= DATA_BYTES + 16,
  { message: "invalid v2 ciphertext length" },
);
export const V2FrameSchema = z
  .object({
    v: z.literal(2),
    type: z.enum(["confirm", "data"]),
    sessionId: V2IdSchema,
    generation: V2GenerationSchema,
    seq: Bytes(8),
    ciphertext: ciphertextSchema,
  })
  .strict();
export type V2Frame = z.infer<typeof V2FrameSchema>;

function contextCopy(input: V2SessionContext): V2SessionContext {
  const context = V2SessionContextSchema.parse(input);
  const copied = {
    ...context,
    sessionId: new Uint8Array(context.sessionId),
    attemptId: new Uint8Array(context.attemptId),
    generation: new Uint8Array(context.generation),
    ...(context.route === "direct" && {
      phoneDtls: new Uint8Array(context.phoneDtls),
      computerDtls: new Uint8Array(context.computerDtls),
    }),
  };
  return V2SessionContextSchema.parse(copied);
}

/** The initiator is always the phone; the responder is always the computer service. */
export function encodeV2Prologue(input: V2SessionContext): Uint8Array {
  const context = V2SessionContextSchema.parse(input);
  return encodeCbor([
    "shellbell-session-v2",
    2,
    "phone",
    "computer",
    context.computerFp,
    context.phoneFp,
    context.sessionId,
    context.attemptId,
    context.generation,
    context.route,
    context.route === "direct" ? context.phoneDtls : null,
    context.route === "direct" ? context.computerDtls : null,
  ]);
}

function frameAd(context: V2SessionContext, sender: V2Role, frame: V2Frame): Uint8Array {
  return encodeCbor([
    "shellbell-v2-frame",
    context.sessionId,
    context.attemptId,
    context.generation,
    context.route,
    sender,
    frame.type,
    frame.seq,
  ]);
}

function opposite(role: V2Role): V2Role {
  return role === "phone" ? "computer" : "phone";
}

export function encodeV2Frame(input: V2Frame): Uint8Array {
  const encoded = encodeCbor(V2FrameSchema.parse(input));
  if (encoded.length > FRAME_BYTES) throw new ProtocolError("malformed", "v2 frame too large");
  return encoded;
}

export function decodeV2Frame(bytes: Uint8Array): V2Frame {
  if (bytes.length > FRAME_BYTES) throw new ProtocolError("malformed", "v2 frame too large");
  return V2FrameSchema.parse(decodeCbor(bytes));
}

export interface V2PairKeys {
  staticPrivate: Uint8Array;
  remoteStatic: Uint8Array;
  pairKey: Uint8Array;
}

export class V2Handshake {
  private finished = false;

  constructor(
    private readonly context: V2SessionContext,
    private readonly role: V2Role,
    private readonly noise: NoiseKKpsk2Handshake,
    factory: typeof HANDSHAKE_FACTORY,
  ) {
    if (factory !== HANDSHAKE_FACTORY) throw new Error("v2 handshake factory required");
  }

  write(): Uint8Array {
    if (this.finished) throw new Error("v2 handshake finished");
    return this.noise.write();
  }

  read(message: Uint8Array): void {
    if (this.finished) throw new Error("v2 handshake finished");
    if (message.length !== 48) throw new Error("v2 empty-payload handshake must be 48 bytes");
    const payload = this.noise.read(message);
    if (payload.length !== 0) throw new Error("v2 handshake payload forbidden");
  }

  finish(): V2SecureSession {
    if (this.finished) throw new Error("v2 handshake already finished");
    const hash = this.noise.handshakeHash;
    const transport = this.noise.split();
    this.finished = true;
    return new V2SecureSession(this.context, this.role, transport, hash, SESSION_FACTORY);
  }

  close(): void {
    this.finished = true;
    this.noise.close();
  }
}

export function createV2Handshake(
  input: V2SessionContext,
  role: V2Role,
  keys: V2PairKeys,
): V2Handshake {
  if (role !== "phone" && role !== "computer") throw new Error("invalid v2 role");
  const context = contextCopy(input);
  const psk = deriveNoisePsk(keys.pairKey, context.computerFp, context.phoneFp);
  try {
    const options: NoiseKKpsk2Options = {
      role: role === "phone" ? "initiator" : "responder",
      staticPrivate: keys.staticPrivate,
      remoteStatic: keys.remoteStatic,
      psk,
      prologue: encodeV2Prologue(context),
    };
    return new V2Handshake(context, role, new NoiseKKpsk2Handshake(options), HANDSHAKE_FACTORY);
  } finally {
    psk.fill(0);
  }
}

export class V2SecureSession {
  private sentConfirmation = false;
  private receivedConfirmation = false;
  private dtlsVerified = false;
  private nextSequence = 0n;
  private lastReceived = -1n;
  private closed = false;

  constructor(
    private readonly context: V2SessionContext,
    private readonly role: V2Role,
    private readonly transport: NoiseTransport,
    private readonly handshakeHash: Uint8Array,
    factory: typeof SESSION_FACTORY,
  ) {
    if (factory !== SESSION_FACTORY) throw new Error("v2 session factory required");
  }

  get ready(): boolean {
    return (
      !this.closed &&
      this.sentConfirmation &&
      this.receivedConfirmation &&
      (this.context.route === "relay" || this.dtlsVerified)
    );
  }

  /** A copy of the authenticated binding, never keys or mutable session state. */
  get description(): V2SessionContext {
    return contextCopy(this.context);
  }

  get senderRole(): V2Role {
    return this.role;
  }

  /** Compare the native DTLS transport's actual remote certificate, never just SDP text. */
  verifyRemoteDtls(actualSha256: Uint8Array): void {
    if (this.closed) throw new Error("v2 session closed");
    if (this.context.route !== "direct") throw new Error("relay route has no DTLS certificate");
    const expected = this.role === "phone" ? this.context.computerDtls : this.context.phoneDtls;
    if (actualSha256.length !== FINGERPRINT_BYTES || !bytesEqual(actualSha256, expected)) {
      this.close();
      throw new Error("remote DTLS certificate mismatch");
    }
    this.dtlsVerified = true;
  }

  private frame(type: V2Frame["type"], plaintext: Uint8Array): V2Frame {
    if (this.closed) throw new Error("v2 session closed");
    if (plaintext.length > DATA_BYTES) throw new Error("v2 data too large");
    const seq = encodeNoiseSequence(this.nextSequence);
    const frame: V2Frame = {
      v: 2,
      type,
      sessionId: this.context.sessionId.slice(),
      generation: this.context.generation.slice(),
      seq,
      ciphertext: new Uint8Array(0),
    };
    frame.ciphertext = this.transport.seal(
      this.nextSequence,
      plaintext,
      frameAd(this.context, this.role, frame),
    );
    this.nextSequence += 1n;
    return frame;
  }

  private openFrame(input: V2Frame, expectedType: V2Frame["type"]): Uint8Array {
    if (this.closed) throw new Error("v2 session closed");
    const frame = V2FrameSchema.parse(input);
    if (frame.type !== expectedType) throw new Error("wrong v2 frame type");
    if (
      !bytesEqual(frame.sessionId, this.context.sessionId) ||
      !bytesEqual(frame.generation, this.context.generation)
    ) {
      throw new Error("wrong v2 session or route generation");
    }
    const sequence = decodeNoiseSequence(frame.seq);
    const plaintext = this.transport.open(
      sequence,
      frame.ciphertext,
      frameAd(this.context, opposite(this.role), frame),
    );
    // Noise permits nonce gaps so a dropped post-encryption queue write cannot force nonce
    // reuse. Shellbell cannot safely *apply* later terminal/signaling messages across a gap.
    if (sequence !== this.lastReceived + 1n) {
      plaintext.fill(0);
      this.close();
      throw new Error("v2 sequence gap requires resync");
    }
    this.lastReceived = sequence;
    return plaintext;
  }

  confirmation(): V2Frame {
    if (this.sentConfirmation) throw new Error("v2 confirmation already sent");
    const frame = this.frame(
      "confirm",
      encodeCbor([CONFIRM_DOMAIN, this.handshakeHash, this.role]),
    );
    this.sentConfirmation = true;
    return frame;
  }

  acceptConfirmation(frame: V2Frame): void {
    try {
      if (this.receivedConfirmation) throw new Error("v2 confirmation already received");
      if (decodeNoiseSequence(frame.seq) !== 0n)
        throw new Error("v2 confirmation sequence must be 0");
      const decoded = decodeCbor(this.openFrame(frame, "confirm"));
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 3 ||
        decoded[0] !== CONFIRM_DOMAIN ||
        !(decoded[1] instanceof Uint8Array) ||
        !bytesEqual(decoded[1], this.handshakeHash) ||
        decoded[2] !== opposite(this.role)
      ) {
        throw new Error("invalid v2 key confirmation");
      }
      this.receivedConfirmation = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  seal(plaintext: Uint8Array): V2Frame {
    if (this.closed) throw new Error("v2 session closed");
    if (!this.ready) throw new Error("v2 key confirmation incomplete");
    return this.frame("data", plaintext);
  }

  open(frame: V2Frame): Uint8Array {
    if (this.closed) throw new Error("v2 session closed");
    if (!this.ready) throw new Error("v2 key confirmation incomplete");
    if (decodeNoiseSequence(frame.seq) < 1n) throw new Error("v2 data sequence must be positive");
    return this.openFrame(frame, "data");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
    this.handshakeHash.fill(0);
  }
}
