import { describe, expect, it } from "vitest";
import { holdRows, TAP_SETTLE_MS, tapLanded } from "../src/util/steady-rows";

const key = (row: { id: string }) => row.id;

describe("steady rows", () => {
  it("keeps the held order and rows, with each row's latest content", () => {
    const held = [
      { id: "a", label: "working" },
      { id: "b", label: "idle" },
      { id: "c", label: "idle" },
    ];
    // The latest list re-sorted, dropped `b` and gained `d`.
    const latest = [
      { id: "c", label: "waiting" },
      { id: "d", label: "working" },
      { id: "a", label: "idle" },
    ];
    expect(holdRows(held, latest, key)).toEqual([
      { id: "a", label: "idle" },
      { id: "b", label: "idle" },
      { id: "c", label: "waiting" },
    ]);
  });

  it("ignores a tap that started just after the rows moved", () => {
    expect(tapLanded(10_000, 10_000 - TAP_SETTLE_MS + 1)).toBe(false);
    expect(tapLanded(10_000, 10_000 - TAP_SETTLE_MS)).toBe(true);
    expect(tapLanded(10_000, 0)).toBe(true);
  });
});
