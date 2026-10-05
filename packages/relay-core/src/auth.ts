import { authMessage, type CtrlMessageOf, fingerprint, verify } from "@shellbell/protocol";

export function verifyAuthMessage(
  msg: CtrlMessageOf<"auth">,
  connId: string,
  nonce: Uint8Array,
): "ok" | "fp-mismatch" | "bad-sig" {
  if (fingerprint(msg.ed25519Pub) !== msg.fp) return "fp-mismatch";
  if (!verify(msg.ed25519Pub, authMessage(connId, msg.role, msg.fp, nonce), msg.sig)) {
    return "bad-sig";
  }
  return "ok";
}
