import {
  bytesEqual,
  type CtrlMessageOf,
  verifyPairRevocationSignatureV2,
} from "@shellbell/protocol";
import type { TransitionContext } from "./computer.js";
import { closePhone } from "./pairing.js";
import type { SessionRecord } from "./session.js";

/** A proof-only retry works after the phone erased K_pair and cannot authenticate as paired. */
export async function submitRevocation(
  c: TransitionContext,
  session: SessionRecord,
  from: string,
  msg: CtrlMessageOf<"revocation-submit">,
): Promise<void> {
  const { proof, phoneEd25519Pub } = msg;
  if (
    from !== proof.phoneFp ||
    !verifyPairRevocationSignatureV2(proof, {
      computerFp: c.computerFp,
      phoneFp: proof.phoneFp,
      phoneEd25519Pub,
    })
  ) {
    c.drop(session, 4403, "invalid revocation proof");
    return;
  }

  const current = await c.identity.pairing(proof.phoneFp);
  if (!c.current(session)) return;
  if (current) {
    if (!current.pairId) {
      c.send(session, {
        type: "revocation-receipt",
        phoneFp: proof.phoneFp,
        pairId: proof.pairId,
        status: "unavailable",
      });
      return;
    }
    if (
      !bytesEqual(current.pairId, proof.pairId) ||
      !bytesEqual(current.publicKey, phoneEd25519Pub)
    ) {
      c.send(session, {
        type: "revocation-receipt",
        phoneFp: proof.phoneFp,
        pairId: proof.pairId,
        status: "stale",
      });
      return;
    }
    // Persist before online forwarding; WebSocket send does not prove local key deletion.
    const stored = await c.identity.revoke(proof.phoneFp, true, c.runtime.now(), proof);
    if (!stored) {
      c.send(session, {
        type: "revocation-receipt",
        phoneFp: proof.phoneFp,
        pairId: proof.pairId,
        status: "unavailable",
      });
      return;
    }
    const agent = c.agent();
    if (agent) c.send(agent, { type: "unpair", phoneFp: proof.phoneFp, proof });
    closePhone(c, proof.phoneFp);
    c.send(session, {
      type: "revocation-receipt",
      phoneFp: proof.phoneFp,
      pairId: proof.pairId,
      status: "stored",
    });
    return;
  }

  const pending = (await c.identity.pendingRevocationProofs()).find(
    (row) => row.phoneFp === proof.phoneFp,
  );
  if (!c.current(session)) return;
  c.send(session, {
    type: "revocation-receipt",
    phoneFp: proof.phoneFp,
    pairId: proof.pairId,
    status: pending ? (bytesEqual(pending.pairId, proof.pairId) ? "stored" : "stale") : "absent",
  });
}
