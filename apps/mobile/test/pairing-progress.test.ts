// Pairing wire behavior is tested alongside the scripted socket in pairing.test.ts.
import { describe, expect, it } from "vitest";
import { isCustomRelay, relayTrustMessage } from "../src/util/relay-trust";
import { scanHighlight } from "../src/util/scan-highlight";

describe("pairing capture and relay trust", () => {
  it("highlights the detected code with padding, clipped to the preview", () => {
    expect(
      scanHighlight(
        { origin: { x: 20, y: 30 }, size: { width: 80, height: 90 } },
        { width: 200, height: 200 },
      ),
    ).toEqual({ left: 12, top: 22, width: 96, height: 106 });
    expect(
      scanHighlight(
        { origin: { x: -5, y: 95 }, size: { width: 30, height: 20 } },
        { width: 100, height: 100 },
      ),
    ).toEqual({ left: 0, top: 87, width: 33, height: 13 });
  });
  it("uses the viewfinder when native bounds are missing, empty, or outside the preview", () => {
    for (const bounds of [
      undefined,
      { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      { origin: { x: Number.NaN, y: 0 }, size: { width: 20, height: 20 } },
      { origin: { x: 200, y: 0 }, size: { width: 20, height: 20 } },
    ])
      expect(scanHighlight(bounds, { width: 100, height: 100 })).toBeNull();
  });
  it("distinguishes the project relay from custom or similarly named endpoints", () => {
    expect(isCustomRelay(" wss://RELAY.shellbell.dev:443/ ")).toBe(false);
    for (const url of [
      "wss://relay.shellbell.dev.example.com",
      "wss://relay.shellbell.dev:444",
      "ws://relay.shellbell.dev",
    ])
      expect(isCustomRelay(url)).toBe(true);
    expect(relayTrustMessage("ws://192.0.2.1:8787")).toContain("unencrypted");
    expect(() => isCustomRelay("wss://relay.shellbell.dev@evil.test/path")).toThrow();
  });
});
