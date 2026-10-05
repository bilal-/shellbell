import type { Envelope } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

async function setup() {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl(); // phone-connected
  return { mac, phone, agent, p };
}

const e2e = (from: string, to: string, seq: number, c: number[]): Envelope => ({
  v: 1,
  t: "e2e",
  from,
  to,
  seq,
  body: { n: new Uint8Array(24), c: new Uint8Array(c) },
});

describe("e2e routing", () => {
  it("phone → agent and agent → phone, bytes preserved", async () => {
    const { mac, phone, agent, p } = await setup();
    p.sendEnvelope(e2e(phone.fp, mac.fp, 1, [7, 8, 9]));
    const got = await agent.next();
    expect(got.t).toBe("e2e");
    expect(got.from).toBe(phone.fp);
    expect((got.body as { c: Uint8Array }).c).toEqual(new Uint8Array([7, 8, 9]));
    agent.sendEnvelope(e2e(mac.fp, phone.fp, 1, [1]));
    const back = await p.next();
    expect(back.from).toBe(mac.fp);
    expect((back.body as { c: Uint8Array }).c).toEqual(new Uint8Array([1]));
    agent.ws.close();
    p.ws.close();
  });

  it("rejects a spoofed from", async () => {
    const { mac, agent, p } = await setup();
    p.sendEnvelope(e2e("q".repeat(26), mac.fp, 1, [1]));
    expect((await p.closed).code).toBe(4403);
    agent.ws.close();
  });

  it("drops frames to a disconnected peer silently", async () => {
    const { mac, phone, agent, p } = await setup();
    agent.ws.close();
    await agent.closed;
    expect(await p.nextCtrl()).toMatchObject({ type: "presence", agentOnline: false });
    p.sendEnvelope(e2e(phone.fp, mac.fp, 1, [1]));
    await expect(p.next(300)).rejects.toThrow(/timeout/);
    p.ws.close();
  });

  it("a second socket for the same phone supersedes the first (4005) and the agent learns both events", async () => {
    const { mac, phone, agent, p } = await setup();
    const p2 = await connect(mac.fp);
    await authenticate(p2, phone, "phone");
    expect((await p.closed).code).toBe(4005);
    const m1 = await agent.nextCtrl();
    const m2 = await agent.nextCtrl();
    expect([m1.type, m2.type].sort()).toEqual(["phone-connected", "phone-disconnected"]);
    agent.sendEnvelope(e2e(mac.fp, phone.fp, 1, [5]));
    expect(((await p2.next()).body as { c: Uint8Array }).c).toEqual(new Uint8Array([5]));
    agent.ws.close();
    p2.ws.close();
  });
});
