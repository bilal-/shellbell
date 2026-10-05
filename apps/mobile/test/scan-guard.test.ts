import { describe, expect, it } from "vitest";
import { ScanGuard } from "../src/net/scan-guard";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ScanGuard", () => {
  it("handles a fresh payload", () => {
    const g = new ScanGuard();
    expect(g.canHandle("qr-1")).toBe(true);
  });

  it("rejects any scan while an attempt is in flight (busy), same or different payload", () => {
    const g = new ScanGuard();
    g.begin("qr-1");
    expect(g.canHandle("qr-1")).toBe(false);
    expect(g.canHandle("qr-2")).toBe(false);
  });

  it("after success, ignores every scan during the cooldown window", () => {
    const c = clock();
    const g = new ScanGuard({ cooldownMs: 2000, now: c.now });
    g.begin("qr-1");
    g.end("success");
    expect(g.canHandle("qr-1")).toBe(false);
    expect(g.canHandle("qr-2")).toBe(false);
    c.advance(1999);
    expect(g.canHandle("qr-2")).toBe(false);
    c.advance(1);
    expect(g.canHandle("qr-2")).toBe(true);
  });

  it("after success, the cooldown expiring still does not re-admit the exact same payload", () => {
    const c = clock();
    const g = new ScanGuard({ cooldownMs: 2000, now: c.now });
    g.begin("qr-1");
    g.end("success");
    c.advance(2000);
    expect(g.canHandle("qr-1")).toBe(false); // same payload still ignored
    expect(g.canHandle("qr-2")).toBe(true); // a distinct payload is fine
  });

  it("after cancelled, needsRescanTap is true and no scan is admitted even once the cooldown elapses", () => {
    const c = clock();
    const g = new ScanGuard({ cooldownMs: 2000, now: c.now });
    g.begin("qr-1");
    g.end("cancelled");
    expect(g.needsRescanTap).toBe(true);
    c.advance(10_000);
    expect(g.canHandle("qr-1")).toBe(false);
    expect(g.canHandle("qr-2")).toBe(false); // even an unrelated fresh code is blocked
  });

  it("after error, same block-until-explicit-rearm behaviour as cancelled", () => {
    const c = clock();
    const g = new ScanGuard({ cooldownMs: 2000, now: c.now });
    g.begin("qr-1");
    g.end("error");
    expect(g.needsRescanTap).toBe(true);
    c.advance(60_000);
    expect(g.canHandle("qr-2")).toBe(false);
  });

  it("rearm() clears the block, the cooldown, and the payload dedupe", () => {
    const c = clock();
    const g = new ScanGuard({ cooldownMs: 2000, now: c.now });
    g.begin("qr-1");
    g.end("error");
    expect(g.canHandle("qr-1")).toBe(false);
    g.rearm();
    expect(g.needsRescanTap).toBe(false);
    expect(g.canHandle("qr-1")).toBe(true); // even the same code can be retried on purpose
  });

  it("rearm() is safe to call even when nothing is blocked", () => {
    const g = new ScanGuard();
    expect(() => g.rearm()).not.toThrow();
    expect(g.needsRescanTap).toBe(false);
    expect(g.canHandle("qr-1")).toBe(true);
  });

  it("never auto-retries: a full cancelled attempt requires an explicit rearm before any scan", () => {
    const c = clock();
    const g = new ScanGuard({ cooldownMs: 2000, now: c.now });
    for (let i = 0; i < 5; i++) {
      // The camera keeps re-firing the same payload every frame; none of these should be handled.
      expect(g.canHandle("qr-1")).toBe(i === 0);
      if (i === 0) {
        g.begin("qr-1");
        g.end("cancelled");
      }
    }
  });
});
