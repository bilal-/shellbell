/** Long enough for most page titles, short enough to leave room for the header's buttons. */
const TITLE_CHARS = 40;

/**
 * The page's own title, for the header. Android reports the address while nothing has loaded;
 * that, an empty title, or one that only names the door, falls back to the page's address.
 */
export function pageTitle(title: string | undefined, url: string | undefined): string | null {
  const text = (title ?? "").replace(/\s+/g, " ").trim();
  if (!text || text === url || /^https?:\/\//i.test(text) || text.startsWith("127.0.0.1:"))
    return null;
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
}
