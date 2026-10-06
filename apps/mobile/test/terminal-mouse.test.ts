import { describe, expect, it } from "vitest";
import type { StreamDisplayRow } from "../src/screen/stream-presentation";
import { terminalMouseClick } from "../src/terminal/mouse";

const rows: StreamDisplayRow[] = [
  { kind: "line", key: "history", line: { r: [] }, liveRowIndex: null },
  { kind: "gap", key: "gap", label: "Unloaded history" },
  { kind: "line", key: "live:0", line: { r: [] }, liveRowIndex: 0 },
];
const message = { key: "live:0", row: 0, column: 12, button: "left", modifiers: 0 };
describe("terminal mouse validation", () => {
  it("validates a live cell against native rows and dimensions", () => {
    expect(terminalMouseClick(message, rows, 80, 24)).toEqual({
      column: 12,
      row: 0,
      cols: 80,
      rows: 24,
      button: "left",
      modifiers: 0,
    });
  });
  it.each([
    { key: "history" },
    { key: "gap" },
    { key: "removed" },
    { row: 1 },
    { row: -1 },
    { column: -1 },
    { column: 80 },
    { column: 1.5 },
    { column: "12" },
    { button: "other" },
    { button: { toString: "left" } },
    { modifiers: 8 },
    { modifiers: -1 },
    { modifiers: "1" },
  ])("rejects stale, history or malformed input %o", (change) =>
    expect(terminalMouseClick({ ...message, ...change }, rows, 80, 24)).toBeNull(),
  );
  it("rejects invalid or unsupported source geometry", () => {
    expect(terminalMouseClick(message, rows, 0, 24)).toBeNull();
    expect(terminalMouseClick(message, rows, 513, 24)).toBeNull();
    expect(terminalMouseClick(message, rows, 80, 257)).toBeNull();
  });
});
