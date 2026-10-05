import { describe, expect, it } from "vitest";
import { preparePaste } from "../src/input/paste";

describe("preparePaste (spec 10.6 / M6)", () => {
  it("strips a trailing \\n and asks for an Enter", () => {
    expect(preparePaste("ls -la\n")).toEqual({ text: "ls -la", sendEnter: true });
  });

  it("strips a trailing \\r\\n and asks for an Enter", () => {
    expect(preparePaste("ls -la\r\n")).toEqual({ text: "ls -la", sendEnter: true });
  });

  it("leaves text with no trailing newline untouched", () => {
    expect(preparePaste("ls -la")).toEqual({ text: "ls -la", sendEnter: false });
  });

  it("only strips the trailing newline, not internal ones", () => {
    expect(preparePaste("a\nb\n")).toEqual({ text: "a\nb", sendEnter: true });
  });

  it("empty clipboard stays empty with no Enter", () => {
    expect(preparePaste("")).toEqual({ text: "", sendEnter: false });
  });
});
