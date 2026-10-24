/**
 * The Markdown subset agent replies use: headings, lists, block quotes, code blocks and
 * paragraphs, with inline code, emphasis and links. No HTML and no images; anything else
 * stays as plain text, so nothing an agent writes can load remote content.
 */
export type MarkdownInline =
  | { readonly kind: "text" | "code" | "bold" | "italic"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly url: string };
export type MarkdownBlock =
  | { readonly kind: "paragraph" | "quote"; readonly inline: readonly MarkdownInline[] }
  | { readonly kind: "heading"; readonly level: number; readonly inline: readonly MarkdownInline[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly {
        readonly key: string;
        readonly marker: string;
        readonly depth: number;
        readonly inline: readonly MarkdownInline[];
      }[];
    }
  | {
      readonly kind: "code";
      readonly language: string;
      readonly text: string;
      readonly open: boolean;
    };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/g;

export function markdownInline(text: string): MarkdownInline[] {
  const parts: MarkdownInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    const [, code, bold, boldAlt, label, url, italic, italicAlt] = match;
    if (code !== undefined) parts.push({ kind: "code", text: code });
    else if (bold !== undefined || boldAlt !== undefined)
      parts.push({ kind: "bold", text: (bold ?? boldAlt)! });
    else if (label !== undefined) parts.push({ kind: "link", text: label, url: url! });
    else parts.push({ kind: "italic", text: (italic ?? italicAlt)! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length)
      blocks.push({ kind: "paragraph", inline: markdownInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const marker = fence[1]!;
      const body: string[] = [];
      let open = true;
      for (i++; i < lines.length; i++) {
        if (lines[i]!.trim().startsWith(marker[0]!.repeat(marker.length))) {
          open = false;
          break;
        }
        body.push(lines[i]!);
      }
      blocks.push({ kind: "code", language: fence[2] ?? "", text: body.join("\n"), open });
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        inline: markdownInline(heading[2]!),
      });
      continue;
    }
    if (ITEM.test(line) && (!paragraph.length || /^\s*$/.test(lines[i - 1] ?? ""))) {
      endParagraph();
      const items: { key: string; marker: string; depth: number; inline: MarkdownInline[] }[] = [];
      const ordered = /\d/.test(ITEM.exec(line)![2]!);
      for (; i < lines.length; i++) {
        const item = ITEM.exec(lines[i]!);
        if (item) {
          const marker = /\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•";
          items.push({
            key: String(i),
            marker,
            depth: Math.min(3, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2)),
            inline: markdownInline(item[3]!),
          });
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          // A wrapped line continues the previous item.
          const previous = items.at(-1)!;
          previous.inline = [...previous.inline, ...markdownInline(` ${lines[i]!.trim()}`)];
        } else break;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      const body: string[] = [];
      for (; i < lines.length; i++) {
        const next = QUOTE.exec(lines[i]!);
        if (!next) break;
        body.push(next[1]!);
      }
      i--;
      blocks.push({ kind: "quote", inline: markdownInline(body.join("\n")) });
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}
