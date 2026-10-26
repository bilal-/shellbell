import type { ConversationWireEntry } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { createContext, memo, type ReactNode, useContext, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { type AgentStyle, agentStyle } from "../agents/registry";
import { FONT, tokens } from "../theme/tokens";
import { type ConversationRow, type ConversationStep, stepWaiting } from "./conversation-rows";
import { type MarkdownInline, markdownBlocks } from "./markdown";
import { tableLines } from "./table";

const CODE_LINES = 30;
const OUTPUT_LINES = 40;
/** A JetBrains Mono row is this many times its font size, as one xterm cell is tall. */
const ROW = 1.32;
/** A monospace character is this many times its font size wide. */
const CELL = 0.6;
/** JetBrains Mono's box-drawing glyphs are this many times the font size tall. */
const TABLE_ROW = 1.15;
/** Tap heights that hold at any text size; rows grow to them rather than shrink with text. */
const WORK_TARGET = 40;
const STEP_TARGET = 32;
/** Reachable by screen readers, invisible and untouchable on screen. */
const HIDDEN = { position: "absolute", width: 1, height: 1, opacity: 0 } as const;

/**
 * Everything uses the terminal's font, size and row height, so Conversation reads like the
 * agent's own screen and follows the same font size setting as Terminal.
 */
export function conversationType(fontSize: number) {
  const lineHeight = Math.round(fontSize * ROW);
  const mono = { fontFamily: FONT.regular, fontSize, lineHeight } as const;
  return {
    lineHeight,
    /** The marker column: two cells, like the agent's own `⏺ ` and `⎿ `. */
    gutter: Math.ceil(fontSize * CELL * 2),
    mono,
    text: { ...mono, color: tokens.text },
    muted: { ...mono, color: tokens.textMuted },
    small: { ...mono, color: tokens.textMuted },
  } as const;
}
export type ConversationType = ReturnType<typeof conversationType>;
export const ConversationTypeContext = createContext<ConversationType>(conversationType(12));
const useType = () => useContext(ConversationTypeContext);
const green = tokens.terminal16[2];
const amber = tokens.accents.amber;

export const AgentStyleContext = createContext<AgentStyle>(agentStyle(undefined));

function openLink(url: string) {
  // Show the address first; nothing an agent writes opens without the owner choosing it.
  Alert.alert("Open link?", url, [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => void Linking.openURL(url).catch(() => {}) },
  ]);
}

/** A terminal line: a one-character marker in a fixed gutter, then its content. */
function Line({
  marker,
  color = tokens.text,
  children,
}: {
  marker: string;
  color?: string;
  children: ReactNode;
}) {
  const { mono, gutter } = useType();
  return (
    <View style={{ flexDirection: "row" }}>
      <Text style={{ ...mono, color, width: gutter }}>{marker}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

function Inline({ parts }: { parts: readonly MarkdownInline[] }) {
  return parts.map((part, index) => {
    const key = `${index}`;
    const strong = "strong" in part && part.strong ? { fontFamily: FONT.bold } : null;
    if (part.kind === "code")
      return (
        <Text key={key} style={{ color: tokens.terminal16[6], ...strong }}>
          {part.text}
        </Text>
      );
    if (part.kind === "bold")
      return (
        <Text key={key} style={{ fontFamily: FONT.bold }}>
          {part.text}
        </Text>
      );
    if (part.kind === "italic")
      return (
        <Text key={key} style={{ fontFamily: strong ? FONT.boldItalic : FONT.italic }}>
          {part.text}
        </Text>
      );
    if (part.kind === "link")
      return (
        <Text
          key={key}
          accessibilityRole="link"
          onPress={() => openLink(part.url)}
          style={{ color: tokens.terminal16[4], textDecorationLine: "underline", ...strong }}
        >
          {part.text}
        </Text>
      );
    return part.text;
  });
}

function CodeBlock({ text: code, open }: { text: string; open: boolean }) {
  const { text, small } = useType();
  const lines = code.split("\n");
  const [all, setAll] = useState(lines.length <= CODE_LINES);
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        backgroundColor: tokens.surface,
        borderLeftWidth: 2,
        borderLeftColor: tokens.border,
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ ...text, padding: 10 }}>
          {all ? code : lines.slice(0, CODE_LINES).join("\n")}
        </Text>
      </ScrollView>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 4 }}>
        {all ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setAll(true)}
            style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 10 }}
          >
            <Text style={small}>[show all {lines.length} lines]</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          onPress={() => {
            void Clipboard.setStringAsync(code).then(() => setCopied(true));
          }}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 10 }}
        >
          <Text style={small}>{copied ? "[copied]" : "[copy]"}</Text>
        </Pressable>
      </View>
      {open ? (
        <Text style={{ ...small, paddingHorizontal: 10, paddingBottom: 8 }}>
          This code block hasn't finished yet.
        </Text>
      ) : null}
    </View>
  );
}

