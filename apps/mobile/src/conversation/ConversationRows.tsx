import type { ConversationWireEntry } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { createContext, memo, type ReactNode, useContext, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { type AgentStyle, agentStyle } from "../agents/registry";
import { FONT, tokens } from "../theme/tokens";
import { LocalLinkContext } from "../web/link-context";
import {
  type ConversationRow,
  type ConversationStep,
  isDiff,
  type StepKind,
  stepKind,
  stepWaiting,
} from "./conversation-rows";
import { type MarkdownInline, markdownBlocks } from "./markdown";
import { BreathingDot, Expand, Resizes } from "./motion";
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
const red = tokens.terminal16[1];

/** Who said what: the agent's colour on its side, the computer's accent on yours. */
export interface ChatColors {
  readonly agent: string;
  /** The agent's name over its replies, such as `Claude`. */
  readonly agentName: string;
  readonly you: string;
}
export const ChatColorsContext = createContext<ChatColors>({
  agent: tokens.textMuted,
  agentName: "Agent",
  you: tokens.accents.emerald,
});

/** Tool names by kind, all light enough for AA contrast on black; the name says it too. */
export const STEP_COLORS: Readonly<Record<StepKind, string>> = {
  read: tokens.terminal16[4],
  edit: tokens.terminal16[5],
  run: tokens.terminal16[6],
  search: "#F9A8D4",
  web: tokens.terminal16[12],
  other: tokens.text,
};

/** A faint wash of a side's colour, strongest at its bar and fading across the message. */
function tint(color: string, from: "left" | "right") {
  return {
    experimental_backgroundImage: `linear-gradient(to ${from === "left" ? "right" : "left"}, ${color}24, ${color}05)`,
  } as const;
}

export const AgentStyleContext = createContext<AgentStyle>(agentStyle(undefined));
/**
 * The terminal's last changed lines while the agent works, read from the screen the phone
 * already has; `null` when there are none or a password prompt is on screen.
 */
export const LiveTailContext = createContext<readonly string[] | null>(null);

/** A screen reader is on; read once by the view rather than by every row. */
export const ScreenReaderContext = createContext(false);

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
  const localLink = useContext(LocalLinkContext);
  return parts.map((part, index) => {
    const key = `${index}`;
    const strong = "strong" in part && part.strong ? { fontFamily: FONT.bold } : null;
    if (part.kind === "code")
      return (
        <Text
          key={key}
          style={{ color: tokens.terminal16[6], backgroundColor: tokens.surface2, ...strong }}
        >
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
          onPress={() => {
            if (!localLink?.(part.url)) openLink(part.url);
          }}
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
  omitted,
}: {
  header: readonly string[];
  rows: readonly (readonly string[])[];
  omitted: { readonly rows: number; readonly columns: number };
}) {
  const { text, muted, mono, small } = useType();
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
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
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
      {omitted.rows + table.cutRows || omitted.columns ? (
        <Text style={small}>
          {[
            omitted.rows + table.cutRows ? `${omitted.rows + table.cutRows} more rows` : null,
            omitted.columns ? `${omitted.columns} more columns` : null,
          ]
            .filter(Boolean)
            .join(", ")}{" "}
          not shown
        </Text>
      ) : null}
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
          return (
            <Table key={key} header={block.header} rows={block.rows} omitted={block.omitted} />
          );
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

/** The owner's message: right-aligned under "You", with a bar in the computer's accent. */
function UserMessage({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { text, small, lineHeight } = useType();
  const colors = useContext(ChatColorsContext);
  return (
    <View
      accessible
      accessibilityLabel={`You: ${entry.text}`}
      style={{ alignItems: "flex-end", paddingHorizontal: 12, marginVertical: lineHeight / 2 }}
    >
      <Text style={{ ...small, color: colors.you, fontFamily: FONT.bold }}>You</Text>
      <View
        testID="user-message"
        style={{
          maxWidth: "88%",
          borderRightWidth: 2,
          borderRightColor: colors.you,
          paddingHorizontal: 10,
          paddingVertical: lineHeight / 4,
          ...tint(colors.you, "right"),
        }}
      >
        <Text selectable style={text}>
          {entry.text}
        </Text>
        <Shortened entry={entry} />
      </View>
    </View>
  );
}

function AgentReply({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const { lineHeight, small } = useType();
  const screenReader = useContext(ScreenReaderContext);
  const style = useContext(AgentStyleContext);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Clipboard.setStringAsync(entry.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const colors = useContext(ChatColorsContext);
  return (
    <Pressable
      // Not a focus stop on either platform, so screen readers reach the links and code buttons
      // inside. A long press copies the whole reply, as the agent's screen has no copy control.
      accessible={false}
      focusable={false}
      onLongPress={copy}
      style={{ paddingHorizontal: 12, paddingVertical: lineHeight / 2 }}
    >
      <Text style={{ ...small, color: colors.agent, fontFamily: FONT.bold }}>
        {colors.agentName}
      </Text>
      <View
        testID="agent-reply"
        style={{
          borderLeftWidth: 2,
          borderLeftColor: colors.agent,
          paddingLeft: 8,
          paddingVertical: lineHeight / 4,
          ...tint(colors.agent, "left"),
        }}
      >
        <Line marker={copied ? "✓" : style.reply} color={copied ? green : style.replyColor}>
          <Markdown text={entry.text} />
          <Shortened entry={entry} />
        </Line>
      </View>
      {/* A screen reader can't long-press a row that isn't a focus stop, so it gets a button. */}
      {screenReader ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Reply copied" : "Copy reply"}
          onPress={copy}
          style={{ alignSelf: "flex-end", minHeight: 44, justifyContent: "center" }}
        >
          <Text style={small}>{copied ? "[copied]" : "[copy]"}</Text>
        </Pressable>
      ) : null}
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

/** An edit's diff, with added and removed lines on green and red; the `+` and `-` stay. */
function Diff({ text: diff }: { text: string }) {
  const { muted, mono } = useType();
  const lines = diff.split("\n").slice(0, OUTPUT_LINES * 2);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View testID="step-diff">
        {lines.map((line, index) => {
          const added = line.startsWith("+") && !line.startsWith("+++ ");
          const removed = line.startsWith("-") && !line.startsWith("--- ");
          return (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              key={`${index}`}
              selectable
              style={{
                ...(added || removed ? { ...mono, color: tokens.text } : muted),
                backgroundColor: added ? `${green}29` : removed ? `${red}29` : undefined,
              }}
            >
              {line || " "}
            </Text>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** A step's state as a dot: breathing in the agent's colour while it runs, then green or amber. */
function StatusDot({ running, failed }: { running: boolean; failed: boolean }) {
  const { gutter, lineHeight } = useType();
  const colors = useContext(ChatColorsContext);
  return (
    <View style={{ width: gutter, height: lineHeight, justifyContent: "center" }}>
      {running ? (
        <BreathingDot color={colors.agent} size={8} />
      ) : (
        <View
          accessible={false}
          importantForAccessibility="no"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: failed ? amber : green,
          }}
        />
      )}
    </View>
  );
}

/** `Bash · npm test` with the tool name in its kind's colour. */
function StepTitle({ title, kind }: { title: string; kind: StepKind }) {
  const split = title.indexOf(" · ");
  if (split < 0) return title;
  return (
    <>
      <Text style={{ color: STEP_COLORS[kind] }}>{title.slice(0, split)}</Text>
      {title.slice(split)}
    </>
  );
}

function Step({ step, running }: { step: ConversationStep; running: boolean }) {
  const { text, gutter, lineHeight } = useType();
  const [open, setOpen] = useState(false);
  const title = step.call?.text ?? step.result?.text ?? "";
  const details = step.call?.detail;
  const output = step.result?.detail;
  const more = !!(details || output);
  const kind = stepKind(step.call);
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
        <View style={{ flexDirection: "row" }}>
          <StatusDot running={running} failed={step.failed} />
          <Text numberOfLines={open ? undefined : 1} style={{ ...text, flex: 1 }}>
            <StepTitle title={title} kind={kind} />
            {step.failed ? <Text style={{ color: amber }}> (failed)</Text> : null}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <Expand>
          <View style={{ paddingLeft: gutter }}>
            {details ? (
              isDiff(details, kind) ? (
                <Diff text={details} />
              ) : (
                <Output text={details} shortened={!!step.call?.truncated} />
              )
            ) : null}
            {output ? <Output text={output} shortened={!!step.result?.truncated} /> : null}
          </View>
        </Expand>
      ) : null}
    </View>
  );
}

/** Under the running step: the terminal's last changed lines, dimmed, until the result lands. */
function LiveTail() {
  const { small, gutter } = useType();
  const tail = useContext(LiveTailContext);
  if (!tail?.length) return null;
  return (
    <View
      testID="live-tail"
      accessible
      accessibilityLabel={`Latest output: ${tail.join(". ")}`}
      style={{ paddingLeft: gutter, opacity: 0.7 }}
    >
      {tail.map((line, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          key={`${index}`}
          numberOfLines={1}
          style={small}
        >
          {line}
        </Text>
      ))}
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
    <Resizes
      testID="work-card"
      style={{
        marginHorizontal: 12,
        marginVertical: lineHeight / 4,
        paddingHorizontal: 8,
        borderRadius: tokens.radius.sm,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.surface,
      }}
    >
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
            {running ? (
              <StepTitle title={ongoing(latest.call!.text)} kind={stepKind(latest.call)} />
            ) : (
              row.title
            )}
            {row.failed ? <Text style={{ color: amber }}> · {row.failed} failed</Text> : null}
            {running ? null : (
              <Text style={{ color: tokens.textFaint }}> {open ? "[−]" : "[+]"}</Text>
            )}
          </Text>
        </Line>
      </Pressable>
      {running && !open ? <LiveTail /> : null}
      {open ? (
        <Expand>
          <View style={{ paddingLeft: gutter, paddingBottom: lineHeight / 2 }}>
            {row.steps.map((step) => (
              <Step key={step.key} step={step} running={live && stepWaiting(step)} />
            ))}
            {running ? <LiveTail /> : null}
          </View>
        </Expand>
      ) : null}
    </Resizes>
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
