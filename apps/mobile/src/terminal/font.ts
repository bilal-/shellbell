import { requireOptionalNativeModule } from "expo-modules-core";

/** Base64 of a TrueType font; the terminal page needs about 3.3 MB of it. */
const FONT_LIMIT = 8 * 1024 * 1024;
let font: Promise<string | null> | undefined;

/**
 * The terminal page's font, read once from the copy the app ships for its own text. Null when
 * the native module can't provide it; the page then uses the system's monospace font.
 */
export function terminalFont(): Promise<string | null> {
  font ??= (async () => {
    try {
      const module = requireOptionalNativeModule<{
        terminalFont?: () => Promise<string | null>;
      }>("ShellbellTerminalInput");
      const value = await module?.terminalFont?.();
      return typeof value === "string" &&
        value.length <= FONT_LIMIT &&
        /^[A-Za-z0-9+/]+=*$/.test(value)
        ? value
        : null;
    } catch {
      return null;
    }
  })().then((value) => {
    // A read that failed is tried again by the next terminal, rather than for the whole session.
    if (value === null) font = undefined;
    return value;
  });
  return font;
}
