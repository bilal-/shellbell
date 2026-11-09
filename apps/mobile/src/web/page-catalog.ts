import { classifyWebLink, WEB_FEATURE, type WebPage, WebPagesSchema } from "@shellbell/protocol";

/** The tab and its content must use the same validated, supported catalog. */
export function registeredApps(
  hello: { features?: readonly string[]; pages?: unknown } | undefined,
  enabled: boolean,
): WebPage[] {
  if (!enabled || !hello?.features?.includes(WEB_FEATURE)) return [];
  const parsed = WebPagesSchema.safeParse(hello.pages ?? []);
  return parsed.success ? parsed.data : [];
}
export function registeredPageForURL(pages: readonly WebPage[], url: string): WebPage | undefined {
  const link = classifyWebLink(url);
  if (link.kind !== "local") return undefined;
  return pages.find((page) => !page.skipped && page.address === link.origin.authority);
}
export function pageTileColor(id: string): string {
  const colors = [
    "#10B981",
    "#3B82F6",
    "#F59E0B",
    "#A855F7",
    "#F43F5E",
    "#06B6D4",
    "#84CC16",
    "#F97316",
  ];
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}
