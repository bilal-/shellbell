import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import { encodeNoiseSequence } from "../src/noise-kkpsk2.js";
import {
  createV2Handshake,
  type V2Frame,
  type V2SecureSession,
  type V2SessionContext,
} from "../src/session-v2.js";
import { encodeV2RoutePayload } from "../src/session-v2-route-wire.js";
import { V2RouteCoordinator } from "../src/session-v2-routes.js";

const computerFp = "a".repeat(26);
const phoneFp = "b".repeat(26);
const phonePrivate = new Uint8Array(32).fill(3);
const computerPrivate = new Uint8Array(32).fill(7);
const pairKey = new Uint8Array(32).fill(11);

function context(route: "relay" | "direct", session = 1, generation = 1): V2SessionContext {
  const common = {
    computerFp,
    phoneFp,
    sessionId: new Uint8Array(16).fill(session),
    attemptId: new Uint8Array(16).fill(generation + 1),
    generation: encodeNoiseSequence(BigInt(generation)),
  };
  return route === "relay"
    ? { ...common, route }
    : {
        ...common,
        route,
        phoneDtls: new Uint8Array(32).fill(13),
        computerDtls: new Uint8Array(32).fill(17),
      };
}

function securePeers(ctx: V2SessionContext, verifyDtls = true) {
  const phone = createV2Handshake(ctx, "phone", {
    staticPrivate: phonePrivate,
    remoteStatic: x25519.getPublicKey(computerPrivate),
    pairKey,
  });
  const computer = createV2Handshake(ctx, "computer", {
    staticPrivate: computerPrivate,
    remoteStatic: x25519.getPublicKey(phonePrivate),
    pairKey,
  });
  computer.read(phone.write());
  phone.read(computer.write());
  const p = phone.finish();
  const c = computer.finish();
  c.acceptConfirmation(p.confirmation());
  p.acceptConfirmation(c.confirmation());
  if (ctx.route === "direct" && verifyDtls) {
    p.verifyRemoteDtls(ctx.computerDtls);
    c.verifyRemoteDtls(ctx.phoneDtls);
  }
  return { phone: p, computer: c };
}

function fixture() {
  const clock = { now: 0 };
  const gate = { phone: true, computer: true };
  let relay = securePeers(context("relay"));
  let direct: ReturnType<typeof securePeers> | undefined;
  const queue: Array<{
    from: "phone" | "computer";
    session: V2SecureSession;
    frame: V2Frame;
    route: "relay" | "direct";
  }> = [];
  const bytes = { relay: 0, direct: 0 };
  const received = { phone: [] as Uint8Array[], computer: [] as Uint8Array[] };
  let nextTransition = 50;
  const transport = (
    from: "phone" | "computer",
    peers: ReturnType<typeof securePeers>,
    route: "relay" | "direct",
  ) => ({
    session: peers[from],
    send: (frame: V2Frame) => {
      bytes[route] += frame.ciphertext.length;
      queue.push({ from, session: peers[from === "phone" ? "computer" : "phone"], frame, route });
      return true;
    },
  });
  const phone = new V2RouteCoordinator({
    role: "phone",
    computerFp,
    phoneFp,
    relay: transport("phone", relay, "relay"),
    now: () => clock.now,
    newId: () => new Uint8Array(16).fill(nextTransition++),
    prepareReady: () => gate.phone,
  });
  const computer = new V2RouteCoordinator({
    role: "computer",
    computerFp,
    phoneFp,
    relay: transport("computer", relay, "relay"),
    now: () => clock.now,
    newId: () => new Uint8Array(16).fill(nextTransition++),
    prepareReady: () => gate.computer,
  });
  const deliver = () => {
    const packet = queue.shift();
    if (!packet) throw new Error("missing packet");
    const role = packet.from === "phone" ? "computer" : "phone";
    const owner = role === "phone" ? phone : computer;
    const data = owner.receive(packet.session, packet.frame);
    if (data?.kind === "terminal") received[role].push(data.bytes);
    if (owner.preparationPending && gate[role]) owner.approve();
    return packet;
  };
  const pump = () => {
    while (queue.length) deliver();
  };
  const stage = (generation = 2, verifyDtls = true, session = 1) => {
    direct = securePeers(context("direct", session, generation), verifyDtls);
    phone.stageDirect(transport("phone", direct, "direct"));
    computer.stageDirect(transport("computer", direct, "direct"));
    return direct;
  };
  const recover = (session: number) => {
    relay = securePeers(context("relay", session));
    phone.recover(transport("phone", relay, "relay"));
    computer.recover(transport("computer", relay, "relay"));
  };
  const close = () => {
    phone.close();
    computer.close();
  };
  return {
    phone,
    computer,
    clock,
    gate,
    relay,
    queue,
    bytes,
    received,
    deliver,
    pump,
    stage,
    recover,
    close,
  };
}

