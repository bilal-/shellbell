// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before URL handlers normalize them.
const UNSAFE_URL_CHARACTERS = /[\s\\\u0000-\u001f\u007f]/u;

/** Terminal output may advertise links, but only web URLs may reach native Linking. */
export function terminalWebUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 1800 ||
    !/^https?:\/\//i.test(value) ||
    UNSAFE_URL_CHARACTERS.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
