import { describe, expect, it } from "vitest";
import { imeProps } from "../src/input/imeProps";

describe("imeProps (spec 10.6 errata: line mode restores Gboard voice input)", () => {
  it("enables autocorrect/suggestions in line mode so the Gboard mic is available", () => {
    const props = imeProps("line", "android");
    expect(props.autoCorrect).toBe(true);
    expect(props.spellCheck).toBe(true);
    expect(props.autoComplete).toBeUndefined();
    expect(props.autoCapitalize).toBe("sentences");
  });

  it("line mode uses the default keyboard on both platforms", () => {
    expect(imeProps("line", "android").keyboardType).toBe("default");
    expect(imeProps("line", "ios").keyboardType).toBe("default");
  });

  it("keeps raw mode's differ-safe IME settings untouched", () => {
    const props = imeProps("raw", "android");
    expect(props.autoCorrect).toBe(false);
    expect(props.spellCheck).toBe(false);
    expect(props.autoComplete).toBe("off");
    expect(props.autoCapitalize).toBe("none");
  });

  it("raw mode uses visible-password on Android to disable suggestions/composition", () => {
    expect(imeProps("raw", "android").keyboardType).toBe("visible-password");
  });

  it("raw mode uses ascii-capable on iOS", () => {
    expect(imeProps("raw", "ios").keyboardType).toBe("ascii-capable");
  });
});
