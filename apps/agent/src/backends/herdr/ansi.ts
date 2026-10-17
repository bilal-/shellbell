import type { Color, Line, Run } from "@shellbell/protocol";

function color(base: 38 | 48, value: Color): string {
  return typeof value === "number"
    ? `${base};5;${value}`
    : `${base};2;${value[0]};${value[1]};${value[2]}`;
}

function sgr(run: Run): string {
  const codes = ["0"];
  if (run.b) codes.push("1");
  if (run.f) codes.push("2");
  if (run.i) codes.push("3");
  if (run.u) codes.push("4");
  if (run.s) codes.push("9");
  if (run.fg !== undefined) codes.push(color(38, run.fg));
  if (run.bg !== undefined) codes.push(color(48, run.bg));
  return `\x1b[${codes.join(";")}m`;
}

/**
 * One parsed row as bytes an xterm draws the same way. Every run states its whole style, and the
 * row ends with a reset, so no colour carries into a line feed or the next row.
 */
export function lineAnsi(line: Line): string {
  let out = "";
  for (const run of line.r) {
    // Control characters never come from a parsed row; drop any, so a row stays one row.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
    out += sgr(run) + run.t.replace(/[\x00-\x1f\x7f]/g, "");
  }
  return `${out}\x1b[0m`;
}
