import { type CtrlMessage, MAX_PAIRINGS } from "@shellbell/protocol";
import type { TransitionContext } from "./computer.js";
import type { PairingRecord } from "./ports/models.js";
import type { SessionRecord } from "./session.js";

export function pairingRecord(
  phoneFp: string,
  publicKey: Uint8Array,
  name: string,
  now: number,
  pairId?: Uint8Array,
): PairingRecord {
  return {
    phoneFp,
    publicKey: new Uint8Array(publicKey),
    ...(pairId && { pairId: new Uint8Array(pairId) }),
    name,
    pushToken: null,
    pushPlatform: null,
    pushEnabled: true,
    pairedAt: now,
    lastSeenAt: null,
  };
}
export function closePhone(c: TransitionContext, fp: string) {
  for (const phone of c.sessions())
    if (phone.state === "phone" && phone.fp === fp) c.drop(phone, 4004, "unpaired");
}
export async function agentControl(
  c: TransitionContext,
  session: SessionRecord,
  msg: CtrlMessage,
): Promise<boolean> {
  const now = c.runtime.now();
  switch (msg.type) {
    case "pairing-open":
      await c.identity.openWindow(
        new Uint8Array(msg.gateHash),
        Math.min(msg.expiresAt, now + 10 * 60 * 1000),
      );
      // A disconnect during the write cannot leave a fresh invitation open.
      if (!c.current(session)) await c.identity.closeWindow();
      break;
    case "pairing-close":
      await c.identity.closeWindow();
      break;
    case "pairing-add": {
      const result = await c.identity.addPairing(
        pairingRecord(msg.phoneFp, msg.ed25519Pub, msg.name, now, msg.pairId),
        now,
      );
      if (!c.current(session)) return false;
      if (result === "full")
        c.send(session, {
          type: "error",
          code: "too-many-pairings",
          message: `max ${MAX_PAIRINGS} phones`,
        });
      break;
    }
    case "pairing-response":
    case "pairing-reject": {
      const target = c.sessions().find((s) => s.state === "pairing" && s.fp === msg.phoneFp);
      if (target) {
        c.send(target, msg);
        if (msg.type === "pairing-reject") c.drop(target, 4003, msg.reason);
      }
      break;
    }
    case "pairings-sync": {
      const before = await c.identity.pairings();
      if (!c.current(session)) return false;
      const revoked = await c.identity.syncPairings(
        msg.phones.map((p) => pairingRecord(p.phoneFp, p.ed25519Pub, p.name, now, p.pairId)),
        now,
      );
      const keep = new Set(msg.phones.map((p) => p.phoneFp));
      for (const row of before)
        if (!keep.has(row.phoneFp) || revoked.includes(row.phoneFp)) closePhone(c, row.phoneFp);
      break;
    }
    case "revocation-ack":
      await c.identity.acknowledgeRevocationProof(msg.phoneFp, msg.pairId);
      break;
    case "unpair":
      await c.identity.revoke(msg.phoneFp, false, now);
      closePhone(c, msg.phoneFp);
      break;
    case "notify":
    case "notify-context":
      await c.notifications.enqueue(msg);
      return true;
    default:
      c.drop(session, 4403, `agent may not send ${msg.type}`);
  }
  return false;
}

export async function pairingControl(
  c: TransitionContext,
  session: SessionRecord,
  msg: CtrlMessage,
): Promise<void> {
  if (msg.type !== "pairing-request" || msg.phoneFp !== session.fp || session.used) {
    c.drop(session, 4403, "one pairing-request only");
    return;
  }
  const agent = c.agent();
  if (!agent) {
    c.send(session, { type: "pairing-reject", phoneFp: msg.phoneFp, reason: "no-agent" });
    c.drop(session, 4003, "no-agent");
    return;
  }
  c.save({ ...session, used: true });
  c.send(agent, msg);
}
