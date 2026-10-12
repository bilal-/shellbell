import { describe, expect, it, vi } from "vitest";
import type { IceServerIssue } from "../src/index.js";
import { harness } from "../test-support/core-harness.js";

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

  it("leaves auth-ok unchanged when the relay has no TURN provider or it fails", async () => {
    for (const extra of [
      {},
      { iceServers: async () => null },
      {
        iceServers: async () => {
          throw new Error("down");
        },
      },
    ]) {
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
    await h.ctrl("agent", h.agent.fp, {
      type: "pairing-open",
      gateHash: new Uint8Array(32),
      expiresAt: 150_000,
    });
    expect(iceServers).toHaveBeenCalledTimes(1);
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
