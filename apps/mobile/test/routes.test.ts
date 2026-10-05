import { describe, expect, it } from "vitest";
import { sidFromRoute, sidToRoute } from "../src/util/routes.js";

describe("routes", () => {
  it("round-trips ids with % and :", () => {
    for (const id of ["tmux:%3", "iterm2:5A7B-1234", "tmux:$0", "herdr:term_abc"]) {
      expect(sidToRoute(id)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sidFromRoute(sidToRoute(id))).toBe(id);
    }
  });
});
