import { describe, expect, it } from "vitest";
import { agentOnline, connect, TestDevice } from "./helpers.js";

/**
 * Bounds a promise to `timeoutMs` instead of letting it hang until the
 * suite's own timeout, so a stuck condition fails fast with a clear message.
 */
function bounded<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

describe("abuse controls", () => {
  it("oversized frame before auth closes with 4413", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    c.sendRaw(new Uint8Array(4097));
    expect((await c.closed).code).toBe(4413);
  });

  it("flooding ctrl frames trips the token bucket with 4429", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    // The bucket (src/limits.ts) starts with a 200-token burst and refills
    // at 60/s. A slow CI runner can take over a second to push a tight loop
    // of frames through, letting the bucket refill as it drains — so send
    // well past the burst (400, not 260) to still exhaust it even then.
    for (let i = 0; i < 400; i++) {
      agent.sendCtrl(mac.fp, { type: "pairing-close" });
    }
    const closed = await bounded(agent.closed, 15_000, "flood: waiting for close");
    expect(closed.code).toBe(4429);
  }, 20_000);

  // Inherently slow: it waits out the DO's real `UNAUTH_TIMEOUT_MS` (10 s), so it runs in ~10.01 s
  // and the old 20 s budget left only 10 s of slack. Under a loaded machine the whole relay suite
  // stretches badly (measured at 968 s for one run), the alarm slips past the budget and this fails
  // as `Test timed out in 20000ms` — seen once in 11 unloaded runs and again under load
  // (2026-09-15). The assertion is that the sweep fires at all, not that it fires promptly, so the
  // budget is deliberately generous; do not trim it back towards 10 s.
  it("unauthenticated socket is closed by the alarm sweep with 4408", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    expect((await c.closed).code).toBe(4408);
  }, 60_000);
});
