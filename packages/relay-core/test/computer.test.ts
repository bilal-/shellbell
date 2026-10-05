import {
  createPairRevocationV2,
  encodeEnvelope,
  encodeV2RelayEnvelope,
  pairRevocationIdV2,
  randomBytes,
  sha256,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { createRelayCore, nextDeadline } from "../src/index.js";
import { device, harness } from "../test-support/core-harness.js";

describe("portable computer", () => {
  it.each(["agent", "phone"] as const)(
    "forwards %s ciphertext without storage reads or changing existing deadlines",
    async (sender) => {
      const h = harness();
      await h.connect("agent");
      const phone = await h.pair();
      await h.connect("phone", phone, "phone");
      await h.ctrl("agent", h.agent.fp, {
        type: "pairing-open",
        gateHash: new Uint8Array(32),
        expiresAt: 150_000,
      });
      h.options.notifications.nextDeadline = async () => 120_000;
      await h.core.reschedule();
      expect(h.deadlines.at(-1)).toBe(120_000);
      const deadlines = [...h.deadlines];
      const computer = vi.spyOn(h.identity, "computer");
      const window = vi.spyOn(h.identity, "window");
      const notifications = vi.spyOn(h.options.notifications, "nextDeadline");
      const from = sender === "agent" ? h.agent.fp : phone.fp;
      const to = sender === "agent" ? phone.fp : h.agent.fp;
      const recipient = sender === "agent" ? "phone" : "agent";
      const before = h.frames.get(recipient)?.length ?? 0;
      for (let seq = 0; seq < 10; seq++) {
        const frame = encodeEnvelope({
          v: 1,
          t: "e2e",
          from,
          to,
          seq,
          body: { n: new Uint8Array(24), c: new Uint8Array([seq]) },
        });
        await h.core.message(sender, frame);
        expect(h.frames.get(recipient)?.at(-1)).toEqual(frame);
      }
      expect(h.frames.get(recipient)?.length).toBe(before + 10);
      expect(h.closes).toEqual([]);
      expect(computer).not.toHaveBeenCalled();
      expect(window).not.toHaveBeenCalled();
      expect(notifications).not.toHaveBeenCalled();
      expect(h.deadlines).toEqual(deadlines);
    },
  );

  it("cleans up the authenticated generation when replacement auth scheduling fails", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: new Uint8Array(32),
      expiresAt: 150_000,
    });
    await h.core.open("replacement");
    const computer = h.identity.computer.bind(h.identity);
    let fail = true;
    h.identity.computer = async () => {
      if (fail) {
        fail = false;
        throw new Error("one-shot schedule failure");
      }
      return computer();
    };
    await h.auth("replacement", h.agent, "agent");
    expect(h.closes).toContainEqual({ id: "replacement", code: 1011, reason: "internal error" });
    expect(await h.identity.window()).toBe(null);
    expect(h.bodies("phone").at(-1)).toMatchObject({ type: "presence", agentOnline: false });
  });
  it("removes a closed ciphertext phone recipient and notifies the agent", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const send = h.options.transport.send;
    h.options.transport.send = (id, bytes) => (id === "phone" ? "closed" : send(id, bytes));
    await h.core.message(
      "agent",
      encodeEnvelope({
        v: 1,
        t: "e2e",
        from: h.agent.fp,
        to: phone.fp,
        seq: 1,
        body: { n: new Uint8Array(24), c: new Uint8Array([1]) },
      }),
    );
    expect(h.sessions.has("phone")).toBe(false);
    expect(h.bodies("agent").at(-1)).toEqual({
      type: "phone-disconnected",
      phoneFp: phone.fp,
      connId: "phone",
    });
    expect(h.closes.at(-1)).toEqual({ id: "phone", code: 1000, reason: "closed" });
  });
  it("cleans up a closed ciphertext agent recipient and broadcasts offline presence", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: new Uint8Array(32),
      expiresAt: 150_000,
    });
    const send = h.options.transport.send;
    h.options.transport.send = (id, bytes) => (id === "agent" ? "closed" : send(id, bytes));
    await h.core.message(
      "phone",
      encodeEnvelope({
        v: 1,
        t: "e2e",
        from: phone.fp,
        to: h.agent.fp,
        seq: 1,
        body: { n: new Uint8Array(24), c: new Uint8Array([1]) },
      }),
    );
    expect(h.sessions.has("agent")).toBe(false);
    expect(await h.identity.window()).toBe(null);
    expect(h.bodies("phone").at(-1)).toMatchObject({ type: "presence", agentOnline: false });
  });
  it("cleans up an agent rejected for malformed data without depending on a late close event", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: new Uint8Array(32),
      expiresAt: 150_000,
    });
    await h.core.message("agent", "invalid");
    expect(await h.identity.window()).toBe(null);
    expect(h.bodies("phone").at(-1)).toMatchObject({ type: "presence", agentOnline: false });
  });
  it("authenticates agents and paired phones and forwards exact ciphertext bytes", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    expect(h.bodies("phone")[1]).toMatchObject({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
      minFrameMs: 125,
    });
    const raw = encodeEnvelope({
      v: 1,
      t: "e2e",
      from: h.agent.fp,
      to: phone.fp,
      seq: 7,
      body: { n: new Uint8Array(24), c: new Uint8Array([8, 9, 10]) },
    });
    await h.core.message("agent", raw);
    expect(h.frames.get("phone")?.at(-1)).toEqual(raw);
    expect((await h.identity.pairing(phone.fp))?.lastSeenAt).toBe(100_000);
  });

  it("forwards opaque v2 carrier frames exactly between authenticated paired endpoints", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const agentFrame = encodeV2RelayEnvelope({
      v: 2,
      t: "e2e",
      from: h.agent.fp,
      to: phone.fp,
      body: new Uint8Array([2, 9, 8]),
    });
    await h.core.message("agent", agentFrame);
    expect(h.frames.get("phone")?.at(-1)).toEqual(agentFrame);
    const phoneFrame = encodeV2RelayEnvelope({
      v: 2,
      t: "e2e",
      from: phone.fp,
      to: h.agent.fp,
      body: new Uint8Array([2, 7, 6]),
    });
    await h.core.message("phone", phoneFrame);
    expect(h.frames.get("agent")?.at(-1)).toEqual(phoneFrame);
  });
  it("rejects sender spoofing and wrong-role control authority", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.ctrl("phone", h.agent.fp, { type: "pairing-close" });
    expect(h.closes.at(-1)).toMatchObject({ id: "phone", code: 4403, reason: "from mismatch" });
    await h.connect("phone2", phone, "phone");
    await h.ctrl("phone2", phone.fp, { type: "pairing-close" });
    expect(h.closes.at(-1)).toMatchObject({ id: "phone2", code: 4403 });
  });
  it("admits at most five pairing handshakes and one request each", async () => {
    const h = harness();
    await h.connect("agent");
    const gate = new Uint8Array(16).fill(4);
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: 9_000_000,
    });
    expect((await h.identity.window())?.expiresAt).toBe(700_000);
    for (let n = 0; n < 6; n++) {
      const phone = device("New phone");
      await h.core.open(`pair-${n}`);
      await h.auth(`pair-${n}`, phone, "pairing", gate);
    }
    expect(h.bodies("pair-5").at(-1)).toEqual({ type: "auth-fail", reason: "no-window" });
    expect(h.sessions.get("pair-0")?.state).toBe("pairing");
  });
  it("expires unauthenticated sockets at the deadline", async () => {
    const h = harness();
    await h.core.open("unauth");
    expect(h.deadlines.at(-1)).toBe(110_000);
    h.setNow(110_000);
    await h.core.wakeup();
    expect(h.closes.at(-1)).toMatchObject({ id: "unauth", code: 4408 });
  });
  it("closes only an overloaded ciphertext recipient with retryable code", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const send = h.options.transport.send;
    h.options.transport.send = (id, bytes) => (id === "phone" ? "overloaded" : send(id, bytes));
    await h.core.message(
      "agent",
      encodeEnvelope({
        v: 1,
        t: "e2e",
        from: h.agent.fp,
        to: phone.fp,
        seq: 1,
        body: { n: new Uint8Array(24), c: new Uint8Array([1]) },
      }),
    );
    expect(h.closes.at(-1)).toMatchObject({ id: "phone", code: 1013 });
    expect(h.sessions.get("agent")?.state).toBe("agent");
  });
  it("preserves offline unpair tombstones through auth and filters them during sync", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.core.close("agent");
    await h.ctrl("phone", phone.fp, { type: "unpair", phoneFp: phone.fp });
    await h.connect("replacement");
    expect(h.bodies("replacement").find((b) => b.type === "unpaired")).toEqual({
      type: "unpaired",
      phoneFps: [phone.fp],
    });
    expect(await h.identity.pendingRevocations()).toEqual([phone.fp]);
    await h.ctrl("replacement", h.agent.fp, {
      type: "pairings-sync",
      phones: [{ phoneFp: phone.fp, ed25519Pub: phone.id.ed25519.pub, name: phone.name }],
    });
    expect(await h.identity.pairing(phone.fp)).toBe(null);
    expect(await h.identity.pendingRevocations()).toEqual([]);
  });

  it("accepts an offline phone proof before auth and rejects replay after a new pairing", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    const oldKey = randomBytes(32);
    const first = await h.identity.pairing(phone.fp);
    if (!first) throw new Error("pair missing");
    await h.identity.syncPairings([{ ...first, pairId: pairRevocationIdV2(oldKey) }], 100);
    const proof = createPairRevocationV2({
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      kPair: oldKey,
      phoneEd25519Priv: phone.id.ed25519.priv,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    await h.core.open("submit");
    await h.ctrl("submit", phone.fp, {
      type: "revocation-submit",
      proof,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    expect(h.bodies("submit").at(-1)).toEqual({
      type: "revocation-receipt",
      phoneFp: phone.fp,
      pairId: proof.pairId,
      status: "stored",
    });
    expect(await h.identity.pairing(phone.fp)).toBe(null);
    expect(await h.identity.pendingRevocationProofs()).toEqual([proof]);
    await h.core.open("repeat");
    await h.ctrl("repeat", phone.fp, {
      type: "revocation-submit",
      proof,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    expect(h.bodies("repeat").at(-1)).toEqual({
      type: "revocation-receipt",
      phoneFp: phone.fp,
      pairId: proof.pairId,
      status: "stored",
    });
    await h.identity.acknowledgeRevocationProof(phone.fp, proof.pairId);
    const newer = { ...first, pairId: pairRevocationIdV2(randomBytes(32)) };
    await h.identity.addPairing(newer, 101);
    await h.core.open("replay");
    await h.ctrl("replay", phone.fp, {
      type: "revocation-submit",
      proof,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    expect(h.bodies("replay").at(-1)).toEqual({
      type: "revocation-receipt",
      phoneFp: phone.fp,
      pairId: proof.pairId,
      status: "stale",
    });
    expect((await h.identity.pairing(phone.fp))?.pairId).toEqual(newer.pairId);
  });

  it("rejects forged proof-only submission without deleting the current relay pairing", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    const kPair = randomBytes(32);
    const row = await h.identity.pairing(phone.fp);
    if (!row) throw new Error("pair missing");
    await h.identity.syncPairings([{ ...row, pairId: pairRevocationIdV2(kPair) }], 100);
    const proof = createPairRevocationV2({
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      kPair,
      phoneEd25519Priv: phone.id.ed25519.priv,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    const signature = new Uint8Array(proof.signature);
    signature[0] = (signature[0] ?? 0) ^ 1;
    await h.core.open("forged");
    await h.ctrl("forged", phone.fp, {
      type: "revocation-submit",
      proof: { ...proof, signature },
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    expect(h.closes.at(-1)).toMatchObject({ id: "forged", code: 4403 });
    expect((await h.identity.pairing(phone.fp))?.pairId).toEqual(pairRevocationIdV2(kPair));
  });

  it("keeps an offline proof retryable while current relay pairing lacks a pair ID", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair(); // Legacy row intentionally has no pairId.
    const proof = createPairRevocationV2({
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      kPair: randomBytes(32),
      phoneEd25519Priv: phone.id.ed25519.priv,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    await h.core.open("submit");
    await h.ctrl("submit", phone.fp, {
      type: "revocation-submit",
      proof,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    expect(h.bodies("submit").at(-1)).toEqual({
      type: "revocation-receipt",
      phoneFp: phone.fp,
      pairId: proof.pairId,
      status: "unavailable",
    });
    expect(await h.identity.pairing(phone.fp)).not.toBe(null);
  });

  it("does not claim durable storage when signed tombstone capacity is full", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    const kPair = randomBytes(32);
    const row = await h.identity.pairing(phone.fp);
    if (!row) throw new Error("pair missing");
    await h.identity.syncPairings([{ ...row, pairId: pairRevocationIdV2(kPair) }], 100);
    for (let i = 1; i <= 10; i++) {
      const other = device(`Phone ${i}`);
      await h.identity.revoke(other.fp, true, 100);
    }
    const proof = createPairRevocationV2({
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      kPair,
      phoneEd25519Priv: phone.id.ed25519.priv,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    await h.core.open("submit");
    await h.ctrl("submit", phone.fp, {
      type: "revocation-submit",
      proof,
      phoneEd25519Pub: phone.id.ed25519.pub,
    });
    expect(h.bodies("submit").at(-1)).toEqual({
      type: "revocation-receipt",
      phoneFp: phone.fp,
      pairId: proof.pairId,
      status: "unavailable",
    });
    expect(await h.identity.pairing(phone.fp)).not.toBe(null);
  });

  it("forwards a bounded phone revocation proof unchanged while the service is online", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const proof = {
      v: 2 as const,
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      pairId: new Uint8Array(32).fill(5),
      signature: new Uint8Array(64).fill(6),
    };
    await h.ctrl("phone", phone.fp, { type: "unpair", phoneFp: phone.fp, proof });
    expect(h.bodies("agent").find((b) => b.type === "unpair")).toEqual({
      type: "unpair",
      phoneFp: phone.fp,
      proof,
    });
    expect(await h.identity.pendingRevocations()).toEqual([phone.fp]);
    expect(await h.identity.pendingRevocationProofs()).toEqual([proof]);
  });

  it("delivers a phone-signed proof after the service was offline", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.core.close("agent");
    const proof = {
      v: 2 as const,
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      pairId: new Uint8Array(32).fill(5),
      signature: new Uint8Array(64).fill(6),
    };
    await h.ctrl("phone", phone.fp, { type: "unpair", phoneFp: phone.fp, proof });
    await h.connect("replacement");
    expect(h.bodies("replacement").find((b) => b.type === "unpaired")).toEqual({
      type: "unpaired",
      phoneFps: [phone.fp],
      proofs: [proof],
    });
  });

  it("does not acknowledge a newer proof with an older service sync or acknowledgement", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.core.close("agent");
    const first = {
      v: 2 as const,
      computerFp: h.agent.fp,
      phoneFp: phone.fp,
      pairId: new Uint8Array(32).fill(1),
      signature: new Uint8Array(64).fill(2),
    };
    const second = {
      ...first,
      pairId: new Uint8Array(32).fill(3),
      signature: new Uint8Array(64).fill(4),
    };
    await h.identity.revoke(phone.fp, true, 100, first);
    await h.connect("replacement");
    await h.identity.revoke(phone.fp, true, 101, second);
    await h.ctrl("replacement", h.agent.fp, { type: "pairings-sync", phones: [] });
    expect(await h.identity.pendingRevocationProofs()).toEqual([second]);
    await h.ctrl("replacement", h.agent.fp, {
      type: "revocation-ack",
      phoneFp: phone.fp,
      pairId: first.pairId,
    });
    expect(await h.identity.pendingRevocationProofs()).toEqual([second]);
    await h.ctrl("replacement", h.agent.fp, {
      type: "revocation-ack",
      phoneFp: phone.fp,
      pairId: second.pairId,
    });
    expect(await h.identity.pendingRevocationProofs()).toEqual([]);
  });
  it("routes one pairing request then rejects replay without forwarding it", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = device("Phone");
    const gate = new Uint8Array(16);
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: 150_000,
    });
    await h.core.open("pair");
    await h.auth("pair", phone, "pairing", gate);
    const body = {
      type: "pairing-request",
      phoneFp: phone.fp,
      box: { n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) },
    };
    await h.ctrl("pair", phone.fp, body);
    const count = h.frames.get("agent")?.length;
    await h.ctrl("pair", phone.fp, body);
    expect(h.frames.get("agent")?.length).toBe(count);
    expect(h.closes.at(-1)).toMatchObject({ id: "pair", code: 4403 });
  });
  it("restores authenticated sessions in a fresh core", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const restored = createRelayCore(h.options);
    const raw = encodeEnvelope({
      v: 1,
      t: "e2e",
      from: phone.fp,
      to: h.agent.fp,
      seq: 10,
      body: { n: new Uint8Array(24), c: new Uint8Array([1]) },
    });
    await restored.message("phone", raw);
    expect(h.frames.get("agent")?.at(-1)).toEqual(raw);
    await restored.message(
      "phone",
      encodeEnvelope({
        v: 1,
        t: "ctrl",
        from: phone.fp,
        seq: 0,
        body: { type: "lease", ttlMs: 30_000 },
      }),
    );
    expect(h.sessions.get("phone")?.leaseUntil).toBe(130_000);
  });
  it("enforces the unauth and phone binary size limits before parsing", async () => {
    const h = harness();
    await h.core.open("unauth");
    await h.core.message("unauth", new Uint8Array(4097));
    expect(h.closes.at(-1)).toMatchObject({ id: "unauth", code: 4413 });
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.core.message("phone", new Uint8Array(65_537));
    expect(h.closes.at(-1)).toMatchObject({ id: "phone", code: 4413 });
  });
  it("enforces the aggregate frame bucket and refills it using runtime time", async () => {
    const h = harness();
    await h.connect("agent");
    for (let i = 0; i < 199; i++) await h.ctrl("agent", h.agent.fp, { type: "pairing-close" });
    h.setNow(101_000);
    for (let i = 0; i < 60; i++) await h.ctrl("agent", h.agent.fp, { type: "pairing-close" });
    expect(h.sessions.has("agent")).toBe(true);
    await h.ctrl("agent", h.agent.fp, { type: "pairing-close" });
    expect(h.closes.at(-1)).toMatchObject({ id: "agent", code: 4429 });
  });
  it("reports storage errors, closes only the failing connection, and allows later transitions", async () => {
    const h = harness();
    await h.core.open("broken");
    const register = h.identity.registerComputer.bind(h.identity);
    h.identity.registerComputer = async () => {
      throw new Error("disk unavailable");
    };
    await h.auth("broken", h.agent, "agent");
    expect(h.closes.at(-1)).toMatchObject({ id: "broken", code: 1011 });
    expect(h.reports).toEqual(["storage-failure"]);
    h.identity.registerComputer = register;
    await h.connect("healthy");
    expect(h.sessions.get("healthy")?.state).toBe("agent");
  });
  it("selects the raw earliest domain deadline for the runtime scheduler", () => {
    expect(
      nextDeadline(
        1000,
        [],
        null,
        { gateHash: new Uint8Array(32), expiresAt: 5000, admitted: 0 },
        3000,
      ),
    ).toBe(3000);
    expect(nextDeadline(1000, [], null, null, 900)).toBe(900);
    expect(nextDeadline(1000, [], null, null, null)).toBe(null);
  });
  it("removes orphan metadata after the last unauthenticated session expires", async () => {
    const h = harness();
    await h.identity.openWindow(new Uint8Array(32), 900_000);
    await h.core.open("orphan");
    h.setNow(110_000);
    await h.core.wakeup();
    expect(await h.identity.window()).toBe(null);
    expect(h.deadlines.at(-1)).toBe(null);
  });
  it("expires a disconnected computer strictly after ninety days", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.core.close("agent");
    h.setNow(100_000 + 90 * 24 * 3600 * 1000);
    await h.core.wakeup();
    expect(await h.identity.computer()).not.toBe(null);
    h.setNow(100_001 + 90 * 24 * 3600 * 1000);
    await h.core.wakeup();
    expect(await h.identity.computer()).toBe(null);
    expect(h.closes.at(-1)).toMatchObject({ id: "phone", code: 4004 });
  });
});
it("reschedules notification changes without pumping or losing the auth deadline", async () => {
  const h = harness();
  await h.core.open("pending");
  h.options.notifications.nextDeadline = async () => 200_000;
  h.options.notifications.pump = async () => {
    throw new Error("reschedule must not pump");
  };
  await h.core.reschedule();
  expect(h.deadlines.at(-1)).toBe(110_000);
});

it("maintains successive security deadlines while one deferred delivery task stays held", async () => {
  const h = harness();
  await h.connect("agent");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pumps = 0;
  h.notifications.pump = async () => {
    pumps++;
    await held;
  };
  const deliveries: Promise<void>[] = [];
  const deferred = {
    deferDelivery: (task: Promise<void>) => {
      deliveries.push(task);
    },
  };
  const local = h.core.wakeup(deferred);
  try {
    const settled = await Promise.race([
      local.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(settled).toBe(true);
    for (let index = 0; index < 3; index++) {
      const now = 100_000 + index * 11_000;
      h.setNow(now);
      await h.core.open(`unauth-${index}`);
      h.setNow(now + 11_000);
      await h.core.wakeup(deferred);
      expect(h.closes.at(-1)).toMatchObject({ id: `unauth-${index}`, code: 4408 });
    }
    expect(pumps).toBe(1);
    expect(new Set(deliveries).size).toBe(1);
  } finally {
    release();
    await local;
    await Promise.all(deliveries);
  }
});

it("finishes retention cleanup without joining unrelated provider work", async () => {
  const h = harness();
  await h.connect("agent");
  await h.core.close("agent");
  h.setNow(100_001 + 90 * 24 * 3600 * 1000);
  h.notifications.pump = async () => {
    throw new Error("must not join existing provider work");
  };
  await expect(h.core.wakeup()).resolves.toBeUndefined();
  expect(await h.identity.computer()).toBeNull();
});
