import { describe, expect, it } from "vitest";
import { parseRelaySetting } from "../src/util/relay-url";

describe("phone relay settings", () => {
  it("normalizes a secure relay origin and permits an explicit LAN-test origin", () => {
    expect(parseRelaySetting(" wss://relay.example.com/ ", false)).toBe("wss://relay.example.com");
    expect(parseRelaySetting("ws://192.0.2.1:8787", true)).toBe("ws://192.0.2.1:8787");
  });
  it.each([
    "https://relay.example.com",
    "ws://relay.example.com",
    "wss://user:secret@relay.example.com",
    "wss://relay.example.com/ws",
    "wss://relay.example.com?token=secret",
    "wss://relay.example.com#fragment",
  ])("rejects invalid or unsafe origin %s", (url) => {
    expect(() => parseRelaySetting(url, false)).toThrow();
  });
});
