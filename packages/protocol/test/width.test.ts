import { describe, expect, it } from "vitest";
import { cellWidth, stringCells } from "../src/width.js";

describe("cell widths", () => {
  it("ascii is 1", () => {
    expect(cellWidth("a".codePointAt(0) as number)).toBe(1);
    expect(stringCells("hello")).toBe(5);
  });
  it("CJK and fullwidth are 2", () => {
    expect(stringCells("漢字")).toBe(4);
    expect(stringCells("Ａ")).toBe(2);
    expect(stringCells("한")).toBe(2);
  });
  it("emoji presentation is 2", () => {
    expect(stringCells("🚀")).toBe(2);
    expect(stringCells("✅")).toBe(2);
  });
  it("combining marks and variation selectors are 0", () => {
    expect(stringCells("e\u0301")).toBe(1);
    expect(stringCells("\uFE0F")).toBe(0);
    expect(stringCells("\u200B")).toBe(0);
  });
  it("ZWJ sequence counts the widest element once", () => {
    expect(stringCells("👨\u200D💻")).toBe(2);
  });
  it("box drawing and nerd font private-use glyphs are 1", () => {
    expect(stringCells("├──")).toBe(3);
    expect(stringCells("")).toBe(1);
  });
});
