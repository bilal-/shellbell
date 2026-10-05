import { FRAME_LIMITS } from "@shellbell/protocol";
import { frameLimitFor, TokenBucket } from "@shellbell/relay-core";
import { describe, expect, it } from "vitest";

describe("limits", () => {
  it("frame limits by state", () => {
    expect(frameLimitFor("unauth", true)).toBe(FRAME_LIMITS.unauth);
    expect(frameLimitFor("phone", true)).toBe(FRAME_LIMITS.ctrl);
    expect(frameLimitFor("phone", false)).toBe(FRAME_LIMITS.e2eFromPhone);
    expect(frameLimitFor("agent", false)).toBe(FRAME_LIMITS.e2eFromAgent);
    expect(frameLimitFor("pairing", false)).toBe(FRAME_LIMITS.ctrl);
  });
  it("token bucket allows burst then refills at rate", () => {
    const b = new TokenBucket(60, 200);
    let allowed = 0;
    for (let i = 0; i < 250; i++) if (b.take(0)) allowed++;
    expect(allowed).toBe(200);
    expect(b.take(0)).toBe(false);
    expect(b.take(1000)).toBe(true); // +60 after 1 s
    let more = 0;
    for (let i = 0; i < 100; i++) if (b.take(1000)) more++;
    expect(more).toBe(59);
  });
});
