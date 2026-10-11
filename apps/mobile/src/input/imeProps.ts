/** Command drafts are reviewed before Send. Keep suggestions and Gboard's voice-input strip. */
export const COMPOSER_IME = {
  autoCorrect: true,
  autoCapitalize: "none" as const,
  spellCheck: true,
  autoComplete: undefined,
  keyboardType: "default" as const,
};

/**
 * Live keys send every change at once, so nothing may rewrite text after it was sent. Android's
 * `visible-password` turns off predictions, swipe and composition on Gboard and Samsung Keyboard;
 * iOS's ASCII-capable keyboard leaves out the CJK and other composing input modes. React Native
 * does not report IME composition, so a keyboard that cannot compose is the only reliable way to
 * never send uncommitted text. Composed languages use the command bar.
 */
export function liveKeysIme(os: string) {
  return {
    autoCorrect: false,
    autoCapitalize: "none" as const,
    spellCheck: false,
    autoComplete: "off" as const,
    keyboardType: os === "android" ? ("visible-password" as const) : ("ascii-capable" as const),
  };
}

/** Passwords are never suggested, corrected or kept in draft history. */
export const SECRET_IME = {
  autoCorrect: false,
  autoCapitalize: "none" as const,
  spellCheck: false,
  autoComplete: "off" as const,
  keyboardType: "default" as const,
};
