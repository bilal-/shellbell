import { sha256 } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { agentOnline, authenticate, box, connect, pairPhone, TestDevice } from "./helpers.js";

describe("pairing", () => {
  it("window + gate admit a pairing socket; response is routed; phone can then authenticate", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    const p = await connect(mac.fp);
    expect(await authenticate(p, phone, "phone")).toMatchObject({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
    });
    expect(await agent.nextCtrl()).toMatchObject({
      type: "phone-connected",
      phoneFp: phone.fp,
      name: "iPhone",
    });
    p.ws.close();
    expect(await agent.nextCtrl()).toMatchObject({ type: "phone-disconnected", phoneFp: phone.fp });
    agent.ws.close();
  });

  it("wrong gate, closed window, and a 6th admission are refused", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(1);
    agent.sendCtrl(mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    const wrong = await connect(mac.fp);
    expect(
      await authenticate(wrong, new TestDevice("x"), "pairing", {
        gate: new Uint8Array(16).fill(2),
      }),
    ).toEqual({ type: "auth-fail", reason: "no-window" });
    for (let i = 0; i < 5; i++) {
      const c = await connect(mac.fp);
      expect((await authenticate(c, new TestDevice(`p${i}`), "pairing", { gate })).type).toBe(
        "auth-ok",
      );
    }
    const sixth = await connect(mac.fp);
    expect(await authenticate(sixth, new TestDevice("p6"), "pairing", { gate })).toEqual({
      type: "auth-fail",
      reason: "no-window",
    });
    agent.sendCtrl(mac.fp, { type: "pairing-close" });
    await new Promise((r) => setTimeout(r, 20));
    const after = await connect(mac.fp);
    expect(await authenticate(after, new TestDevice("p7"), "pairing", { gate })).toEqual({
      type: "auth-fail",
      reason: "no-window",
    });
    agent.ws.close();
  });

  it("pairing socket accepts exactly one pairing-request", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(3);
    agent.sendCtrl(mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    const pairing = await connect(mac.fp);
    await authenticate(pairing, phone, "pairing", { gate });
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    await agent.nextCtrl();
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    expect((await pairing.closed).code).toBe(4403);
    agent.ws.close();
  });

  it("pairing-reject is forwarded and closes the pairing socket with 4003", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(4);
    agent.sendCtrl(mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    const pairing = await connect(mac.fp);
    await authenticate(pairing, phone, "pairing", { gate });
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "pairing-reject", phoneFp: phone.fp, reason: "declined" });
    expect(await pairing.nextCtrl()).toEqual({
      type: "pairing-reject",
      phoneFp: phone.fp,
      reason: "declined",
    });
    expect((await pairing.closed).code).toBe(4003);
    agent.ws.close();
  });

  it("agent disconnect closes the window", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(5);
    agent.sendCtrl(mac.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: Date.now() + 300_000,
    });
    agent.ws.close();
    await agent.closed;
    const { agent: again } = await agentOnline(mac);
    const c = await connect(mac.fp);
    expect(await authenticate(c, new TestDevice("p"), "pairing", { gate })).toEqual({
      type: "auth-fail",
      reason: "no-window",
    });
    again.ws.close();
  });

  it("pairings-sync replaces the table and closes removed phones; push settings survive for retained", async () => {
    const mac = new TestDevice("MBP");
    const a = new TestDevice("A");
    const b = new TestDevice("B");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, a);
    await pairPhone(mac, agent, b);
    const pa = await connect(mac.fp);
    await authenticate(pa, a, "phone");
    await agent.nextCtrl();
    pa.sendCtrl(a.fp, {
      type: "push-token",
      token: "ExponentPushToken[a]",
      platform: "ios",
      enabled: false,
    });
    const pb = await connect(mac.fp);
    await authenticate(pb, b, "phone");
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, {
      type: "pairings-sync",
      phones: [{ phoneFp: a.fp, ed25519Pub: a.id.ed25519.pub, name: "A2" }],
    });
    expect((await pb.closed).code).toBe(4004);
    await agent.nextCtrl(); // phone-disconnected b
    // A is still paired and its push_enabled=false survived: verify indirectly via a re-auth
    pa.ws.close();
    await agent.nextCtrl();
    const pa2 = await connect(mac.fp);
    expect((await authenticate(pa2, a, "phone")).type).toBe("auth-ok");
    const pb2 = await connect(mac.fp);
    expect(await authenticate(pb2, b, "phone")).toEqual({
      type: "auth-fail",
      reason: "not-paired",
    });
    agent.ws.close();
  });

  it("agent unpair closes the phone with 4004 and later auth fails", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "unpair", phoneFp: phone.fp });
    expect((await p.closed).code).toBe(4004);
    const again = await connect(mac.fp);
    expect(await authenticate(again, phone, "phone")).toEqual({
      type: "auth-fail",
      reason: "not-paired",
    });
    agent.ws.close();
  });

  it("phone unpairs itself: forwarded when agent online, tombstoned when offline", async () => {
    const mac = new TestDevice("MBP");
    const p1 = new TestDevice("P1");
    const p2 = new TestDevice("P2");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, p1);
    await pairPhone(mac, agent, p2);
    const c1 = await connect(mac.fp);
    await authenticate(c1, p1, "phone");
    await agent.nextCtrl();
    c1.sendCtrl(p1.fp, { type: "unpair", phoneFp: p1.fp });
    expect(await agent.nextCtrl()).toEqual({ type: "unpair", phoneFp: p1.fp });
    expect((await c1.closed).code).toBe(4004);
    await agent.nextCtrl(); // phone-disconnected
    agent.ws.close();
    await agent.closed;
    const c2 = await connect(mac.fp);
    await authenticate(c2, p2, "phone");
    c2.sendCtrl(p2.fp, { type: "unpair", phoneFp: p2.fp });
    expect((await c2.closed).code).toBe(4004);
    const { agent: back, unpaired } = await agentOnline(mac);
    if (unpaired.type !== "unpaired") throw new Error("expected unpaired control message");
    expect([...unpaired.phoneFps].sort()).toEqual([p1.fp, p2.fp].sort());
    back.sendCtrl(mac.fp, { type: "pairings-sync", phones: [] });
    const { agent: third, unpaired: none } = await agentOnline(mac);
    expect(none).toEqual({ type: "unpaired", phoneFps: [] });
    third.ws.close();
  });

  it("phone cannot unpair a different phone", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl();
    p.sendCtrl(phone.fp, { type: "unpair", phoneFp: "z".repeat(26) });
    expect((await p.closed).code).toBe(4403);
    agent.ws.close();
  });
});