describe("authenticated paired route ownership", () => {
  it("admits no terminal data until both peers pass the prepare gate and commit", () => {
    const f = fixture();
    try {
      expect(f.phone.sendTerminal(utf8("input"))).toBe(false);
      f.gate.computer = false;
      f.phone.begin();
      f.deliver();
      expect(f.computer.preparationPending).toBe(true);
      expect(f.computer.approve()).toBe(false);
      expect(f.computer.sendTerminal(utf8("screen"))).toBe(false);
      f.gate.computer = true;
      expect(f.computer.approve()).toBe(true);
      f.pump();
      expect(f.phone.status).toBe("relay");
      expect(f.computer.status).toBe("relay");
      expect(f.phone.sendTerminal(utf8("input"))).toBe(true);
      f.pump();
      expect(f.received.computer).toEqual([utf8("input")]);
    } finally {
      f.close();
    }
  });

  it("pauses during cutover and sends zero terminal bytes through relay after direct commit", () => {
    const f = fixture();
    try {
      f.phone.begin();
      f.pump();
      f.stage();
      f.phone.begin();
      expect(f.phone.sendTerminal(utf8("during-cutover"))).toBe(false);
      f.deliver();
      expect(f.computer.sendTerminal(utf8("during-cutover"))).toBe(false);
      f.pump();
      expect(f.phone.status).toBe("direct");
      expect(f.computer.status).toBe("direct");
      const relayBytes = f.bytes.relay;
      f.phone.sendTerminal(utf8("input"));
      f.computer.sendTerminal(new Uint8Array(20_000).fill(7));
      f.pump();
      expect(f.bytes.relay).toBe(relayBytes);
      expect(f.bytes.direct).toBeGreaterThan(20_000);
      expect(f.received.computer).toEqual([utf8("input")]);
      expect(f.received.phone).toHaveLength(1);
      expect(f.phone.needsSnapshot).toBe(true);
      expect(f.computer.needsSnapshot).toBe(true);
    } finally {
      f.close();
    }
  });

  it("keeps direct traffic alive when relay presence disappears", () => {
    const f = fixture();
    try {
      f.phone.begin();
      f.pump();
      f.stage();
      f.phone.begin();
      f.pump();
      f.phone.relayLost();
      f.computer.relayLost();
      expect(f.phone.status).toBe("direct");
      f.phone.sendTerminal(utf8("still direct"));
      f.pump();
      expect(f.received.computer).toEqual([utf8("still direct")]);
    } finally {
      f.close();
    }
  });

  it("does not resume the old route after a commit acknowledgement is lost", () => {
    const f = fixture();
    try {
      f.phone.begin();
      f.pump();
      f.stage();
      f.phone.begin();
      f.deliver();
      f.deliver();
      f.deliver();
      f.queue.shift(); // The service committed, but the phone never learns that.
      expect(f.computer.status).toBe("direct");
      expect(f.phone.status).toBe("cutover");
      f.clock.now = 15_001;
      f.phone.sweep();
      expect(f.phone.status).toBe("recovering");
      expect(f.phone.sendTerminal(utf8("must not replay"))).toBe(false);
      f.recover(3);
      f.phone.begin();
      f.pump();
      expect(f.phone.status).toBe("relay");
      expect(f.phone.activeRoute?.generation).toEqual(encodeNoiseSequence(1n));
      expect(f.phone.activeRoute?.sessionId).toEqual(new Uint8Array(16).fill(3));
      expect(f.received.computer).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  it("retains the old relay route when a direct attempt expires before commit", () => {
    const f = fixture();
    try {
      f.phone.begin();
      f.pump();
      f.stage();
      f.clock.now = 15_001;
      f.phone.sweep();
      f.computer.sweep();
      expect(f.phone.status).toBe("relay");
      expect(f.phone.sendTerminal(utf8("relay fallback"))).toBe(true);
      f.pump();
      expect(f.received.computer).toEqual([utf8("relay fallback")]);
      expect(() => f.stage(2)).toThrow(/generation|reused/i);
    } finally {
      f.close();
    }
  });

  it("requires the live DTLS certificate and the current wire session for candidates", () => {
    const f = fixture();
    try {
      f.phone.begin();
      f.pump();
      expect(() => f.stage(2, false)).toThrow(/ready|confirm|DTLS/i);
      expect(() => f.stage(3, true, 9)).toThrow(/session/i);
      expect(f.phone.status).toBe("relay");
    } finally {
      f.close();
    }
  });

  it("ignores terminal frames on the retired route after committing direct", () => {
    const f = fixture();
    try {
      f.phone.begin();
      f.pump();
      f.stage();
      f.phone.begin();
      f.pump();
      const frame = f.relay.phone.seal(
        encodeV2RoutePayload({ kind: "terminal", bytes: utf8("old input") }),
      );
      expect(f.computer.receive(f.relay.computer, frame)).toBeNull();
      expect(f.received.computer).toHaveLength(0);
    } finally {
      f.close();
    }
  });
});
