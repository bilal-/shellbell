/** Command drafts are reviewed before Send. Keep suggestions and Gboard's voice-input strip. */
export const COMPOSER_IME = {
  autoCorrect: true,
  autoCapitalize: "none" as const,
  spellCheck: true,
  autoComplete: undefined,
  keyboardType: "default" as const,
};
