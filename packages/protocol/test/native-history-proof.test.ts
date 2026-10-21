import { describe, expect, it } from "vitest";
import { NATIVE_HISTORY_SEED_ROWS, nativeHistoryProof } from "../src/native-history-proof.js";

describe("native history physical-row proof", () => {
  it("requires matching geometry, row count, row order and text, including empty rows", () => {
    const proof = nativeHistoryProof(80, ["first", "", "界 last"]);
    expect(proof).toMatch(/^[a-f0-9]{64}$/);
    for (const [cols, rows] of [
      [81, ["first", "", "界 last"]],
      [80, ["first", "界 last"]],
      [80, ["界 last", "", "first"]],
      [80, ["first", "", "界 changed"]],
      [80, ["first", "", "界", " last"]],
    ] as const)
      expect(nativeHistoryProof(cols, rows)).not.toBe(proof);
    expect(nativeHistoryProof(80, ["first  ", "  ", "界 last "])).toBe(proof);
  });
  it("does not conflate an empty history with one empty row", () => {
    expect(nativeHistoryProof(80, [])).not.toBe(nativeHistoryProof(80, [""]));
  });
  it("refuses controls, invalid dimensions and unbounded captures", () => {
    for (const cols of [0, 513, -1, 1.5, NaN]) expect(nativeHistoryProof(cols, ["x"])).toBeNull();
    for (const row of ["a\tb", "a\nb", "\x1b[0m", "\x85", "x".repeat(524288)])
      expect(nativeHistoryProof(80, [row])).toBeNull();
    expect(nativeHistoryProof(80, Array(NATIVE_HISTORY_SEED_ROWS + 1).fill("x"))).toBeNull();
  });
});
