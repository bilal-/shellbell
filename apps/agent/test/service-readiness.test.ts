import { describe, expect, it, vi } from "vitest";
import type { LocalStatus } from "../src/local-status.js";
import { matchesLocalService, ServiceReadiness } from "../src/service-readiness.js";

const local: LocalStatus = {
  controlVersion: 1,
  process: {
    pid: 123,
    agentVersion: "test",
    computerFp: "a".repeat(26),
    stateDir: "/state",
    serviceInstance: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  backends: [
    { name: "iterm2", connected: false },
    { name: "tmux", connected: false },
    { name: "herdr", connected: false },
  ],
  terminalReady: false,
  relayOnline: false,
  sessions: 0,
  phones: [],
  connected: [],
};
const expected = {
  computerFp: "a".repeat(26),
  stateDir: "/state",
  serviceInstance: local.process.serviceInstance,
  pid: 123,
};
describe("bounded local service readiness", () => {
  it("treats an unresolvable response state path as foreign without echoing payload data", async () => {
    const readiness = new ServiceReadiness({
      probe: async () => ({
        ...local,
        process: { ...local.process, stateDir: "/PRIVATE_SENTINEL\u0000" },
      }),
    });
    const observed = await readiness.observe("/owned.sock", expected);
    expect(observed.kind).toBe("foreign");
    expect(observed.diagnostic).not.toContain("PRIVATE_SENTINEL");
  });
  it("matches canonical paths and distinguishes omitted constraints from explicit null", () => {
    expect(
      matchesLocalService(local, { computerFp: expected.computerFp, stateDir: "/state/./" }),
    ).toBe(true);
    expect(matchesLocalService(local, { ...expected, serviceInstance: null })).toBe(false);
  });
  it.each([
    { pid: 456 },
    { computerFp: "b".repeat(26) },
    { stateDir: "/other" },
    { serviceInstance: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ])("rejects a mismatched process %j", (change) => {
    expect(matchesLocalService(local, { ...expected, ...change })).toBe(false);
  });
  it("accepts local readiness with offline relay and no backend", async () => {
    const readiness = new ServiceReadiness({ probe: async () => local });
    expect(await readiness.waitReady("/owned.sock", expected)).toEqual(local);
  });
  it("ends at the monotonic deadline and caps each request by remaining time", async () => {
    let now = 0;
    const timeouts: number[] = [];
    const readiness = new ServiceReadiness({
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      probe: async (_path, timeout) => {
        timeouts.push(timeout);
        now += timeout;
        throw new Error("PRIVATE_SENTINEL");
      },
    });
    await expect(readiness.waitReady("/owned.sock", expected)).rejects.toThrow(/readiness/);
    expect(now).toBe(10_000);
    expect(timeouts.every((timeout) => timeout > 0 && timeout <= 500)).toBe(true);
    expect(timeouts.at(-1)).toBe(400);
  });
  it.each([{ controlVersion: 0, secret: "PRIVATE_SENTINEL" }, { secret: "PRIVATE_SENTINEL" }])(
    "rejects unsupported or malformed responses without payload diagnostics",
    async (response) => {
      const readiness = new ServiceReadiness({ probe: async () => response });
      const result = await readiness.observe("/owned.sock", expected);
      expect(result.kind).toBe("unverified");
      expect(result.diagnostic).not.toContain("PRIVATE_SENTINEL");
    },
  );
  it("only confirms a stopped endpoint from connection absence", async () => {
    let now = 0;
    const probe = vi
      .fn()
      .mockResolvedValueOnce(local)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ECONNREFUSED" }));
    const readiness = new ServiceReadiness({
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      probe,
    });
    await readiness.waitStopped("/owned.sock");
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
