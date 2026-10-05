/** Pair-scoped revocation authority. Isolated until both relay adapters persist proofs. */
import { z } from "zod";
import { concat, utf8 } from "./bytes.js";
import { decodeCbor, encodeCbor, ProtocolError } from "./codec.js";
import { fingerprint, sha256, sign, verify } from "./crypto.js";
import { Bytes, FpSchema } from "./envelope.js";

const PAIR_ID_DOMAIN = utf8("shellbell-pair-revocation-id-v2\0");
const SIGNING_DOMAIN = "shellbell-pair-revocation-v2";
export const PAIR_REVOCATION_WIRE_MAX = 256;

export const PairRevocationV2Schema = z.strictObject({
  v: z.literal(2),
  computerFp: FpSchema,
  phoneFp: FpSchema,
  pairId: Bytes(32),
  signature: Bytes(64),
});
export type PairRevocationV2 = z.infer<typeof PairRevocationV2Schema>;

export function encodePairRevocationV2(proof: PairRevocationV2): Uint8Array {
  const bytes = encodeCbor(PairRevocationV2Schema.parse(proof));
  if (bytes.length > PAIR_REVOCATION_WIRE_MAX)
    throw new ProtocolError("malformed", "revocation proof oversize");
  return bytes;
}

export function decodePairRevocationV2(bytes: Uint8Array): PairRevocationV2 {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > PAIR_REVOCATION_WIRE_MAX
  ) {
    throw new ProtocolError("malformed", "revocation proof oversize");
  }
  const result = PairRevocationV2Schema.safeParse(decodeCbor(bytes));
  if (!result.success) throw new ProtocolError("malformed");
  return result.data;
}

export function pairRevocationIdV2(kPair: Uint8Array): Uint8Array {
  if (!(kPair instanceof Uint8Array) || kPair.length !== 32) {
    throw new Error("K_pair must be 32 bytes");
  }
  return sha256(concat(PAIR_ID_DOMAIN, kPair));
}

function signingBytes(computerFp: string, phoneFp: string, pairId: Uint8Array): Uint8Array {
  return encodeCbor([SIGNING_DOMAIN, computerFp, phoneFp, pairId]);
}

function same32(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  let mismatch = 0;
  for (let i = 0; i < 32; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

export function createPairRevocationV2(input: {
  computerFp: string;
  phoneFp: string;
  kPair: Uint8Array;
  phoneEd25519Priv: Uint8Array;
  phoneEd25519Pub: Uint8Array;
}): PairRevocationV2 {
  FpSchema.parse(input.computerFp);
  FpSchema.parse(input.phoneFp);
  if (input.phoneEd25519Priv.length !== 32 || input.phoneEd25519Pub.length !== 32) {
    throw new Error("phone identity keys must be 32 bytes");
  }
  if (fingerprint(input.phoneEd25519Pub) !== input.phoneFp) {
    throw new Error("phone fingerprint does not match signing identity");
  }
  const pairId = pairRevocationIdV2(input.kPair);
  const message = signingBytes(input.computerFp, input.phoneFp, pairId);
  const signature = sign(input.phoneEd25519Priv, message);
  if (!verify(input.phoneEd25519Pub, message, signature)) {
    throw new Error("phone signing key does not match stored public key");
  }
  return { v: 2, computerFp: input.computerFp, phoneFp: input.phoneFp, pairId, signature };
}

/** Use only locally stored pair/identity fields as trust input, never relay-provided keys. */
export function verifyPairRevocationV2(
  candidate: unknown,
  trusted: {
    computerFp: string;
    phoneFp: string;
    kPair: Uint8Array;
    phoneEd25519Pub: Uint8Array;
  },
): candidate is PairRevocationV2 {
  if (!verifyPairRevocationSignatureV2(candidate, trusted)) return false;
  try {
    return same32(candidate.pairId, pairRevocationIdV2(trusted.kPair));
  } catch {
    return false;
  }
}

/** Relay can check identity/signature; it must separately compare stored current pairId. */
export function verifyPairRevocationSignatureV2(
  candidate: unknown,
  trusted: { computerFp: string; phoneFp: string; phoneEd25519Pub: Uint8Array },
): candidate is PairRevocationV2 {
  const parsed = PairRevocationV2Schema.safeParse(candidate);
  if (!parsed.success) return false;
  const proof = parsed.data;
  if (
    proof.computerFp !== trusted.computerFp ||
    proof.phoneFp !== trusted.phoneFp ||
    trusted.phoneEd25519Pub.length !== 32 ||
    fingerprint(trusted.phoneEd25519Pub) !== trusted.phoneFp
  )
    return false;
  try {
    return verify(
      trusted.phoneEd25519Pub,
      signingBytes(proof.computerFp, proof.phoneFp, proof.pairId),
      proof.signature,
    );
  } catch {
    return false;
  }
}
