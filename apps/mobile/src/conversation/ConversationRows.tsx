import type { ConversationWireEntry } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { memo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";
import type { ConversationRow, ConversationStep } from "./conversation-rows";
import { type MarkdownInline, markdownBlocks } from "./markdown";

const CODE_LINES = 30;
const OUTPUT_LINES = 40;
const body = { color: tokens.text, fontSize: 16, lineHeight: 24 } as const;
const mono = { fontFamily: FONT.regular, fontSize: 13, lineHeight: 19 } as const;

function openLink(url: string) {
  // Show the address first; nothing an agent writes opens without the owner choosing it.
  Alert.alert("Open link?", url, [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => void Linking.openURL(url).catch(() => {}) },
  ]);
}

function Inline({ parts }: { parts: readonly MarkdownInline[] }) {
  return parts.map((part, index) => {
    const key = `${index}`;
    if (part.kind === "code")
      return (
        <Text key={key} style={{ ...mono, fontSize: 14, backgroundColor: tokens.surface2 }}>
          {part.text}
        </Text>
      );
    if (part.kind === "bold")
      return (
        <Text key={key} style={{ fontWeight: "700" }}>
          {part.text}
        </Text>
      );
    if (part.kind === "italic")
      return (
        <Text key={key} style={{ fontStyle: "italic" }}>
          {part.text}
        </Text>
      );
    if (part.kind === "link")
      return (
        <Text
          key={key}
          accessibilityRole="link"
          onPress={() => openLink(part.url)}
          style={{ color: tokens.accents.blue, textDecorationLine: "underline" }}
        >
          {part.text}
        </Text>
      );
    return part.text;
  });
}

function CodeBlock({ text, open }: { text: string; open: boolean }) {
  const lines = text.split("\n");
  const [all, setAll] = useState(lines.length <= CODE_LINES);
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        backgroundColor: tokens.surface,
        borderRadius: tokens.radius.sm,
        borderWidth: 1,
        borderColor: tokens.border,
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ ...mono, color: tokens.text, padding: 12 }}>
          {all ? text : lines.slice(0, CODE_LINES).join("\n")}
        </Text>
      </ScrollView>
      <View
        style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingHorizontal: 4 }}
      >
        {all ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setAll(true)}
            style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
          >
            <Text style={{ color: tokens.textMuted }}>Show all {lines.length} lines</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          onPress={() => {
            void Clipboard.setStringAsync(text).then(() => setCopied(true));
          }}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
        >
          <Text style={{ color: tokens.textMuted }}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      {open ? (
        <Text
          style={{ color: tokens.textMuted, fontSize: 12, paddingHorizontal: 12, paddingBottom: 8 }}
        >
          This code block hasn't finished yet.
        </Text>
      ) : null}
    </View>
  );
}

/** Rendered Markdown for agent replies; plain text is a paragraph like any other. */
export function Markdown({ text }: { text: string }) {
  return (
    <View style={{ gap: 10 }}>
      {markdownBlocks(text).map((block, index) => {
        const key = `${index}`;
        if (block.kind === "code")
          return <CodeBlock key={key} text={block.text} open={block.open} />;
        if (block.kind === "heading")
          return (
            <Text
              key={key}
              accessibilityRole="header"
              selectable
              style={{ ...body, fontWeight: "700", fontSize: block.level <= 2 ? 19 : 17 }}
            >
              <Inline parts={block.inline} />
            </Text>
          );
        if (block.kind === "quote")
          return (
            <View
              key={key}
              style={{ borderLeftWidth: 3, borderLeftColor: tokens.border, paddingLeft: 12 }}
            >
              <Text selectable style={{ ...body, color: tokens.textMuted }}>
                <Inline parts={block.inline} />
              </Text>
            </View>
          );
        if (block.kind === "list")
          return (
            <View key={key} style={{ gap: 4 }}>
              {block.items.map((item) => (
                <View
                  key={item.key}
                  style={{ flexDirection: "row", gap: 8, paddingLeft: item.depth * 16 }}
                >
                  <Text style={{ ...body, color: tokens.textMuted, minWidth: 14 }}>
                    {item.marker}
                  </Text>
                  <Text selectable style={{ ...body, flex: 1 }}>
                    <Inline parts={item.inline} />
                  </Text>
                </View>
              ))}
            </View>
          );
        return (
          <Text key={key} selectable style={body}>
            <Inline parts={block.inline} />
          </Text>
        );
      })}
    </View>
  );
}

