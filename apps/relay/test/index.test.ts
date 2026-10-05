import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker routes", () => {
  it("serves info and health", async () => {
    const info = await SELF.fetch("https://relay.test/");
    expect(info.status).toBe(200);
    expect(((await info.json()) as { name: string }).name).toBe("shellbell-relay");
    expect((await SELF.fetch("https://relay.test/healthz")).status).toBe(200);
  });
  it("validates the fingerprint and requires upgrade", async () => {
    expect((await SELF.fetch("https://relay.test/ws/short")).status).toBe(400);
    expect((await SELF.fetch(`https://relay.test/ws/${"a".repeat(26)}`)).status).toBe(426);
    expect((await SELF.fetch("https://relay.test/nope")).status).toBe(404);
  });
});
