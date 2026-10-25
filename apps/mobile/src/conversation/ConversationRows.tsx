import type { ConversationWireEntry } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { createContext, memo, type ReactNode, useContext, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { type AgentStyle, agentStyle } from "../agents/registry";
import { FONT, tokens } from "../theme/tokens";
import { type ConversationRow, type ConversationStep, stepWaiting } from "./conversation-rows";
import { type MarkdownInline, markdownBlocks } from "./markdown";

const CODE_LINES = 30;
const OUTPUT_LINES = 40;
/** Everything uses the terminal's font, so Conversation reads like the agent's own screen. */
const mono = { fontFamily: FONT.regular, fontSize: 13, lineHeight: 20 } as const;
const text = { ...mono, color: tokens.text } as const;
const muted = { ...mono, color: tokens.textMuted } as const;
const small = { ...mono, fontSize: 12, lineHeight: 18, color: tokens.textMuted } as const;
const GUTTER = 18;
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
  return (
    <View style={{ flexDirection: "row" }}>
      <Text style={{ ...mono, color, width: GUTTER }}>{marker}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

function Inline({ parts }: { parts: readonly MarkdownInline[] }) {
  return parts.map((part, index) => {
    const key = `${index}`;
    if (part.kind === "code")
      return (
        <Text key={key} style={{ color: tokens.terminal16[6] }}>
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
        <Text key={key} style={{ fontFamily: FONT.italic }}>
          {part.text}
        </Text>
      );
    if (part.kind === "link")
      return (
        <Text
          key={key}
          accessibilityRole="link"
          onPress={() => openLink(part.url)}
          style={{ color: tokens.terminal16[4], textDecorationLine: "underline" }}
        >
          {part.text}
        </Text>
      );
    return part.text;
  });
}

function CodeBlock({ text: code, open }: { text: string; open: boolean }) {
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
        <Text selectable style={{ ...text, fontSize: 13, lineHeight: 19, padding: 10 }}>
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

/** Rendered Markdown for agent replies; plain text is a paragraph like any other. */
export function Markdown({ text: source }: { text: string }) {
  return (
    <View style={{ gap: 8 }}>
      {markdownBlocks(source).map((block, index) => {
        const key = `${index}`;
        if (block.kind === "code")
          return <CodeBlock key={key} text={block.text} open={block.open} />;
        if (block.kind === "rule")
          return (
            <View
              key={key}
              style={{ height: 1, backgroundColor: tokens.border, marginVertical: 8 }}
            />
          );
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
            <View key={key} style={{ gap: 2 }}>
              {block.items.map((item) => (
                <View
                  key={item.key}
                  style={{ flexDirection: "row", paddingLeft: item.depth * 2 * 8.4 }}
                >
                  <Text style={{ ...muted, minWidth: item.marker.length > 1 ? 28 : GUTTER }}>
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
  return entry.truncated ? <Text style={small}>(shortened)</Text> : null;
}

/** The owner's prompt, as the agent echoes it: a `>` line on a lighter band. */
function UserMessage({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const style = useContext(AgentStyleContext);
  return (
    <View
      accessible
      accessibilityLabel={`You: ${entry.text}`}
      style={{
        backgroundColor: tokens.surface2,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginVertical: 6,
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
  const style = useContext(AgentStyleContext);
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityHint="Long press to copy this reply"
      onLongPress={() => {
        void Clipboard.setStringAsync(entry.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      style={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Line marker={style.reply} color={style.replyColor}>
        <Markdown text={entry.text} />
        <Shortened entry={entry} />
        {copied ? <Text style={small}>(reply copied)</Text> : null}
      </Line>
    </Pressable>
  );
}

function Output({ text: output, shortened }: { text: string; shortened: boolean }) {
  const lines = output.split("\n");
  const [all, setAll] = useState(lines.length <= OUTPUT_LINES);
  return (
    <Line marker="⎿" color={tokens.textFaint}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ ...muted, fontSize: 13, lineHeight: 19 }}>
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
  const style = useContext(AgentStyleContext);
  const [open, setOpen] = useState(false);
  const title = step.call?.text ?? step.result?.text ?? "";
  const details = step.call?.detail;
  const output = step.result?.detail;
  const more = !!(details || output);
  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole={more ? "button" : "text"}
        accessibilityState={more ? { expanded: open } : undefined}
        accessibilityLabel={`${title}${step.failed ? ", failed" : ""}${running ? ", running" : ""}`}
        disabled={!more}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 32, justifyContent: "center" }}
      >
        <Line marker={style.step} color={step.failed ? amber : running ? tokens.textFaint : green}>
          <Text numberOfLines={open ? undefined : 1} style={text}>
            {title}
            {step.failed ? <Text style={{ color: amber }}> (failed)</Text> : null}
          </Text>
        </Line>
      </Pressable>
      {open ? (
        <View style={{ gap: 4, paddingLeft: GUTTER }}>
          {details ? <Output text={details} shortened={!!step.call?.truncated} /> : null}
          {output ? <Output text={output} shortened={!!step.result?.truncated} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Work({ row, live }: { row: Extract<ConversationRow, { kind: "work" }>; live: boolean }) {
  const style = useContext(AgentStyleContext);
  const [open, setOpen] = useState(false);
  const latest = row.steps.at(-1)!;
  // Only the newest step of a working agent is running; an older unanswered call was cut short.
  const running = live && stepWaiting(latest);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 2, gap: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${row.title}${row.failed ? `, ${row.failed} failed` : ""}`}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 40, justifyContent: "center" }}
      >
        <Line
          marker={running ? style.working : open ? "▾" : "▸"}
          color={running ? style.workingColor : tokens.textMuted}
        >
          <Text numberOfLines={1} style={muted}>
            {running ? `${latest.call!.text}…` : row.title}
            {row.failed ? <Text style={{ color: amber }}> · {row.failed} failed</Text> : null}
          </Text>
        </Line>
      </Pressable>
      {open ? (
        <View style={{ gap: 2, paddingLeft: GUTTER }}>
          {row.steps.map((step) => (
            <Step key={step.key} step={step} running={running && step === latest} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Summary({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        disabled={!entry.detail}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 44, justifyContent: "center" }}
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
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      <Line marker="·" color={tokens.textFaint}>
        <Text style={small}>{entry.text}</Text>
      </Line>
    </View>
  );
}

export const Row = memo(function Row({ row, live }: { row: ConversationRow; live: boolean }) {
  if (row.kind === "user") return <UserMessage entry={row.entry} />;
  if (row.kind === "assistant") return <AgentReply entry={row.entry} />;
  if (row.kind === "work") return <Work row={row} live={live} />;
  if (row.kind === "summary") return <Summary entry={row.entry} />;
  return <Notice entry={row.entry} />;
});
