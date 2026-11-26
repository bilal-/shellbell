// Capture the live grid. Desktop scroll position must never move the phone cursor.
function color(cell, foreground) {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB())
    return [value >> 16, (value >> 8) & 255, value & 255];
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return value;
}
/** One cell's text as well-formed Unicode within a run's length limit. */
function cellText(raw) {
  // At most 32 code points (64 UTF-16 units), never splitting a surrogate pair.
  const text = Array.from(String(raw || " ").toWellFormed())
    .slice(0, 32)
    .join("");
  return text || " ";
}
function capture(term) {
  const { cols, rows } = term;
  if (cols < 1 || rows < 1 || cols > 512 || rows > 256 || cols * rows > 32000)
    throw Error("Unsupported grid");
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    const runs = [];
    let previous;
    for (let x = 0; line && x < cols; x++) {
      const c = line.getCell(x);
      const width = c?.getWidth();
      // Mid-resize, a wide character can start in the last column; keep every row within cols.
      if (!width || x + width > cols) continue;
      let fg = color(c, true),
        bg = color(c, false);
      if (c.isInverse()) {
        const theme = term.options.theme || {};
        const rgb = (v, fallback) =>
          /^#[0-9a-f]{6}$/i.test(v || "")
            ? v
                .slice(1)
                .match(/../g)
                .map((s) => parseInt(s, 16))
            : fallback;
        [fg, bg] = [
          bg ?? rgb(theme.background, [0, 0, 0]),
          fg ?? rgb(theme.foreground, [255, 255, 255]),
        ];
      }
      const style = {
        fg,
        bg,
        b: c.isBold() || undefined,
        i: c.isItalic() || undefined,
        u: c.isUnderline() || undefined,
        f: c.isDim() || undefined,
        s: c.isStrikethrough() || undefined,
      };
      for (const k of ["b", "i", "u", "f", "s"]) if (style[k]) style[k] = true;
      const key = JSON.stringify(style);
      const chars = c.isInvisible() ? " ".repeat(width) : cellText(c.getChars());
      if (key !== previous || runs.at(-1).t.length + chars.length > 4096) {
        runs.push({ ...style, t: "", n: 0 });
        previous = key;
      }
      runs.at(-1).t += chars;
      runs.at(-1).n += width;
    }
    lines.push({ r: runs, w: buffer.getLine(buffer.baseY + y + 1)?.isWrapped || undefined });
  }
  return {
    cols,
    rows,
    cursor: {
      x: Math.max(0, Math.min(cols - 1, buffer.cursorX)),
      y: Math.max(0, Math.min(rows - 1, buffer.cursorY)),
    },
    lines,
    scrollbackTotal: 0,
  };
}
module.exports = { capture };
