import { expect, it } from "vitest";
import { selectionSnapshot } from "../src/screen/selection-snapshot";
import type { StreamDisplayRow } from "../src/screen/stream-presentation";

it("counts a Unicode scalar split across style runs once and never emits half an emoji", () => {
  const input: StreamDisplayRow = {
    kind: "line",
    key: "a",
    liveRowIndex: 0,
    line: { r: [{ t: `${"a".repeat(32764)}\ud83d` }, { t: "\ude00" }] },
  };
  expect(selectionSnapshot([input], "a", "a")).toEqual({
    text: `${"a".repeat(32764)}😀`,
    truncated: false,
  });
});

const row = (key: string, text = key): StreamDisplayRow => ({
  kind: "line",
  key,
  line: { r: [{ t: text }] },
  liveRowIndex: 0,
});

it("preserves spaces, Unicode and visible gaps but removes hidden control characters", () => {
  const rows = [
    row("a", "outside"),
    row("b", "  日😀\u0000\u001b"),
    { kind: "gap" as const, key: "gap", label: "Earlier history omitted" },
    row("c", "\n"),
    row("d", "outside"),
  ];
  expect(selectionSnapshot(rows, "b", "c")).toEqual({
    text: "  日😀 �\n[Earlier history omitted]\n�",
    truncated: false,
  });
});
it("does not invent a range when keys disappeared or reversed", () => {
  expect(selectionSnapshot([row("a"), row("b")], "b", "a")).toBeNull();
  expect(selectionSnapshot([row("a")], "a", "gone")).toBeNull();
  expect(selectionSnapshot([row("a")], null, null)).toBeNull();
});
it("bounds oversized output by UTF8 bytes without splitting emoji", () => {
  const result = selectionSnapshot([row("a", "😀".repeat(10000))], "a", "a")!;
  expect(result.text).toBe("😀".repeat(8192));
  expect(result.truncated).toBe(true);
});
it("bounds a visible paragraph collection to 128 source rows", () => {
  const rows = Array.from({ length: 150 }, (_, index) => row(String(index)));
  const result = selectionSnapshot(rows, "0", "149")!;
  expect(result.text.split("\n")).toHaveLength(128);
  expect(result.text.endsWith("127")).toBe(true);
  expect(result.truncated).toBe(true);
});
