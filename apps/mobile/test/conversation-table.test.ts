import { expect, it } from "vitest";
import { markdownBlocks } from "../src/conversation/markdown";
import { tableLines } from "../src/conversation/table";

it("reads a Markdown table into plain cells", () => {
  const source =
    "Before\n| Release | What it adds |\n|---|:--|\n| **0.18.0** | `watch` asks runners |\n| 0.19.0 | a \\| b |\nAfter";
  expect(markdownBlocks(source)).toEqual([
    { kind: "paragraph", inline: [{ kind: "text", text: "Before" }] },
    {
      kind: "table",
      header: ["Release", "What it adds"],
      rows: [
        ["0.18.0", "watch asks runners"],
        ["0.19.0", "a | b"],
      ],
      omitted: { rows: 0, columns: 0 },
    },
    { kind: "paragraph", inline: [{ kind: "text", text: "After" }] },
  ]);
  // Pipes without a rule line are an ordinary paragraph.
  expect(markdownBlocks("a | b\nc | d")[0]!.kind).toBe("paragraph");
});

it("draws a table that fits at its natural width", () => {
  expect(tableLines(["A", "Bee"], [["1", "2"]], 40).lines).toEqual([
    "┌───┬─────┐",
    "│ A │ Bee │",
    "├───┼─────┤",
    "│ 1 │ 2   │",
    "└───┴─────┘",
  ]);
});

it("shrinks the widest column and wraps its cells to fit the screen", () => {
  const { lines, headerLines } = tableLines(
    ["Release", "What it adds"],
    [["0.19.0", "sous doctor checks projects that allow remote runs"]],
    30,
  );
  expect(lines.every((line) => line.length <= 30)).toBe(true);
  expect(headerLines).toBe(1);
  // The wrapped cell still reads, word for word, as written.
  const second = lines.slice(3, -1).map((line) => line.split("│")[2]!.trim());
  expect(second.join(" ")).toBe("sous doctor checks projects that allow remote runs");
  // Every line of the table is the same width, so columns line up.
  expect(new Set(lines.map((line) => line.length)).size).toBe(1);
});

it("keeps narrow columns and lets a very wide table scroll", () => {
  const header = Array.from({ length: 8 }, (_, i) => `column${i}`);
  const { lines } = tableLines(header, [header], 20);
  expect(lines[0]!.length).toBeGreaterThan(20);
  expect(new Set(lines.map((line) => line.length)).size).toBe(1);
});

it("bounds what an agent's table can make the phone draw", async () => {
  const { TABLE_LIMITS } = await import("../src/conversation/markdown");
  const { TABLE_CHARS } = await import("../src/conversation/table");
  // A short reply describing a vast, sparse table.
  const wide = `|${"c|".repeat(1500)}\n|${"-|".repeat(1500)}\n${"|x|\n".repeat(5000)}`;
  const [table] = markdownBlocks(wide);
  if (table?.kind !== "table") throw new Error("not a table");
  expect(table.header).toHaveLength(TABLE_LIMITS.columns);
  expect(table.rows).toHaveLength(TABLE_LIMITS.rows);
  expect(table.omitted).toEqual({ rows: 4900, columns: 1500 - TABLE_LIMITS.columns });
  const long = markdownBlocks(`|a|\n|-|\n|${"y".repeat(5000)}|`)[0];
  if (long?.kind !== "table") throw new Error("not a table");
  expect(long.rows[0]![0]).toHaveLength(TABLE_LIMITS.cell);
  // However the cells wrap, the drawing stops at its character budget.
  const drawn = tableLines(
    table.header,
    Array.from({ length: 100 }, () => Array(12).fill("z".repeat(200))),
    20,
  );
  expect(drawn.lines.join("").length).toBeLessThanOrEqual(TABLE_CHARS + 2000);
  expect(drawn.cutRows).toBeGreaterThan(0);
});
