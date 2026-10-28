import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { agentStyle } from "../agents/registry";
import { useScreenReader } from "../input/useScreenReader";
import type { MobileConversationSnapshot } from "../net/mobile-conversation";
import { useUiStore } from "../store/computers";
import { tokens } from "../theme/tokens";
import {
  AgentStyleContext,
  ConversationTypeContext,
  conversationType,
  Row,
  ScreenReaderContext,
} from "./ConversationRows";
import { type ConversationRow, conversationRows } from "./conversation-rows";

/** How to let the computer tell which Codex session a terminal shows. */
export const CODEX_INTEGRATION_HINT =
  "For full history, set up Codex on your computer in Shellbell’s Settings, or run “shellbell agents setup”. Then restart Codex.";

export function conversationUnavailable(
  snapshot: Readonly<MobileConversationSnapshot>,
  agent?: string,
): string | null {
  if (snapshot.state === "disabled") return "Full history is off on your computer.";
  if (snapshot.state === "checking") return "Checking which session this is…";
  if (snapshot.state !== "unavailable") return null;
  // Codex needs Shellbell's hook on the computer; choosing Conversation says how to add it.
  if (snapshot.reason === "unbound" && agent === "codex")
    return "Can’t show this Codex session’s full history yet.";
  if (snapshot.reason === "unbound") return "Can’t show this session’s full history.";
  if (snapshot.reason === "unsupported") return "Full history for this agent is coming soon.";
  if (snapshot.reason === "busy") return "Chat is waiting for the computer to catch up.";
  return "Chat isn’t available right now.";
}

/** Plain, memory-only records. Inverted rows keep the latest reply at the bottom;
 * loading older rows preserves the visible row instead of jumping to the oldest. */
export function ConversationView({
  snapshot,
  onLoadOlder,
  working = false,
  agent,
}: {
  snapshot: Readonly<MobileConversationSnapshot>;
  onLoadOlder: () => void;
  /** The agent is running, so the newest unanswered step shows as running. */
  working?: boolean;
  /** The agent's kind, such as `claude`, so markers and colours match its own screen. */
  agent?: string;
}) {
  const list = useRef<FlatList<ConversationRow>>(null);
  // The same font size as Terminal, so switching views keeps the text where it was.
  const fontSize = useUiStore((s) => s.fontSize);
  const type = useMemo(() => conversationType(fontSize), [fontSize]);
  const screenReader = useScreenReader();
  const chrome = type.small;
  const [away, setAway] = useState(false);
  const [nearTop, setNearTop] = useState(false);
  // Sizes for deciding whether the oldest row is near the screen, including before any scroll.
  const size = useRef({ offset: 0, content: 0, layout: 0 });
  const measure = (next: Partial<typeof size.current>) => {
    Object.assign(size.current, next);
    const { offset, content, layout } = size.current;
    if (layout) setNearTop(content - layout - offset < 600);
  };
  const rows = useMemo(() => conversationRows(snapshot.entries).reverse(), [snapshot.entries]);
  const canLoad = snapshot.canRequestOlder && snapshot.historyStatus === "idle";
  // The list only reports reaching the top once per content size. A cursor that arrives
  // later, or a finished page that leaves the owner at the top, must still load the next one.
  useEffect(() => {
    if (nearTop && canLoad) onLoadOlder();
  }, [nearTop, canLoad, onLoadOlder]);
  const olderText =
    snapshot.historyStatus === "loading"
      ? "Loading earlier messages…"
      : snapshot.historyStatus === "limit" || snapshot.notice === "evicted"
        ? "Earlier messages were removed to keep this view within its memory limit."
        : snapshot.historyStatus === "unavailable"
          ? "Earlier messages aren’t available right now."
          : snapshot.history === "complete"
            ? "Beginning of this session"
            : snapshot.history === "unlinked"
              ? "Some earlier messages couldn’t be linked to this session."
              : snapshot.history === "truncated"
                ? "Some earlier messages could not be shown."
                : "Earlier messages haven’t been loaded.";
  return (
    <ConversationTypeContext.Provider value={type}>
      <AgentStyleContext.Provider value={agentStyle(agent)}>
        <ScreenReaderContext.Provider value={screenReader}>
          <View testID="conversation-view" style={{ flex: 1, backgroundColor: tokens.bg }}>
            {snapshot.notice === "skipped" ? (
              <Text accessibilityLiveRegion="polite" style={{ ...chrome, padding: 12 }}>
                Some messages were skipped while catching up. Showing recent ones.
              </Text>
            ) : null}
            {snapshot.caughtUp === false ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{ ...chrome, paddingHorizontal: 12, paddingVertical: 4 }}
              >
                Catching up…
              </Text>
            ) : null}
            <FlatList
              ref={list}
              data={rows}
              inverted
              keyExtractor={(row) => row.key}
              renderItem={({ item, index }) => <Row row={item} live={working && index === 0} />}
              maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 80,
              }}
              keyboardShouldPersistTaps="handled"
              onEndReachedThreshold={0.3}
              onEndReached={() => {
                if (canLoad) onLoadOlder();
              }}
              onScroll={(event) => {
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                setAway(contentOffset.y > 160);
                measure({
                  offset: contentOffset.y,
                  content: contentSize.height,
                  layout: layoutMeasurement.height,
                });
              }}
              onContentSizeChange={(_width, height) => measure({ content: height })}
              onLayout={(event) => measure({ layout: event.nativeEvent.layout.height })}
              scrollEventThrottle={100}
              ListEmptyComponent={
                <Text style={{ ...chrome, padding: 16 }}>
                  {snapshot.state === "checking" ? "Opening the chat…" : "Waiting for messages…"}
                </Text>
              }
              ListFooterComponent={
                snapshot.entries.length > 0 ? (
                  <View style={{ padding: 16, alignItems: "center" }}>
                    <Text style={{ ...chrome, textAlign: "center" }}>{olderText}</Text>
                    {snapshot.canRequestOlder ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Load earlier messages"
                        onPress={onLoadOlder}
                        style={{ minHeight: 44, justifyContent: "center" }}
                      >
                        <Text style={{ ...chrome, color: tokens.text }}>
                          [load earlier messages]
                        </Text>
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
                <Text style={{ ...chrome, color: tokens.text }}>latest ↓</Text>
              </Pressable>
            ) : null}
          </View>
        </ScreenReaderContext.Provider>
      </AgentStyleContext.Provider>
    </ConversationTypeContext.Provider>
  );
}