function Shortened({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  return entry.truncated ? (
    <Text style={{ color: tokens.textMuted, fontSize: 12 }}>This message was shortened.</Text>
  ) : null;
}

function UserMessage({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8, alignItems: "flex-end" }}>
      <View
        accessible
        accessibilityLabel={`You: ${entry.text}`}
        style={{
          maxWidth: "85%",
          backgroundColor: tokens.surface2,
          borderRadius: tokens.radius.lg,
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        <Text selectable style={body}>
          {entry.text}
        </Text>
      </View>
      <Shortened entry={entry} />
    </View>
  );
}

function AgentReply({ entry }: { entry: Readonly<ConversationWireEntry> }) {
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
      style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}
    >
      <Markdown text={entry.text} />
      <Shortened entry={entry} />
      {copied ? <Text style={{ color: tokens.textMuted, fontSize: 12 }}>Reply copied</Text> : null}
    </Pressable>
  );
}

function Output({ text, shortened }: { text: string; shortened: boolean }) {
  const lines = text.split("\n");
  const [all, setAll] = useState(lines.length <= OUTPUT_LINES);
  return (
    <View
      style={{
        backgroundColor: tokens.surface,
        borderRadius: tokens.radius.sm,
        padding: 10,
        gap: 4,
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ ...mono, color: tokens.textMuted }}>
          {all ? text : lines.slice(-OUTPUT_LINES).join("\n")}
        </Text>
      </ScrollView>
      {all ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setAll(true)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.textMuted }}>Show all {lines.length} lines</Text>
        </Pressable>
      )}
      {shortened ? (
        <Text style={{ color: tokens.textMuted, fontSize: 12 }}>
          Output shortened on your computer.
        </Text>
      ) : null}
    </View>
  );
}

function Step({ step }: { step: ConversationStep }) {
  const [open, setOpen] = useState(false);
  const title = step.call?.text ?? step.result?.text ?? "";
  const details = step.call?.detail;
  const output = step.result?.detail;
  const more = !!(details || output);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole={more ? "button" : "text"}
        accessibilityState={more ? { expanded: open } : undefined}
        accessibilityLabel={`${title}${step.failed ? ", failed" : ""}${step.call && !step.result ? ", running" : ""}`}
        disabled={!more}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 36, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Text style={{ color: tokens.textFaint, width: 12 }}>
          {more ? (open ? "▾" : "▸") : "·"}
        </Text>
        <Text
          numberOfLines={open ? undefined : 1}
          style={{ ...mono, color: tokens.textMuted, flex: 1 }}
        >
          {title}
        </Text>
        {step.failed ? (
          <Text style={{ color: tokens.accents.amber, fontSize: 12 }}>failed</Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ gap: 6, paddingLeft: 20 }}>
          {details ? <Output text={details} shortened={!!step.call?.truncated} /> : null}
          {output ? <Output text={output} shortened={!!step.result?.truncated} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Work({ row, live }: { row: Extract<ConversationRow, { kind: "work" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = row.steps.at(-1)!;
  const running = live && !!latest.call && !latest.result;
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 4, gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${row.title}${row.failed ? `, ${row.failed} failed` : ""}`}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        {running ? (
          <ActivityIndicator size="small" color={tokens.textMuted} />
        ) : (
          <Text style={{ color: tokens.textMuted, width: 12 }}>{open ? "▾" : "▸"}</Text>
        )}
        <Text numberOfLines={1} style={{ color: tokens.textMuted, fontSize: 14, flexShrink: 1 }}>
          {running ? `Running · ${latest.call!.text}` : row.title}
        </Text>
        {row.failed ? (
          <Text style={{ color: tokens.accents.amber, fontSize: 14 }}>· {row.failed} failed</Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ gap: 2, paddingLeft: 4 }}>
          {row.steps.map((step) => (
            <Step key={step.key} step={step} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Summary({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        disabled={!entry.detail}
        onPress={() => setOpen((value) => !value)}
        style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
        <Text style={{ color: tokens.textMuted, fontSize: 12 }}>
          Earlier conversation was summarized
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: tokens.border }} />
      </Pressable>
      {open && entry.detail ? <Markdown text={entry.detail} /> : null}
    </View>
  );
}

function Notice({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  return (
    <Text
      style={{
        color: tokens.textMuted,
        fontSize: 12,
        textAlign: "center",
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
    >
      {entry.text}
    </Text>
  );
}

export const Row = memo(function Row({ row, live }: { row: ConversationRow; live: boolean }) {
  if (row.kind === "user") return <UserMessage entry={row.entry} />;
  if (row.kind === "assistant") return <AgentReply entry={row.entry} />;
  if (row.kind === "work") return <Work row={row} live={live} />;
  if (row.kind === "summary") return <Summary entry={row.entry} />;
  return <Notice entry={row.entry} />;
});
