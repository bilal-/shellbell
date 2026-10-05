import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { concat, fromBase64Url, toBase32Lower, toBase64Url, utf8 } from "./bytes.js";
import { ProtocolError } from "./codec.js";

export { randomBytes, sha256 };

export interface Identity {
  ed25519: { pub: Uint8Array; priv: Uint8Array };
  x25519: { pub: Uint8Array; priv: Uint8Array };
  createdAt: string;
}

export function generateIdentity(): Identity {
  return identityFromSeeds(randomBytes(32), randomBytes(32), new Date().toISOString());
}

/** Deterministic construction used by golden vectors and tests. Seeds must be 32 bytes. */
export function identityFromSeeds(
  edSeed: Uint8Array,
  xSeed: Uint8Array,
  createdAt: string,
): Identity {
  const e = ed25519.keygen(edSeed);
  const x = x25519.keygen(xSeed);
  return {
    ed25519: { pub: e.publicKey, priv: e.secretKey },
    x25519: { pub: x.publicKey, priv: x.secretKey },
    createdAt,
  };
}

const IdentityJsonSchema = z.object({
  v: z.literal(1),
  ed25519: z.object({ pub: z.string(), priv: z.string() }),
  x25519: z.object({ pub: z.string(), priv: z.string() }),
  createdAt: z.string(),
});
export type IdentityJson = z.infer<typeof IdentityJsonSchema>;

export function identityToJson(id: Identity): IdentityJson {
  return {
    v: 1,
    ed25519: { pub: toBase64Url(id.ed25519.pub), priv: toBase64Url(id.ed25519.priv) },
    x25519: { pub: toBase64Url(id.x25519.pub), priv: toBase64Url(id.x25519.priv) },
    createdAt: id.createdAt,
  };
}

export function identityFromJson(j: unknown): Identity {
  const r = IdentityJsonSchema.safeParse(j);
  if (!r.success) throw new ProtocolError("malformed", `identity: ${z.prettifyError(r.error)}`);
  const p = r.data;
  let ed25519Pub: Uint8Array;
  let ed25519Priv: Uint8Array;
  let x25519Pub: Uint8Array;
  let x25519Priv: Uint8Array;
  try {
    ed25519Pub = fromBase64Url(p.ed25519.pub);
    ed25519Priv = fromBase64Url(p.ed25519.priv);
    x25519Pub = fromBase64Url(p.x25519.pub);
    x25519Priv = fromBase64Url(p.x25519.priv);
  } catch {
    throw new ProtocolError("malformed", "identity: bad base64url");
  }
  if (
    ed25519Pub.length !== 32 ||
    ed25519Priv.length !== 32 ||
    x25519Pub.length !== 32 ||
    x25519Priv.length !== 32
  ) {
    throw new ProtocolError("malformed", "identity: key length");
  }
  return {
    ed25519: { pub: ed25519Pub, priv: ed25519Priv },
    x25519: { pub: x25519Pub, priv: x25519Priv },
    createdAt: p.createdAt,
  };
}

/** base32lower(sha256(pub))[0..26] */
export function fingerprint(ed25519Pub: Uint8Array): string {
  return toBase32Lower(sha256(ed25519Pub)).slice(0, 26);
}

function asBytes(m: string | Uint8Array): Uint8Array {
  return typeof m === "string" ? utf8(m) : m;
}

export function sign(priv: Uint8Array, msg: string | Uint8Array): Uint8Array {
  return ed25519.sign(asBytes(msg), priv);
}

export function verify(pub: Uint8Array, msg: string | Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, asBytes(msg), pub);
  } catch {
    return false;
  }
}

export function authMessage(connId: string, role: string, fp: string, nonce: Uint8Array): string {
  return `shellbell-auth-v1|${connId}|${role}|${fp}|${toBase64Url(nonce)}`;
}

export interface Box {
  n: Uint8Array;
  c: Uint8Array;
}

/** Deterministic AEAD for golden vectors and tests ONLY. Never call this from runtime code: reusing a (key, nonce) pair with XChaCha20-Poly1305 leaks the keystream and MAC key. Use seal(). */
export function sealWithNonce(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  ad: string,
): Box {
  const c = xchacha20poly1305(key, nonce, utf8(ad)).encrypt(plaintext);
  return { n: nonce, c };
}

export function seal(key: Uint8Array, plaintext: Uint8Array, ad: string): Box {
  return sealWithNonce(key, randomBytes(24), plaintext, ad);
}

export function open(key: Uint8Array, box: Box, ad: string): Uint8Array {
  try {
    return xchacha20poly1305(key, box.n, utf8(ad)).decrypt(box.c);
  } catch {
    throw new ProtocolError("crypto", "aead open failed");
  }
}

export function derivePskKey(code: Uint8Array, computerFp: string): Uint8Array {
  return hkdf(sha256, code, utf8("shellbell-pairing-v1"), utf8(computerFp), 32);
}

export function derivePairKey(
  myX25519Priv: Uint8Array,
  theirX25519Pub: Uint8Array,
  code: Uint8Array,
  computerFp: string,
  phoneFp: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(myX25519Priv, theirX25519Pub);
  if (shared.every((b) => b === 0)) throw new ProtocolError("crypto", "low-order point");
  return hkdf(
    sha256,
    concat(shared, code),
    utf8("shellbell-pair-v1"),
    utf8(`${computerFp}|${phoneFp}`),
    32,
  );
}

export function deriveConnKey(
  kPair: Uint8Array,
  nPhone: Uint8Array,
  nAgent: Uint8Array,
  computerFp: string,
  phoneFp: string,
): { kConn: Uint8Array; connTag: string } {
  const salt = concat(nPhone, nAgent);
  const kConn = hkdf(sha256, kPair, salt, utf8(`shellbell-conn-v1|${computerFp}|${phoneFp}`), 32);
  const connTag = toBase64Url(sha256(salt)).slice(0, 22);
  return { kConn, connTag };
}

/** Noise v2 must not reuse raw K_pair, which also protects legacy connection setup. */
export function deriveNoisePsk(kPair: Uint8Array, computerFp: string, phoneFp: string): Uint8Array {
  if (
    kPair.length !== 32 ||
    !/^[a-z2-7]{26}$/.test(computerFp) ||
    !/^[a-z2-7]{26}$/.test(phoneFp)
  ) {
    throw new ProtocolError("malformed", "invalid Noise PSK derivation input");
  }
  return hkdf(sha256, kPair, utf8("shellbell-noise-v2-psk"), utf8(`${computerFp}|${phoneFp}`), 32);
}

export function frameAd(from: string, to: string, connTag: string, seq: number): string {
  return `1|${from}|${to}|${connTag}|${seq}`;
}

export function helloAd(from: string, to: string): string {
  return `1|${from}|${to}|hello|0`;
}

export function pairingAd(
  kind: "request" | "response",
  computerFp: string,
  phoneFp: string,
): string {
  return `pairing-${kind}|${computerFp}|${phoneFp}`;
}
