import type { ConversationWireEntry } from "@shellbell/protocol";
import { memo, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { MobileConversationSnapshot } from "../net/mobile-conversation";
import { tokens } from "../theme/tokens";

const labels: Record<ConversationWireEntry["kind"], string> = {
  user: "You",
  assistant: "Assistant",
  "tool-call": "Tool",
  "tool-result": "Tool result",
  status: "Status",
  group: "Related work",
  unsupported: "Unsupported record",
};

const Entry = memo(function Entry({ entry }: { entry: Readonly<ConversationWireEntry> }) {
  // The source supplies the initial hint; subsequent patches preserve the person's choice.
  const [expanded, setExpanded] = useState(
    !(entry.collapsed ?? ["tool-call", "tool-result", "group"].includes(entry.kind)),
  );
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}>
      <Text style={{ color: tokens.textMuted, fontSize: 12, fontWeight: "600" }}>
        {labels[entry.kind]}
      </Text>
      <Text selectable style={{ color: tokens.text, fontSize: 16, lineHeight: 24 }}>
        {entry.text}
      </Text>
      {entry.detail ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={expanded ? "Hide details" : "Show details"}
            onPress={() => setExpanded((value) => !value)}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: tokens.textMuted }}>
              {expanded ? "Hide details" : "Show details"}
            </Text>
          </Pressable>
          {expanded ? (
            <Text selectable style={{ color: tokens.textMuted, fontSize: 14, lineHeight: 21 }}>
              {entry.detail}
            </Text>
          ) : null}
        </>
      ) : null}
      {entry.truncated ? (
        <Text style={{ color: tokens.textMuted, fontSize: 12 }}>This entry was shortened.</Text>
      ) : null}
    </View>
  );
});
const renderEntry = ({ item }: { item: Readonly<ConversationWireEntry> }) => <Entry entry={item} />;

export function conversationUnavailable(
  snapshot: Readonly<MobileConversationSnapshot>,
): string | null {
  if (snapshot.state === "disabled") return "Conversation is off on your computer.";
  if (snapshot.state === "checking") return "Checking which conversation this is…";
  if (snapshot.state !== "unavailable") return null;
  if (snapshot.reason === "unbound") return "Can’t tell which conversation this is.";
  if (snapshot.reason === "unsupported")
    return "This agent’s conversation format isn’t supported yet.";
  if (snapshot.reason === "busy") return "Conversation is waiting for the computer to catch up.";
  return "Conversation isn’t available right now.";
}

/** Plain, memory-only records. Inverted rows keep the latest reply at the bottom;
 * loading older rows preserves the visible row instead of jumping to the oldest. */
export function ConversationView({
  snapshot,
  onLoadOlder,
}: {
  snapshot: Readonly<MobileConversationSnapshot>;
  onLoadOlder: () => void;
}) {
  const list = useRef<FlatList<Readonly<ConversationWireEntry>>>(null);
  const [away, setAway] = useState(false);
  const entries = useMemo(() => [...snapshot.entries].reverse(), [snapshot.entries]);
  const olderText =
    snapshot.historyStatus === "loading"
      ? "Loading earlier messages…"
      : snapshot.historyStatus === "limit" || snapshot.notice === "evicted"
        ? "Earlier messages were removed to keep this view within its memory limit."
        : snapshot.historyStatus === "unavailable"
          ? "Earlier messages aren’t available right now."
          : snapshot.history === "complete"
            ? "Beginning of this conversation"
            : snapshot.history === "unlinked"
              ? "Some earlier messages could not be linked to this conversation."
              : snapshot.history === "truncated"
                ? "Some earlier messages could not be shown."
                : "Earlier messages haven’t been loaded.";
  return (
    <View testID="conversation-view" style={{ flex: 1, backgroundColor: tokens.bg }}>
      {snapshot.notice === "skipped" ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.textMuted, padding: 12 }}>
          Conversation skipped while catching up. Showing recent messages.
        </Text>
      ) : null}
      {snapshot.caughtUp === false ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: tokens.textMuted, paddingHorizontal: 16, paddingVertical: 4 }}
        >
          Catching up…
        </Text>
      ) : null}
      <FlatList
        ref={list}
        data={entries}
        inverted
        keyExtractor={(entry) => entry.id}
        renderItem={renderEntry}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.3}
        onEndReached={() => {
          if (snapshot.canRequestOlder && snapshot.historyStatus === "idle") onLoadOlder();
        }}
        onScroll={(event) => setAway(event.nativeEvent.contentOffset.y > 160)}
        scrollEventThrottle={100}
        ListEmptyComponent={
          <Text style={{ color: tokens.textMuted, padding: 16 }}>
            Waiting for conversation messages…
          </Text>
        }
        ListFooterComponent={
          snapshot.entries.length > 0 ? (
            <View style={{ padding: 16, alignItems: "center" }}>
              <Text style={{ color: tokens.textMuted, fontSize: 12, textAlign: "center" }}>
                {olderText}
              </Text>
              {snapshot.canRequestOlder ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load earlier messages"
                  onPress={onLoadOlder}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text style={{ color: tokens.text }}>Load earlier messages</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null
        }
      />
      {away ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go to latest message"
          onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
          style={{
            position: "absolute",
            bottom: 12,
            alignSelf: "center",
            backgroundColor: tokens.surface2,
            borderRadius: 20,
            minHeight: 44,
            paddingHorizontal: 16,
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.text }}>Latest message ↓</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
