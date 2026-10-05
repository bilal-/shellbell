import { describe, expect, it } from "vitest";
import { bytesForKey, NAMED_KEYS, type NamedKey, NamedKeySchema } from "../src/keys.js";

describe("named keys", () => {
  it("has the documented mappings", () => {
    expect(bytesForKey("enter")).toBe("\r");
    expect(bytesForKey("esc")).toBe("\x1b");
    expect(bytesForKey("ctrl-c")).toBe("\x03");
    expect(bytesForKey("ctrl-z")).toBe("\x1a");
    expect(bytesForKey("up")).toBe("\x1b[A");
    expect(bytesForKey("shift-tab")).toBe("\x1b[Z");
    expect(bytesForKey("delete")).toBe("\x1b[3~");
    expect(bytesForKey("f1")).toBe("\x1bOP");
    expect(bytesForKey("f12")).toBe("\x1b[24~");
    expect(bytesForKey("ctrl-space")).toBe("\x00");
    // compile-time assertion that ctrl-* keys are in NamedKey type
    const k: NamedKey = "ctrl-c";
    expect(bytesForKey(k)).toBe("\x03");
  });
  it("every key maps to a non-empty string and the schema matches the table", () => {
    for (const k of NamedKeySchema.options) expect(NAMED_KEYS[k].length).toBeGreaterThan(0);
    expect(Object.keys(NAMED_KEYS).sort()).toEqual([...NamedKeySchema.options].sort());
  });
});
