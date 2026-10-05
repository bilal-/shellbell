import { describe, expect, it } from "vitest";
import { parseInner } from "../src/inner.js";
import { encodeV2Bootstrap } from "../src/session-v2-signaling.js";

describe("paired v1 carrier for v2 bootstrap", () => {
  it("carries bounded opaque bootstrap bytes without interpreting their state", () => {
    const bytes = encodeV2Bootstrap({
      type: "session.v2.begin",
      sessionId: new Uint8Array(16).fill(1),
      generation: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0),
    });
    expect(parseInner({ type: "session.v2.bootstrap", bytes })).toEqual({
      type: "session.v2.bootstrap",
      bytes,
    });
    expect(() =>
      parseInner({ type: "session.v2.bootstrap", bytes: new Uint8Array(1025) }),
    ).toThrow();
    expect(() => parseInner({ type: "session.v2.bootstrap", bytes: new Uint8Array() })).toThrow();
  });
});