function Table({
  header,
  rows,
}: {
  header: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  const { text, muted, mono } = useType();
  // Fit the columns to the width this reply has, in terminal cells; until it is measured, a
  // phone-sized guess avoids a first frame far wider than the screen.
  const [cells, setCells] = useState(40);
  const table = useMemo(() => tableLines(header, rows, cells), [header, rows, cells]);
  return (
    <View
      onLayout={(event) =>
        setCells(Math.max(12, Math.floor(event.nativeEvent.layout.width / (mono.fontSize * CELL))))
      }
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {/* Box lines only join up if a row is no taller than the `│` glyph itself. */}
        <Text selectable style={{ ...muted, lineHeight: Math.floor(mono.fontSize * TABLE_ROW) }}>
          {table.lines.map((line, index) => {
            // Border lines stay muted; the header row is bold, like the agent's screen.
            const head = index > 0 && index <= table.headerLines;
            const rule = /^[┌├└]/.test(line);
            return (
              <Text
                key={`${index}`}
                style={
                  rule ? undefined : { color: text.color, ...(head && { fontFamily: FONT.bold }) }
                }
              >
                {index > 0 ? "\n" : ""}
                {line}
              </Text>
            );
          })}
        </Text>
      </ScrollView>
    </View>
  );
}

/** Rendered Markdown for agent replies; plain text is a paragraph like any other. */
export function Markdown({ text: source }: { text: string }) {
  const { text, muted, gutter, lineHeight } = useType();
  const blocks = useMemo(() => markdownBlocks(source), [source]);
  return (
    <View style={{ gap: lineHeight }}>
      {blocks.map((block, index) => {
        const key = `${index}`;
        if (block.kind === "code")
          return <CodeBlock key={key} text={block.text} open={block.open} />;
        if (block.kind === "table")
          return <Table key={key} header={block.header} rows={block.rows} />;
        if (block.kind === "rule")
          return <View key={key} style={{ height: 1, backgroundColor: tokens.border }} />;
        if (block.kind === "heading")
          return (
            <Text
              key={key}
              accessibilityRole="header"
              selectable
              style={{ ...text, fontFamily: FONT.bold }}
            >
              <Inline parts={block.inline} />
            </Text>
          );
        if (block.kind === "quote")
          return (
            <Line key={key} marker="│" color={tokens.textFaint}>
              <Text selectable style={muted}>
                <Inline parts={block.inline} />
              </Text>
            </Line>
          );
        if (block.kind === "list")
          return (
            <View key={key}>
              {block.items.map((item) => (
                <View
                  key={item.key}
                  style={{ flexDirection: "row", paddingLeft: item.depth * gutter }}
                >
                  <Text
                    style={{ ...muted, minWidth: item.marker.length > 1 ? gutter * 1.5 : gutter }}
                  >
                    {item.marker === "•" ? "-" : item.marker}
                  </Text>
                  <Text selectable style={{ ...text, flex: 1 }}>
                    <Inline parts={item.inline} />
                  </Text>
                </View>
              ))}
            </View>
          );
        return (
          <Text key={key} selectable style={text}>
            <Inline parts={block.inline} />
          </Text>
        );
      })}
    </View>
  );
}

function Shortened({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { small } = useType();
  return entry.truncated ? <Text style={small}>(shortened)</Text> : null;
}

/** The owner's prompt, as the agent echoes it: a `>` line on a lighter band. */
function UserMessage({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { text, lineHeight } = useType();
  const style = useContext(AgentStyleContext);
  return (
    <View
      accessible
      accessibilityLabel={`You: ${entry.text}`}
      style={{
        backgroundColor: tokens.surface2,
        paddingHorizontal: 12,
        paddingVertical: lineHeight / 4,
        marginVertical: lineHeight / 2,
      }}
    >
      <Line marker={style.prompt} color={tokens.textMuted}>
        <Text selectable style={text}>
          {entry.text}
        </Text>
        <Shortened entry={entry} />
      </Line>
    </View>
  );
}

function AgentReply({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { lineHeight } = useType();
  const style = useContext(AgentStyleContext);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Clipboard.setStringAsync(entry.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Pressable
      // Not a focus stop on either platform, so screen readers reach the links and code buttons
      // inside. A long press copies the whole reply, as the agent's screen has no copy control.
      accessible={false}
      focusable={false}
      onLongPress={copy}
      style={{ paddingHorizontal: 12, paddingVertical: lineHeight / 2 }}
    >
      <Line marker={copied ? "✓" : style.reply} color={copied ? green : style.replyColor}>
        <Markdown text={entry.text} />
        <Shortened entry={entry} />
      </Line>
      {/* Screen readers can't long-press a row that isn't a focus stop, so they get a button. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? "Reply copied" : "Copy reply"}
        onPress={copy}
        style={HIDDEN}
      />
    </Pressable>
  );
}

function Output({ text: output, shortened }: { text: string; shortened: boolean }) {
  const { muted, small } = useType();
  const lines = output.split("\n");
  const [all, setAll] = useState(lines.length <= OUTPUT_LINES);
  return (
    <Line marker="⎿" color={tokens.textFaint}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={muted}>
          {all ? output : lines.slice(-OUTPUT_LINES).join("\n")}
        </Text>
      </ScrollView>
      {all ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setAll(true)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={small}>… +{lines.length - OUTPUT_LINES} lines [show all]</Text>
        </Pressable>
      )}
      {shortened ? <Text style={small}>(shortened on your computer)</Text> : null}
    </Line>
  );
}

function Step({ step, running }: { step: ConversationStep; running: boolean }) {
  const { text, gutter, lineHeight } = useType();
  const style = useContext(AgentStyleContext);
  const [open, setOpen] = useState(false);
  const title = step.call?.text ?? step.result?.text ?? "";
  const details = step.call?.detail;
  const output = step.result?.detail;
  const more = !!(details || output);
  return (
    <View>
      <Pressable
        accessibilityRole={more ? "button" : "text"}
        accessibilityState={more ? { expanded: open } : undefined}
        accessibilityLabel={`${title}${step.failed ? ", failed" : ""}${running ? ", running" : ""}`}
        disabled={!more}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: Math.max(lineHeight, STEP_TARGET), justifyContent: "center" }}
      >
        <Line marker={style.step} color={step.failed ? amber : running ? tokens.textFaint : green}>
          <Text numberOfLines={open ? undefined : 1} style={text}>
            {title}
            {step.failed ? <Text style={{ color: amber }}> (failed)</Text> : null}
          </Text>
        </Line>
      </Pressable>
      {open ? (
        <View style={{ paddingLeft: gutter }}>
          {details ? <Output text={details} shortened={!!step.call?.truncated} /> : null}
          {output ? <Output text={output} shortened={!!step.result?.truncated} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** A step title that the computer already shortened ends in `…`; don't add another. */
const ongoing = (title: string) => (title.endsWith("…") ? title : `${title}…`);

function Work({ row, live }: { row: Extract<ConversationRow, { kind: "work" }>; live: boolean }) {
  const { text, small, gutter, lineHeight } = useType();
  const style = useContext(AgentStyleContext);
  const [open, setOpen] = useState(false);
  const latest = row.steps.at(-1)!;
  // While the agent works, every call in its newest stretch still waiting for a result is
  // running: parallel calls are answered in order, so the waiting ones are always the last.
  const running = live && stepWaiting(latest);
  return (
    <View style={{ paddingHorizontal: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${row.title}${row.failed ? `, ${row.failed} failed` : ""}`}
        onPress={() => setOpen((value) => !value)}
        // One blank row above and below, like every other block, and still a comfortable tap.
        style={{
          minHeight: Math.max(lineHeight * 2, WORK_TARGET),
          paddingVertical: lineHeight / 2,
          justifyContent: "center",
        }}
      >
        <Line
          marker={running ? style.working : style.step}
          color={running ? style.workingColor : row.failed ? amber : green}
        >
          <Text numberOfLines={1} style={running ? small : text}>
            {running ? ongoing(latest.call!.text) : row.title}
            {row.failed ? <Text style={{ color: amber }}> · {row.failed} failed</Text> : null}
            {running ? null : (
              <Text style={{ color: tokens.textFaint }}> {open ? "[−]" : "[+]"}</Text>
            )}
          </Text>
        </Line>
      </Pressable>
      {open ? (
        <View style={{ paddingLeft: gutter, paddingBottom: lineHeight / 2 }}>
          {row.steps.map((step) => (
            <Step key={step.key} step={step} running={live && stepWaiting(step)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Summary({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { small, lineHeight } = useType();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: lineHeight / 2, gap: lineHeight }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Earlier conversation was summarized"
        disabled={!entry.detail}
        onPress={() => setOpen((value) => !value)}
        hitSlop={{ top: 12, bottom: 12 }}
        style={{ justifyContent: "center" }}
      >
        <Text numberOfLines={1} style={small}>
          ─── Earlier conversation was summarized ───────────────────────
        </Text>
      </Pressable>
      {open && entry.detail ? <Markdown text={entry.detail} /> : null}
    </View>
  );
}

function Notice({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { small, lineHeight } = useType();
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: lineHeight / 2 }}>
      <Line marker="·" color={tokens.textFaint}>
        <Text style={small}>{entry.text}</Text>
      </Line>
    </View>
  );
}

/**
 * Rows are rebuilt for every new entry, so a row re-renders only when what it shows changed:
 * the same entries (which arrive frozen and keep their identity) and the same live state.
 */
export function sameRow(a: ConversationRow, b: ConversationRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind !== "work" || b.kind !== "work")
    return "entry" in a && "entry" in b && a.entry === b.entry;
  return (
    a.steps.length === b.steps.length &&
    a.steps.every((step, i) => step.call === b.steps[i]!.call && step.result === b.steps[i]!.result)
  );
}

export const Row = memo(
  function Row({ row, live }: { row: ConversationRow; live: boolean }) {
    if (row.kind === "user") return <UserMessage entry={row.entry} />;
    if (row.kind === "assistant") return <AgentReply entry={row.entry} />;
    if (row.kind === "work") return <Work row={row} live={live} />;
    if (row.kind === "summary") return <Summary entry={row.entry} />;
    return <Notice entry={row.entry} />;
  },
  (before, after) => before.live === after.live && sameRow(before.row, after.row),
);
