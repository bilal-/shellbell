import {
  bytesEqual,
  type CtrlMessage,
  type RoutableEnvelope,
  verifyPairRevocationSignatureV2,
} from "@shellbell/protocol";
import type { TransitionContext } from "./computer.js";
import { refreshIceServers } from "./ice.js";
import { closePhone } from "./pairing.js";
import type { SessionRecord } from "./session.js";

export function routeCiphertext(
  c: TransitionContext,
  session: SessionRecord,
  envelope: RoutableEnvelope,
  raw: Uint8Array,
): void {
  if (session.state !== "agent" && session.state !== "phone") {
    c.drop(session, 4403, "e2e requires auth");
    return;
  }
  if (envelope.from !== session.fp) {
    c.drop(session, 4403, "from mismatch");
    return;
  }
  if (!envelope.to) {
    c.drop(session, 4400, "e2e needs to");
    return;
  }
  const targets =
    session.state === "agent"
      ? c.sessions().filter((s) => s.state === "phone" && s.fp === envelope.to)
      : envelope.to === c.computerFp
        ? c.sessions().filter((s) => s.state === "agent")
        : [];
  for (const target of targets) {
    const result = c.transport.send(target.connId, new Uint8Array(raw));
    if (result === "overloaded") {
      c.runtime.report("overload");
      c.drop(target, 1013, "overloaded");
    }
    if (result === "closed") c.drop(target, 1000, "closed");
  }
}

export async function phoneControl(
  c: TransitionContext,
  session: SessionRecord,
  msg: CtrlMessage,
): Promise<void> {
  const fp = session.fp as string;
  switch (msg.type) {
    case "unpair": {
      if (msg.phoneFp !== fp) {
        c.drop(session, 4403, "may only unpair self");
        return;
      }
      if (msg.proof) {
        // The same checks as a proof-only submission: an old proof from this phone would otherwise
        // delete the current pairing and leave a tombstone the service refuses to apply.
        const current = await c.identity.pairing(fp);
        if (!c.current(session)) return;
        if (
          current?.pairId &&
          (!bytesEqual(current.pairId, msg.proof.pairId) ||
            !verifyPairRevocationSignatureV2(msg.proof, {
              computerFp: c.computerFp,
              phoneFp: fp,
              phoneEd25519Pub: current.publicKey,
            }))
        ) {
          c.send(session, {
            type: "revocation-receipt",
            phoneFp: fp,
            pairId: msg.proof.pairId,
            status: "stale",
          });
          break;
        }
      }
      const agent = c.agent();
      // Store before forwarding: a successful WebSocket send is not evidence the
      // service durably applied the proof. Reconnect will deliver the tombstone.
      const stored = await c.identity.revoke(fp, true, c.runtime.now(), msg.proof);
      if (msg.proof && !stored) {
        c.send(session, {
          type: "revocation-receipt",
          phoneFp: fp,
          pairId: msg.proof.pairId,
          status: "unavailable",
        });
        break;
      }
      if (agent) c.send(agent, msg);
      closePhone(c, fp);
      break;
    }
    case "push-token":
      await c.notifications.register(fp, msg);
      break;
    case "ice-refresh":
      await refreshIceServers(c, session);
      break;
    case "lease":
      c.save({ ...session, leaseUntil: c.runtime.now() + msg.ttlMs });
      if (msg.ttlMs > 0) await c.notifications.cancelPhone(fp);
      break;
    default:
      c.drop(session, 4403, `phone may not send ${msg.type}`);
  }
}
