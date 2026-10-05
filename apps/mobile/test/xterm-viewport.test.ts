import type { Line } from "@shellbell/protocol";
import { expect, it } from "vitest";
import type { TerminalRow } from "../src/terminal/adapter";
import { anchoredOffset, liveEndIndex, liveOffset, livePadding } from "../src/terminal/viewport";

function source(lines: Line[], cursorRow: number | null = 1) {
  const rows: TerminalRow[] = [
    { key: "history", history: true, absoluteRow: 0, line: { r: [{ t: "old output" }] } },
    { key: "gap", history: false, line: { r: [{ t: "History omitted" }] } },
    ...lines.map((line, i) => ({ key: `live:${i}`, history: false, absoluteRow: 1 + i, line })),
  ];
  const order = rows.map((row) => row.key);
  return liveEndIndex(
    order,
    new Map(rows.map((row) => [row.key, row])),
    cursorRow === null ? null : `live:${cursorRow}`,
  );
}

it("follows status rows below the cursor, including a hidden cursor", () => {
  const lines: Line[] = [
    { r: [{ t: "response" }] },
    { r: [{ t: "> prompt" }] },
    { r: [] },
    { r: [{ t: "model: example | context: 32%" }] },
  ];
  expect(source(lines)).toBe(5);
  expect(source(lines, null)).toBe(5);
});
it("ignores blank trailing rows, history and gap labels when finding Live", () => {
  const lines: Line[] = [{ r: [] }, { r: [{ t: "> " }] }, { r: [{ t: " \u0000 " }] }];
  expect(source(lines)).toBe(3);
  expect(source([{ r: [] }], null)).toBe(-1);
  expect(source([{ r: [] }, { r: [] }, { r: [] }], 2)).toBe(4);
});
it("keeps painted blank status strips but ignores zero-width background runs", () => {
  expect(source([{ r: [] }, { r: [] }, { r: [{ t: "", n: 80, bg: 8 }] }])).toBe(4);
  expect(source([{ r: [] }, { r: [] }, { r: [{ t: "", n: 0, bg: 8 }] }])).toBe(3);
  expect(source([{ r: [] }, { r: [] }, { r: [{ t: "    ", u: true }] }])).toBe(4);
});
it("tracks footer removal and replacement without retaining an old extent", () => {
  const lines: Line[] = [{ r: [] }, { r: [{ t: "> " }] }, { r: [{ t: "working" }] }];
  expect(source(lines)).toBe(4);
  lines[2] = { r: [] };
  expect(source(lines)).toBe(3);
  lines[2] = { r: [{ t: "ready" }] };
  expect(source(lines)).toBe(4);
});
it("bottom-aligns a short occupied grid without moving a prompt above blank rows", () => {
  expect(livePadding(8, 7, 20, 400)).toBe(240);
  expect(livePadding(60, 59, 20, 400)).toBe(0);
  expect(livePadding(60, 3, 20, 400)).toBe(0);
  expect(livePadding(8, 2, 20, 400)).toBe(0);
  expect(livePadding(0, -1, 20, 400)).toBe(0);
});

it("keeps a prompt near the top of a mostly blank source screen visible", () => {
  expect(liveOffset(60, 3, 20, 400)).toBe(0);
  expect(liveOffset(60, 55, 20, 400)).toBe(720);
  expect(liveOffset(60, -1, 20, 400)).toBe(800);
});

it("keeps the visible source row and fractional position through history prepend and font resize", () => {
  expect(anchoredOffset(["a", "b", "c"], ["old", "a", "b", "c"], 25, 20, 30)).toBe(67.5);
});
it("uses the closest retained row when an anchor is evicted", () => {
  expect(anchoredOffset(["a", "b", "c"], ["b", "c"], 5, 20, 20)).toBe(0);
});
