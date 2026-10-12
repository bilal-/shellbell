import { sha256 } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import type { IceServerIssue } from "../src/index.js";
import { device, harness } from "../test-support/core-harness.js";

const issue: IceServerIssue = {
  iceServers: [
    {
      urls: ["turn:turn.example.test:3478?transport=udp"],
      username: "user",
      credential: "secret",
    },
  ],
  expiresInMs: 86_400_000,
};

describe("TURN servers for signed-in devices", () => {
  it("adds issued TURN servers to auth-ok for the computer and paired phones", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    for (const id of ["agent", "phone"])
      expect(h.bodies(id).find((body) => body.type === "auth-ok")).toMatchObject({
        iceServers: issue.iceServers,
        iceExpiresInMs: issue.expiresInMs,
      });
  });

  it("leaves auth-ok unchanged when the relay has no TURN provider", async () => {
    for (const extra of [{}]) {
      const h = harness(extra);
      await h.connect("agent");
      const ok = h.bodies("agent").find((body) => body.type === "auth-ok");
      expect(ok).toBeDefined();
      expect(ok).not.toHaveProperty("iceServers");
      expect(ok).not.toHaveProperty("iceExpiresInMs");
      expect(h.closes).toEqual([]);
    }
  });

  it("never gives TURN servers to a pairing socket", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await h.connect("agent");
    const gate = new Uint8Array(16).fill(4);
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: sha256(gate),
      expiresAt: 9_000_000,
    });
    const newPhone = device("New phone");
    await h.core.open("pair");
    await h.auth("pair", newPhone, "pairing", gate);
    const ok = h.bodies("pair").find((body) => body.type === "auth-ok");
    expect(ok).toMatchObject({ role: "pairing" });
    expect(ok).not.toHaveProperty("iceServers");
    expect(ok).not.toHaveProperty("iceExpiresInMs");
    await h.ctrl("pair", newPhone.fp, { type: "ice-refresh" });
    expect(h.bodies("pair").some((body) => body.type === "ice-servers")).toBe(false);
    expect(iceServers).toHaveBeenCalledTimes(1);
  });

  it("tells devices it can refresh even when issuing fails at sign-in", async () => {
    const iceServers = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(issue);
    const h = harness({ iceServers });
    await h.connect("agent");
    expect(h.bodies("agent").find((body) => body.type === "auth-ok")).toMatchObject({
      iceServers: [],
      iceExpiresInMs: 0,
    });
    await h.ctrl("agent", h.agent.fp, { type: "ice-refresh" });
    expect(h.bodies("agent").filter((body) => body.type === "ice-servers")).toEqual([
      { type: "ice-servers", iceServers: issue.iceServers, iceExpiresInMs: issue.expiresInMs },
    ]);
  });

  it("answers ice-refresh with fresh servers, at most once per ten minutes per socket", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    const replies = (id: string) => h.bodies(id).filter((body) => body.type === "ice-servers");
    await h.ctrl("phone", phone.fp, { type: "ice-refresh" });
    await h.ctrl("phone", phone.fp, { type: "ice-refresh" });
    expect(replies("phone")).toEqual([
      { type: "ice-servers", iceServers: issue.iceServers, iceExpiresInMs: issue.expiresInMs },
    ]);
    await h.ctrl("agent", h.agent.fp, { type: "ice-refresh" });
    expect(replies("agent")).toHaveLength(1);
    h.setNow(100_000 + 10 * 60_000);
    await h.ctrl("phone", phone.fp, { type: "ice-refresh" });
    expect(replies("phone")).toHaveLength(2);
    expect(h.closes).toEqual([]);
  });

  it("ignores ice-refresh without dropping the socket when no servers are available", async () => {
    const h = harness({ iceServers: async () => null });
    await h.connect("agent");
    await h.ctrl("agent", h.agent.fp, { type: "ice-refresh" });
    expect(h.bodies("agent").some((body) => body.type === "ice-servers")).toBe(false);
    expect(h.closes).toEqual([]);
  });
});
