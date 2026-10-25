// Pairing wire behavior is tested alongside the scripted socket in pairing.test.ts.
import { describe, expect, it } from "vitest";
import { isCustomRelay, relayTrustMessage } from "../src/util/relay-trust";

describe("relay trust", () => {
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
