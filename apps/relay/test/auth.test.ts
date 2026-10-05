import { describe, expect, it } from "vitest";
import { agentOnline, authenticate, connect, TestDevice } from "./helpers.js";

describe("auth handshake", () => {
  it("agent authenticates against its own DO and gets unpaired + phones", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    const ok = await authenticate(c, mac, "agent");
    expect(ok).toMatchObject({
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: "MBP",
      minFrameMs: 125,
      features: ["notify-context-v1"],
    });
    expect(await c.nextCtrl()).toEqual({ type: "unpaired", phoneFps: [] });
    expect(await c.nextCtrl()).toEqual({ type: "phones", connected: [] });
    c.ws.close();
  });

  it("agent with a fingerprint that does not match the DO name is rejected", async () => {
    const mac = new TestDevice("MBP");
    const other = new TestDevice("Other");
    const c = await connect(mac.fp);
    expect(await authenticate(c, other, "agent")).toEqual({
      type: "auth-fail",
      reason: "fp-mismatch",
    });
    expect((await c.closed).code).toBe(4001);
  });

  it("unpaired phone is rejected with not-paired", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const c = await connect(mac.fp);
    expect(await authenticate(c, phone, "phone")).toEqual({
      type: "auth-fail",
      reason: "not-paired",
    });
    expect((await c.closed).code).toBe(4001);
  });

  it("bad signature is rejected", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    const ch = await c.nextCtrl();
    if (ch.type !== "challenge") throw new Error("no challenge");
    c.sendCtrl(mac.fp, {
      type: "auth",
      role: "agent",
      fp: mac.fp,
      ed25519Pub: mac.id.ed25519.pub,
      sig: new Uint8Array(64),
      name: "x",
      appVersion: "t",
    });
    expect(await c.nextCtrl()).toEqual({ type: "auth-fail", reason: "bad-sig" });
    expect((await c.closed).code).toBe(4001);
  });

  it("pairing role needs an open window (no agent → no-agent; agent without window → no-window)", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const c1 = await connect(mac.fp);
    expect(await authenticate(c1, phone, "pairing", { gate: new Uint8Array(16) })).toEqual({
      type: "auth-fail",
      reason: "no-agent",
    });
    const { agent } = await agentOnline(mac);
    const c2 = await connect(mac.fp);
    expect(await authenticate(c2, phone, "pairing", { gate: new Uint8Array(16) })).toEqual({
      type: "auth-fail",
      reason: "no-window",
    });
    agent.ws.close();
  });

  it("malformed frame closes with 4400; e2e before auth closes with 4403", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    c.sendRaw(new Uint8Array([0xff, 0x00, 0x01]));
    expect((await c.closed).code).toBe(4400);
    const d = await connect(mac.fp);
    await d.nextCtrl();
    d.sendEnvelope({
      v: 1,
      t: "e2e",
      from: mac.fp,
      to: mac.fp,
      seq: 1,
      body: { n: new Uint8Array(24), c: new Uint8Array(1) },
    });
    expect((await d.closed).code).toBe(4403);
  });

  it("second agent supersedes the first with 4005", async () => {
    const mac = new TestDevice("MBP");
    const { agent: a } = await agentOnline(mac);
    const { agent: b } = await agentOnline(mac);
    expect((await a.closed).code).toBe(4005);
    b.ws.close();
  });
});
