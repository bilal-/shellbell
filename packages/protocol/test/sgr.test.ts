import { describe, expect, it } from "vitest";
import { codePoints, type Line } from "../src/screen.js";
import { parseSgrLine } from "../src/sgr.js";
import { stringCells } from "../src/width.js";

const E = "\x1b[";
const cases: [string, string, Line][] = [
  ["plain", "hello", { r: [{ t: "hello" }] }],
  ["empty", "", { r: [] }],
  ["bold", `${E}1mhi${E}0m there`, { r: [{ t: "hi", b: true }, { t: " there" }] }],
  ["fg basic", `${E}31mred${E}39m plain`, { r: [{ t: "red", fg: 1 }, { t: " plain" }] }],
  ["bg basic", `${E}44mblue${E}49m`, { r: [{ t: "blue", bg: 4 }] }],
  ["bright fg", `${E}92mok`, { r: [{ t: "ok", fg: 10 }] }],
  ["bright bg", `${E}103mwarn`, { r: [{ t: "warn", bg: 11 }] }],
  ["256 fg semicolon", `${E}38;5;208mo`, { r: [{ t: "o", fg: 208 }] }],
  ["256 bg colon", `${E}48:5:17mo`, { r: [{ t: "o", bg: 17 }] }],
  ["truecolor semicolon", `${E}38;2;1;2;3mx`, { r: [{ t: "x", fg: [1, 2, 3] }] }],
  ["truecolor colon with colorspace", `${E}38:2::9:8:7mx`, { r: [{ t: "x", fg: [9, 8, 7] }] }],
  ["truecolor colon without colorspace", `${E}48:2:9:8:7mx`, { r: [{ t: "x", bg: [9, 8, 7] }] }],
  ["combined params", `${E}1;4;35mx`, { r: [{ t: "x", b: true, u: true, fg: 5 }] }],
  ["reset via empty", `${E}1mx${E}my`, { r: [{ t: "x", b: true }, { t: "y" }] }],
  [
    "22 clears bold and faint",
    `${E}1;2mx${E}22my`,
    { r: [{ t: "x", b: true, f: true }, { t: "y" }] },
  ],
  ["23 clears italic", `${E}3mx${E}23my`, { r: [{ t: "x", i: true }, { t: "y" }] }],
  ["24 clears underline", `${E}4mx${E}24my`, { r: [{ t: "x", u: true }, { t: "y" }] }],
  ["29 clears strike", `${E}9mx${E}29my`, { r: [{ t: "x", s: true }, { t: "y" }] }],
  ["inverse of defaults", `${E}7mx`, { r: [{ t: "x", fg: 0, bg: 15 }] }],
  ["inverse of colors", `${E}31;44;7mx`, { r: [{ t: "x", fg: 4, bg: 1 }] }],
  ["27 clears inverse", `${E}7mx${E}27my`, { r: [{ t: "x", fg: 0, bg: 15 }, { t: "y" }] }],
  ["adjacent same style merges", `${E}31ma${E}31mb`, { r: [{ t: "ab", fg: 1 }] }],
  ["unknown code ignored", `${E}99mx`, { r: [{ t: "x" }] }],
  ["osc stripped", "a\x1b]0;title\x07b", { r: [{ t: "ab" }] }],
  ["osc with ST stripped", "a\x1b]0;title\x1b\\b", { r: [{ t: "ab" }] }],
  ["charset escape stripped", "a\x1b(Bb", { r: [{ t: "ab" }] }],
  ["other csi ignored", `a${E}2Kb`, { r: [{ t: "ab" }] }],
  ["control chars stripped", "a\x07b\x08c", { r: [{ t: "abc" }] }],
  ["tab expands to next multiple of 8", "ab\tc", { r: [{ t: "ab      c" }] }],
  ["tab at column 8", "12345678\tx", { r: [{ t: "12345678        x" }] }],
  ["tab after wide char", "漢\tx", { r: [{ t: "漢      x", n: 9 }] }],
  ["tab after emoji", "🚀\tx", { r: [{ t: "🚀      x", n: 9 }] }],
  ["trailing spaces trimmed", "hi   ", { r: [{ t: "hi" }] }],
  ["trailing spaces with bg kept", `hi${E}41m   `, { r: [{ t: "hi" }, { t: "   ", bg: 1 }] }],
  ["malformed csi emitted literally", "a\x1b[12", { r: [{ t: "a\x1b[12", n: 4 }] }],
  ["unicode passes through", `${E}32m✓ done`, { r: [{ t: "✓ done", fg: 2 }] }],
  [
    "emoji surrogate pair kept together and gets n",
    `${E}1m🚀${E}0mx`,
    { r: [{ t: "🚀", b: true, n: 2 }, { t: "x" }] },
  ],
  ["CJK run gets n", "漢字ab", { r: [{ t: "漢字ab", n: 6 }] }],
  ["combining mark reduces n", "e\u0301x", { r: [{ t: "e\u0301x", n: 2 }] }],
  ["faint", `${E}2mx`, { r: [{ t: "x", f: true }] }],
  ["strike", `${E}9mx`, { r: [{ t: "x", s: true }] }],
  ["italic", `${E}3mx`, { r: [{ t: "x", i: true }] }],
  ["reset clears colors", `${E}31;44mx${E}0my`, { r: [{ t: "x", fg: 1, bg: 4 }, { t: "y" }] }],
  ["38 without args ignored", `${E}38mx`, { r: [{ t: "x" }] }],
  ["params with empty entries", `${E};1mx`, { r: [{ t: "x", b: true }] }],
];

describe("parseSgrLine", () => {
  it.each(cases)("%s", (_name, input, expected) => {
    expect(parseSgrLine(input)).toEqual(expected);
  });

  it.each(cases)("run cell-count invariant holds for %s", (_name, input) => {
    for (const r of parseSgrLine(input).r) {
      expect(stringCells(r.t)).toBe(r.n ?? codePoints(r.t));
    }
  });
});
