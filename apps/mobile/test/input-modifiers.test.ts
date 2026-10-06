import type { NamedKey } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import {
  modifiedCharacter,
  modifiedKey,
  modifierLabel,
  NO_MODIFIERS,
} from "../src/input/modifiers";

describe("terminal modifier input", () => {
  it.each([
    ["left", { shift: true }, "\x1b[1;2D"],
    ["right", { shift: true }, "\x1b[1;2C"],
    ["up", { shift: true }, "\x1b[1;2A"],
    ["down", { shift: true }, "\x1b[1;2B"],
    ["left", { control: true }, "\x1b[1;5D"],
    ["left", { alt: true }, "\x1b[1;3D"],
    ["left", { shift: true, control: true }, "\x1b[1;6D"],
    ["left", { shift: true, control: true, alt: true }, "\x1b[1;8D"],
    ["home", { shift: true }, "\x1b[1;2H"],
    ["end", { control: true }, "\x1b[1;5F"],
    ["delete", { shift: true }, "\x1b[3;2~"],
    ["page-up", { control: true }, "\x1b[5;5~"],
    ["f1", { shift: true }, "\x1b[1;2P"],
    ["f12", { alt: true }, "\x1b[24;3~"],
    ["tab", { shift: true }, "\x1b[Z"],
    ["tab", { alt: true }, "\x1b\t"],
    ["ctrl-c", { alt: true }, "\x1b\x03"],
    ["ctrl-space", { alt: true }, "\x1b\x00"],
    ["backspace", { control: true }, "\x08"],
    ["enter", { alt: true }, "\x1b\r"],
    ["left", {}, "\x1b[D"],
  ] as const)("encodes %s with %o", (key, modifiers, expected) => {
    expect(modifiedKey(key as NamedKey, { ...NO_MODIFIERS, ...modifiers })).toBe(expected);
  });

  it.each(["enter", "esc", "tab"] as const)(
    "does not invent an extended keyboard mode for Control %s",
    (key) => expect(modifiedKey(key, { ...NO_MODIFIERS, control: true })).toBeNull(),
  );

  it.each([
    ["a", { shift: true }, "A"],
    ["c", { control: true }, "\x03"],
    ["a", { shift: true, control: true, alt: true }, "\x1b\x01"],
    ["x", { alt: true }, "\x1bx"],
    [" ", { control: true }, "\x00"],
    ["?", { control: true }, "\x7f"],
    ["[", { control: true }, "\x1b"],
  ] as const)("encodes character %j with %o", (character, modifiers, expected) => {
    expect(modifiedCharacter(character, { ...NO_MODIFIERS, ...modifiers })).toBe(expected);
  });

  it.each(["", "text", "é", "😀", "\x1b"])("rejects non-palette character %j", (text) => {
    expect(modifiedCharacter(text, { ...NO_MODIFIERS, control: true })).toBeNull();
  });

  it("describes the complete chord and never labels an inactive modifier", () => {
    expect(modifierLabel(NO_MODIFIERS)).toBe("");
    expect(modifierLabel({ shift: true, control: true, alt: true })).toBe("Shift Control Alt");
  });
});
