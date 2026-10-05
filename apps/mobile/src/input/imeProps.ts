export type InputMode = "line" | "raw";
export type Os = "ios" | "android";

export interface ImeProps {
  autoCorrect: boolean;
  autoCapitalize: "none" | "sentences";
  spellCheck: boolean;
  autoComplete: "off" | undefined;
  keyboardType: "default" | "ascii-capable" | "visible-password";
}

/**
 * Spec 10.6 errata: line mode has no differ, and the user reviews the composed text before
 * pressing Send, so autocorrect/spellcheck/autocomplete are left on there -- that is what keeps
 * Gboard's suggestion strip around, and the voice-input mic button lives in that strip. Setting
 * `autoCorrect={false}` on Android sets `TYPE_TEXT_FLAG_NO_SUGGESTIONS`, which hides the strip
 * (and the mic with it), so line mode must not set it. Raw mode's IME configuration is
 * unchanged: every keystroke is forwarded live via a diff of `onChangeText` against the previous
 * value (`rawChangeSteps`), and autocorrect/composition would inject phantom edits that corrupt
 * that diff -- so raw mode keeps `autoCorrect={false}`, `spellCheck={false}`,
 * `autoComplete="off"` and, on Android, `keyboardType="visible-password"` to disable suggestions
 * and composition outright.
 */
export function imeProps(mode: InputMode, os: Os): ImeProps {
  if (mode === "raw") {
    return {
      autoCorrect: false,
      autoCapitalize: "none",
      spellCheck: false,
      autoComplete: "off",
      keyboardType: os === "ios" ? "ascii-capable" : "visible-password",
    };
  }
  return {
    autoCorrect: true,
    autoCapitalize: "sentences",
    spellCheck: true,
    autoComplete: undefined,
    keyboardType: "default",
  };
}
