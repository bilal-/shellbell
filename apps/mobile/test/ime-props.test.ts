import { expect, it } from "vitest";
import { COMPOSER_IME } from "../src/input/imeProps";

it("keeps CJK composition and Gboard voice input available in reviewed command drafts", () => {
  expect(COMPOSER_IME).toEqual({
    autoCorrect: true,
    autoCapitalize: "none",
    spellCheck: true,
    autoComplete: undefined,
    keyboardType: "default",
  });
});
