/**
 * A Markdown table drawn the way a terminal agent draws one: box lines around columns of
 * monospace text. Columns shrink, widest first, to fit `width` characters, and their cells
 * wrap; a table that still can't fit keeps its narrowest columns and scrolls sideways.
 */
export interface TableLines {
  readonly lines: readonly string[];
  /** How many of the lines, after the top border, belong to the header row. */
  readonly headerLines: number;
}

const MIN_COLUMN = 6;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > width) {
      if (line) out.push(line);
      line = "";
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else {
      out.push(line);
      line = rest;
    }
  }
  out.push(line);
  return out;
}

export function tableLines(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  width: number,
): TableLines {
  const columns = Math.max(header.length, ...rows.map((row) => row.length));
  const cell = (row: readonly string[], c: number) => row[c] ?? "";
  const widths = Array.from({ length: columns }, (_, c) =>
    Math.max(1, ...[header, ...rows].map((row) => cell(row, c).length)),
  );
  // Each column costs its text plus one space either side and a divider; then one more border.
  const total = () => widths.reduce((sum, w) => sum + w + 3, 1);
  while (total() > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= MIN_COLUMN) break;
    widths[widest] = Math.max(MIN_COLUMN, widths[widest]! - Math.max(1, total() - width));
  }
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(middle) + right;
  const row = (values: readonly string[]) => {
    const wrapped = widths.map((w, c) => wrap(cell(values, c), w));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    return Array.from(
      { length: height },
      (_, l) => `│ ${wrapped.map((lines, c) => (lines[l] ?? "").padEnd(widths[c]!)).join(" │ ")} │`,
    );
  };
  const head = row(header);
  const lines = [border("┌", "┬", "┐"), ...head, border("├", "┼", "┤")];
  rows.forEach((values, index) => {
    if (index > 0) lines.push(border("├", "┼", "┤"));
    lines.push(...row(values));
  });
  lines.push(border("└", "┴", "┘"));
  return { lines, headerLines: head.length };
}
