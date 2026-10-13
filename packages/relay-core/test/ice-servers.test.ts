import { sha256 } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { type IceServerIssue, TURN_ISSUE_TIMEOUT_MS } from "../src/index.js";
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

describe("TURN issuance during a superseding sign-in", () => {
  it("still answers a sign-in whose TURN request outlives a newer socket that closed", async () => {
    let release!: (issue: IceServerIssue) => void;
    const held = new Promise<IceServerIssue>((resolve) => {
      release = resolve;
    });
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await h.connect("agent");
    const phone = await h.pair();
    iceServers.mockImplementationOnce(() => held);
    await h.core.open("a");
    await h.core.open("b");
    const first = h.auth("a", phone, "phone");
    await vi.waitFor(() => expect(iceServers).toHaveBeenCalledTimes(2));
    const second = h.auth("b", phone, "phone");
    const closed = h.core.close("b");
    release(issue);
    await Promise.all([first, second, closed]);
    // A socket signed in without auth-ok escapes the sign-in timeout and stalls its device.
    // The superseded attempt may stay unauthenticated, where that timeout still applies.
    const answered = h.bodies("a").some((body) => body.type === "auth-ok");
    const state = h.sessions.get("a")?.state;
    expect(answered || state === undefined || state === "unauth").toBe(true);
  });
});

describe("a TURN provider that never answers", () => {
  it("still answers sign-in once the TURN wait runs out", async () => {
    vi.useFakeTimers();
    try {
      const iceServers = vi.fn(() => new Promise<IceServerIssue>(() => {}));
      const h = harness({ iceServers });
      const signedIn = h.connect("agent");
      await vi.advanceTimersByTimeAsync(TURN_ISSUE_TIMEOUT_MS);
      await signedIn;
      // Without servers to give, the relay still advertises TURN so the device refreshes later.
      expect(h.bodies("agent").find((body) => body.type === "auth-ok")).toMatchObject({
        iceServers: [],
        iceExpiresInMs: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a computer that turned TURN off", () => {
  const turnOff = (h: ReturnType<typeof harness>, id = "agent") =>
    h.core.open(id).then(() => h.auth(id, h.agent, "agent", undefined, { turn: false }));

  it("is told the relay withholds TURN, and gets no servers itself", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await turnOff(h);
    expect(h.bodies("agent").find((body) => body.type === "auth-ok")).toMatchObject({
      turnOff: true,
      iceServers: [],
      iceExpiresInMs: 0,
    });
    expect(iceServers).not.toHaveBeenCalled();
  });

  it("leaves its phones without TURN servers while it is signed in", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await turnOff(h);
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    expect(h.bodies("phone").find((body) => body.type === "auth-ok")).toMatchObject({
      iceServers: [],
      iceExpiresInMs: 0,
    });
    expect(h.bodies("phone").find((body) => body.type === "auth-ok")).not.toHaveProperty("turnOff");
    await h.ctrl("phone", phone.fp, { type: "ice-refresh" });
    expect(h.bodies("phone").filter((body) => body.type === "ice-servers")).toEqual([
      { type: "ice-servers", iceServers: [], iceExpiresInMs: 0 },
    ]);
    expect(iceServers).not.toHaveBeenCalled();
  });

  it("clears TURN servers a phone received while it was away, before announcing itself", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await h.connect("agent");
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    expect(h.bodies("phone").find((body) => body.type === "auth-ok")).toMatchObject({
      iceServers: issue.iceServers,
    });
    await h.core.close("agent");
    await turnOff(h, "agent-2");
    const after = h
      .bodies("phone")
      .slice(h.bodies("phone").findIndex((b) => b.type === "auth-ok") + 1);
    const cleared = after.findIndex(
      (body) => body.type === "ice-servers" && body.iceServers.length === 0,
    );
    const announced = after.findIndex(
      (body) => body.type === "presence" && body.agentOnline === true,
    );
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(announced).toBeGreaterThan(cleared);
  });

  it("gives phones TURN again once the computer signs in with TURN on", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await turnOff(h);
    const phone = await h.pair();
    await h.core.close("agent");
    await h.connect("agent-2");
    await h.connect("phone", phone, "phone");
    expect(h.bodies("phone").find((body) => body.type === "auth-ok")).toMatchObject({
      iceServers: issue.iceServers,
    });
  });

  it("gives phones already signed in TURN again, before announcing a computer that turned it on", async () => {
    const iceServers = vi.fn(async () => issue);
    const h = harness({ iceServers });
    await turnOff(h);
    const phone = await h.pair();
    await h.connect("phone", phone, "phone");
    await h.core.close("agent");
    const before = h.bodies("phone").length;
    await h.connect("agent-2");
    const after = h.bodies("phone").slice(before);
    const restored = after.findIndex(
      (body) => body.type === "ice-servers" && body.iceServers.length > 0,
    );
    const announced = after.findIndex(
      (body) => body.type === "presence" && body.agentOnline === true,
    );
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(announced).toBeGreaterThan(restored);
  });
});
