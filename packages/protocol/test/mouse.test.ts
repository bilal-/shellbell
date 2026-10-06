import { describe, expect, it } from "vitest";
import { CapabilitiesSchema, InnerMessageSchema } from "../src/inner.js";

const click = {
  type: "input.mouse",
  reqId: "mouse1",
  sessionId: "herdr:term1",
  column: 1,
  row: 2,
  cols: 80,
  rows: 24,
  button: "left",
  modifiers: 0,
};
describe("optional terminal mouse input", () => {
  it("accepts a bounded atomic click", () =>
    expect(InnerMessageSchema.parse(click)).toEqual(click));
  it.each([
    { column: -1 },
    { column: 512 },
    { row: 256 },
    { column: 1.5 },
    { rows: 257 },
    { cols: 513 },
    { button: "drag" },
    { modifiers: 8 },
    { column: 80 },
    { row: 24 },
  ])("rejects invalid input %o", (change) =>
    expect(InnerMessageSchema.safeParse({ ...click, ...change }).success).toBe(false),
  );
  it("preserves legacy capabilities without advertising mouse", () => {
    const legacy = {
      subscribe: true,
      prompts: false,
      createSession: true,
      focus: true,
      history: true,
      absoluteLines: false,
    };
    expect(CapabilitiesSchema.parse(legacy)).toEqual(legacy);
    expect(CapabilitiesSchema.parse({ ...legacy, mouseClick: true }).mouseClick).toBe(true);
  });
});
