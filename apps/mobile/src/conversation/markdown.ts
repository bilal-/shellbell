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
  | { readonly kind: "rule" }
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
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
// Bounded spans, and no `[` inside a link label, keep long unclosed runs such as `[[[[` linear.
const INLINE =
  /`([^`\n]{1,2000})`|\*\*([^*\n]{1,2000})\*\*|__([^_\n]{1,2000})__|\[([^[\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)|(?<![\w*])\*([^*\n]{1,2000})\*(?![\w*])|(?<![\w_])_([^_\n]{1,2000})_(?![\w_])/g;
/** A bullet, or a numbered item from 1, can start a list straight under a paragraph line. */
const LIST_START = /^\s*(?:[-*+]|1[.)])\s/;

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
  /** The previous block was a list that a code block inside it ended; its fence may be indented. */
  let afterList = false;
  const endParagraph = () => {
    if (paragraph.length)
      blocks.push({ kind: "paragraph", inline: markdownInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(afterList ? line.trimStart() : line);
    afterList = false;
    if (fence) {
      endParagraph();
      const marker = fence[1]!;
      // A fence indented under a list item indents its code the same way; drop that indent.
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      let open = true;
      for (i++; i < lines.length; i++) {
        if (lines[i]!.trim().startsWith(marker[0]!.repeat(marker.length))) {
          open = false;
          break;
        }
        const own = lines[i]!.length - lines[i]!.trimStart().length;
        body.push(lines[i]!.slice(Math.min(indent, own)));
      }
      blocks.push({ kind: "code", language: fence[2] ?? "", text: body.join("\n"), open });
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    if (RULE.test(line) && !paragraph.length) {
      blocks.push({ kind: "rule" });
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
    if (ITEM.test(line) && (!paragraph.length || LIST_START.test(line))) {
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
        } else if (FENCE.test(lines[i]!.trimStart())) {
          // A code block inside an item ends the list here and is read as code below.
          afterList = true;
          break;
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
