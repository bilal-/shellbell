import { describe, expect, it } from "vitest";
import { ScreenNameFilter } from "../src/backends/tmux/screen-name.js";

const text = (filter: ScreenNameFilter, ...chunks: string[]) =>
  chunks.map((chunk) => Buffer.from(filter.write(Buffer.from(chunk, "latin1"))).toString("latin1"));

describe("ScreenNameFilter", () => {
  it("removes a window name and keeps everything around it", () => {
    expect(text(new ScreenNameFilter(), "a\x1bkecho\x1b\\b\x1b[1mc")).toEqual(["ab\x1b[1mc"]);
  });

  it("follows a name and its ending across chunks", () => {
    expect(text(new ScreenNameFilter(), "a\x1b", "kse", "q\x1b", "\\1\r\n")).toEqual([
      "a",
      "",
      "",
      "1\r\n",
    ]);
  });

  it("passes other escapes through, including one split after ESC", () => {
    expect(text(new ScreenNameFilter(), "\x1b", "[2J", "\x1b\x1b[H")).toEqual([
      "",
      "\x1b[2J",
      "\x1b\x1b[H",
    ]);
  });

  it("ends a name at any escape, as tmux does", () => {
    expect(text(new ScreenNameFilter(), "\x1bkname\x1b[31mred")).toEqual(["\x1b[31mred"]);
  });

  it("lets CAN and SUB cancel a name", () => {
    expect(text(new ScreenNameFilter(), "\x1bkab\x18cd", "\x1bkx\x1aef")).toEqual([
      "\x18cd",
      "\x1aef",
    ]);
  });

  it("keeps a held ESC in order when the next chunk also ends with one", () => {
    expect(text(new ScreenNameFilter(), "x\x1b", "[Ay\x1b", "[B")).toEqual([
      "x",
      "\x1b[Ay",
      "\x1b[B",
    ]);
  });
});
