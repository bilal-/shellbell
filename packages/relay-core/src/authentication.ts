import {
  bytesEqual,
  type CtrlMessageOf,
  fromBase64Url,
  NOTIFICATION_FEATURE,
  sha256,
} from "@shellbell/protocol";
import { verifyAuthMessage } from "./auth.js";
import type { TransitionContext } from "./computer.js";
import { issueIceServers, NO_ICE_SERVERS, turnWithheld } from "./ice.js";
import type { SessionRecord } from "./session.js";

export async function authenticate(
  c: TransitionContext,
  session: SessionRecord,
  msg: CtrlMessageOf<"auth">,
  owns: () => boolean,
): Promise<void> {
  function fail(reason: CtrlMessageOf<"auth-fail">["reason"]) {
    c.send(session, { type: "auth-fail", reason });
    c.drop(session, 4001, reason);
  }
  const verification = verifyAuthMessage(msg, session.connId, fromBase64Url(session.nonce));
  if (verification !== "ok") return fail(verification);
  if (msg.role === "agent" && msg.fp !== c.computerFp) return fail("fp-mismatch");
  if (!owns()) return;
  const now = c.runtime.now();
  const min = c.minFrameMs ?? 125;
  const minFrameMs = Number.isNaN(min) ? 125 : Math.min(2000, Math.max(50, Math.round(min)));
  let computerName: string | null;
  let tombstones: readonly string[] = [];
  let revocationProofs: Awaited<ReturnType<typeof c.identity.pendingRevocationProofs>> = [];
  if (msg.role === "agent") {
    await c.identity.registerComputer({
      fingerprint: msg.fp,
      publicKey: new Uint8Array(msg.ed25519Pub),
      name: msg.name,
      firstSeen: now,
      lastSeen: now,
    });
    if (!owns()) return;
    tombstones = await c.identity.pendingRevocations();
    if (!owns()) return;
    revocationProofs = await c.identity.pendingRevocationProofs();
    if (!owns()) return;
    computerName = msg.name;
  } else {
    const computer = await c.identity.computer();
    if (!owns()) return;
    computerName = computer?.name ?? null;
    if (msg.role === "phone") {
      const row = await c.identity.pairing(msg.fp);
      if (!owns()) return;
      if (!row || !bytesEqual(row.publicKey, msg.ed25519Pub)) return fail("not-paired");
      await c.identity.markPairingSeen(msg.fp, now);
      if (!owns()) return;
    } else {
      if (!c.agent()) return fail("no-agent");
      if (!msg.gate) return fail("no-window");
      const result = await c.identity.admitPairing(sha256(msg.gate), now);
      if (!owns()) return;
      if (!c.agent()) return fail("no-agent");
      if (result !== "admitted") return fail("no-window");
    }
  }
  // Pairing sockets never use WebRTC; only signed-in devices get TURN servers. A relay with
  // TURN always advertises it, even with none to give yet, so devices know to refresh later.
  // Issue before committing the role: from here to auth-ok nothing may wait, or a newer
  // sign-in could take ownership and leave this socket signed in but never answered.
  const turnOff = msg.role === "agent" && msg.turn === false;
  const authenticated: SessionRecord = {
    ...session,
    state: msg.role,
    fp: msg.fp,
    name: msg.name,
    ...(turnOff && { turnOff: true as const }),
  };
  let ice =
    msg.role === "pairing" || !c.iceServers
      ? null
      : turnWithheld(c, authenticated)
        ? NO_ICE_SERVERS
        : ((await issueIceServers(c)) ?? NO_ICE_SERVERS);
  if (!owns()) return;
  // Transitions run one at a time, but recheck after the wait rather than rely on it.
  if (ice && turnWithheld(c, authenticated)) ice = NO_ICE_SERVERS;
  c.save(authenticated);
  if (msg.role !== "pairing") {
    for (const old of c.sessions()) {
      if (
        old.connId !== session.connId &&
        old.state === msg.role &&
        (msg.role === "agent" || old.fp === msg.fp)
      )
        c.drop(old, 4005, "superseded");
    }
  }
  c.send(authenticated, {
    type: "auth-ok",
    role: msg.role,
    features: [NOTIFICATION_FEATURE],
    agentOnline: c.agent() !== undefined,
    computerName,
    serverTime: now,
    minFrameMs,
    ...(ice && { iceServers: ice.iceServers, iceExpiresInMs: ice.expiresInMs }),
    ...(turnOff && { turnOff: true as const }),
  });
  const agent = c.agent();
  if (msg.role === "agent") {
    c.send(authenticated, {
      type: "unpaired",
      phoneFps: [...tombstones],
      ...(revocationProofs.length > 0 && { proofs: [...revocationProofs] }),
    });
    const phones = c.sessions().filter((p) => p.state === "phone");
    c.send(authenticated, {
      type: "phones",
      connected: phones.map((p) => ({
        phoneFp: p.fp as string,
        connId: p.connId,
        name: p.name ?? "",
      })),
    });
    for (const phone of phones) {
      // Phones signed in while this computer was away may hold TURN servers. Clear them before
      // announcing the computer, so no direct attempt to it can use one.
      if (turnOff)
        c.send(phone, {
          type: "ice-servers",
          iceServers: [],
          iceExpiresInMs: 0,
        });
      c.send(phone, { type: "presence", agentOnline: true, computerName });
    }
  } else if (msg.role === "phone" && agent) {
    c.send(agent, {
      type: "phone-connected",
      phoneFp: msg.fp,
      connId: session.connId,
      name: msg.name,
    });
  }
}
