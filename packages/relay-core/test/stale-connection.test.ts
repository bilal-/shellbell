import { encodeEnvelope } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { deferred, harness } from "../test-support/core-harness.js";

describe("connection ownership", () => {
  it("bounds simultaneous unauthenticated connections and admits after a slot is freed", async () => {
    const h = harness();
    await Promise.all(Array.from({ length: 128 }, (_, i) => h.core.open(`unauth-${i}`)));
    await h.core.open("overflow");
    expect(h.sessions.size).toBe(128);
    expect(h.closes).toContainEqual({ id: "overflow", code: 1013, reason: "connection limit" });
    expect(h.frames.has("overflow")).toBe(false);
    await h.core.close("unauth-0");
    await h.core.open("replacement");
    expect(h.sessions.get("replacement")?.state).toBe("unauth");
    expect(h.sessions.size).toBe(128);
  });
  it("enumerates recipients once rather than copying every session for ownership lookups", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const enumerate = vi.spyOn(h.options.transport, "sessions");
    await h.core.message(
      "phone",
      encodeEnvelope({
        v: 1,
        t: "e2e",
        from: phone.fp,
        to: h.agent.fp,
        seq: 1,
        body: { n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) },
      }),
    );
    expect(enumerate).toHaveBeenCalledTimes(1);
  });
  it("does not drop a replacement generation when an older authentication rejects", async () => {
    const h = harness();
    await h.core.open("reused");
    const entered = deferred();
    const release = deferred();
    h.identity.registerComputer = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("old persistence failure");
    };
    const old = h.auth("reused", h.agent, "agent");
    await entered.promise;
    const reopened = h.core.open("reused");
    release.resolve();
    await Promise.all([old, reopened]);
    expect(h.sessions.get("reused")?.state).toBe("unauth");
    expect(h.closes).toEqual([]);
  });
  it("retains a revocation when its notification cannot reach an overloaded agent", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const send = h.options.transport.send;
    h.options.transport.send = (id, bytes) => (id === "agent" ? "overloaded" : send(id, bytes));
    await h.ctrl("phone", phone.fp, { type: "unpair", phoneFp: phone.fp });
    expect(await h.identity.pendingRevocations()).toEqual([phone.fp]);
  });
  it("retains an offline revocation if the agent disconnects during persistence", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const entered = deferred();
    const release = deferred();
    const revoke = h.identity.revoke.bind(h.identity);
    h.identity.revoke = async (...args) => {
      entered.resolve();
      await release.promise;
      return revoke(...args);
    };
    const unpair = h.ctrl("phone", phone.fp, { type: "unpair", phoneFp: phone.fp });
    await entered.promise;
    const close = h.core.close("agent");
    release.resolve();
    await Promise.all([unpair, close]);
    expect(await h.identity.pendingRevocations()).toEqual([phone.fp]);
  });
  it("cannot close a reopened connection from a queued close callback", async () => {
    const h = harness();
    await h.connect("agent");
    const entered = deferred();
    const release = deferred();
    h.identity.markSeen = async () => {
      entered.resolve();
      await release.promise;
    };
    const close = h.core.close("agent");
    await entered.promise;
    const reopen = h.core.open("agent");
    release.resolve();
    await Promise.all([close, reopen]);
    expect(h.sessions.get("agent")?.state).toBe("unauth");
  });
  it("does not let a forged competing authentication invalidate the real signer", async () => {
    const h = harness();
    await h.core.open("old");
    await h.core.open("forged");
    const entered = deferred();
    const release = deferred();
    const register = h.identity.registerComputer.bind(h.identity);
    h.identity.registerComputer = async (record) => {
      entered.resolve();
      await release.promise;
      await register(record);
    };
    const real = h.auth("old", h.agent, "agent");
    await entered.promise;
    const forged = h.ctrl("forged", h.agent.fp, {
      type: "auth",
      role: "agent",
      fp: h.agent.fp,
      name: "spoof",
      ed25519Pub: h.agent.id.ed25519.pub,
      sig: new Uint8Array(64),
      appVersion: "test",
    });
    release.resolve();
    await Promise.all([real, forged]);
    expect(h.sessions.get("old")?.state).toBe("agent");
    expect(h.bodies("forged").at(-1)).toEqual({ type: "auth-fail", reason: "bad-sig" });
  });
  it("owns an incoming Buffer view while another transition is suspended", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const entered = deferred();
    const release = deferred();
    const window = h.identity.openWindow.bind(h.identity);
    h.identity.openWindow = async (...args) => {
      entered.resolve();
      await release.promise;
      await window(...args);
    };
    const block = h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: new Uint8Array(32),
      expiresAt: 150_000,
    });
    await entered.promise;
    const raw = Buffer.from(
      encodeEnvelope({
        v: 1,
        t: "e2e",
        from: phone.fp,
        to: h.agent.fp,
        seq: 9,
        body: { n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) },
      }),
    );
    const expected = new Uint8Array(raw);
    const send = h.core.message("phone", raw);
    raw.fill(0);
    release.resolve();
    await Promise.all([send, block]);
    expect(h.frames.get("agent")?.at(-1)).toEqual(expected);
  });
  it("allows revocation while provider delivery remains pending", async () => {
    const h = harness();
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const entered = deferred();
    const release = deferred();
    h.notifications.pump = async () => {
      entered.resolve();
      await release.promise;
    };
    const wake = h.core.wakeup();
    await entered.promise;
    await h.ctrl("agent", h.agent.fp, { type: "unpair", phoneFp: phone.fp });
    expect(await h.identity.pairing(phone.fp)).toBe(null);
    expect(h.closes.at(-1)).toMatchObject({ id: "phone", code: 4004 });
    release.resolve();
    await wake;
  });
  it("does not authorize an old authentication after a competing signed connection arrives", async () => {
    const h = harness();
    await h.core.open("old");
    await h.core.open("new");
    const entered = deferred();
    const release = deferred();
    const register = h.identity.registerComputer.bind(h.identity);
    h.identity.registerComputer = async (record) => {
      entered.resolve();
      await release.promise;
      await register(record);
    };
    const old = h.auth("old", h.agent, "agent");
    await entered.promise;
    const replacement = h.auth("new", h.agent, "agent");
    release.resolve();
    await Promise.all([old, replacement]);
    expect(h.bodies("old").some((b) => b.type === "auth-ok")).toBe(false);
    expect(h.sessions.get("new")?.state).toBe("agent");
    await h.core.close("old");
    expect(h.sessions.get("new")?.state).toBe("agent");
  });
  it("does not revive a connection closed during authentication", async () => {
    const h = harness();
    await h.core.open("old");
    const entered = deferred();
    const release = deferred();
    h.identity.registerComputer = async () => {
      entered.resolve();
      await release.promise;
    };
    const auth = h.auth("old", h.agent, "agent");
    await entered.promise;
    const close = h.core.close("old");
    release.resolve();
    await Promise.all([auth, close]);
    expect(h.bodies("old").some((b) => b.type === "auth-ok")).toBe(false);
  });
});
